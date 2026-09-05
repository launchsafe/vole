# Data sources

Reference for what each AI coding tool writes to disk, what it means, and where it lies to you.

This is the knowledge that took the most work to establish, and it is the part most likely to
break as tools ship new versions. If you are adding a tool or debugging a wrong number, start here.

**Rule of the project:** never invent a number. If a tool does not record something, the field
stays `NULL` and the UI says so. See [confidence levels](#confidence-levels) at the end.

---

## Claude Code — exact

**Location:** `~/.claude/projects/<url-encoded-project-path>/<session-uuid>.jsonl`

The directory name is the project's absolute path with `/` replaced by `-`, e.g.
`/Users/you/projects/app` becomes `-Users-you-projects-app`. One JSONL file per session.

Each line is a JSON object. Many `type` values appear (`queue-operation`, `user`, `assistant`,
attachments, hook results). **Only `type: "assistant"` entries with `message.usage` carry token
data.**

### A real entry

```jsonc
{
  "type": "assistant",
  "timestamp": "2026-07-26T03:20:02.352Z",
  "sessionId": "3a5594ab-855c-470b-bf02-89f1758c2e04",
  "requestId": "req_011CdPwwPinvfWd5hiApdpmS",
  "cwd": "/Users/you/projects/app",
  "gitBranch": "HEAD",
  "version": "2.1.220",
  "message": {
    "id": "msg_011CdPwwR3fUBkqb4r9ExxLG",   // ← the dedup key
    "model": "claude-sonnet-5",
    "stop_reason": "end_turn",
    "usage": {
      "input_tokens": 2,
      "cache_creation_input_tokens": 280,
      "cache_read_input_tokens": 368480,
      "output_tokens": 32,
      "cache_creation": {                    // ← split by TTL; this is what makes cost exact
        "ephemeral_5m_input_tokens": 0,
        "ephemeral_1h_input_tokens": 280
      },
      "output_tokens_details": { "thinking_tokens": 0 },
      "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
      "service_tier": "standard",
      "iterations": [ /* per-iteration breakdown; usually one entry */ ]
    }
  }
}
```

### Field meanings

| Field | Meaning |
|---|---|
| `message.id` | Stable API response id. **The dedup key.** |
| `input_tokens` | Fresh (uncached) input. Often tiny — most input is cached. |
| `cache_read_input_tokens` | Input served from cache, billed at 0.1×. Usually the largest number. |
| `cache_creation.ephemeral_5m_input_tokens` | Cache written with 5-minute TTL, billed at 1.25×. |
| `cache_creation.ephemeral_1h_input_tokens` | Cache written with 1-hour TTL, billed at 2×. |
| `cache_creation_input_tokens` | Total of both TTLs. Present on older entries that lack the split. |
| `output_tokens` | Generated tokens. |
| `output_tokens_details.thinking_tokens` | Reasoning tokens (subset of output). |
| `stop_reason` | `tool_use` dominates in agentic sessions; `end_turn` ends a turn. |
| `isApiErrorMessage` | Top-level (not under `message`). Marks an API error. |

### ⚠️ The duplication trap

**Claude Code writes the same API response to the transcript more than once.**

Measured on real logs: **861 raw usage rows → 408 unique `message.id`**. Duplicates carry
byte-identical usage, with different `uuid` and timestamps milliseconds apart.

Summing rows naively inflates every number by roughly **2.1×**.

```bash
# See it yourself
cat ~/.claude/projects/*/*.jsonl | jq -r 'select(.message.usage!=null) | "x"' | wc -l   # raw
cat ~/.claude/projects/*/*.jsonl | jq -r 'select(.message.usage!=null) | .message.id' \
  | sort -u | wc -l                                                                     # unique
```

The collector keys events on `claude_code:<message.id>` under a `UNIQUE` constraint. `pnpm verify`
reports the live duplication factor so a regression here is loud.

### Other gotchas

- **`model` can be `"<synthetic>"`** — a real entry type for messages with no billed API call.
  It must produce no cost, not `$0` computed from a missing rate.
- **The last line may be partial** while a session is live. The reader deliberately leaves an
  incomplete trailing line unconsumed and re-reads it next poll.
- **Older entries lack `cache_creation`** and only have the flat total. The collector attributes
  those to the 5-minute bucket, since that is the default TTL.

---

## Codex CLI — exact tokens, unknown cost

**Location:** `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`

Not `~/.codex/projects/`. Codex also keeps SQLite databases in `~/.codex/` (`logs_2.sqlite`,
`state_5.sqlite`) — `state_5.sqlite` has a `threads` table with a `tokens_used` column that is
useful as a cross-check, but the rollout JSONL is the authoritative per-turn source.

### Line types

| `type` | Contains |
|---|---|
| `session_meta` | Session id, cwd. **`model` is `null` here** — do not read it. |
| `turn_context` | `model`, `effort`, sandbox policy. **This is where the model name lives.** |
| `event_msg` | Wraps `payload.type` values including `token_count`, `agent_message`. |
| `response_item` | Model output items. |

### A real `token_count` payload

```jsonc
{
  "type": "token_count",
  "info": {
    "total_token_usage": {          // ← CUMULATIVE for the session
      "input_tokens": 79595,
      "cached_input_tokens": 58240,
      "output_tokens": 1380,
      "reasoning_output_tokens": 448,
      "total_tokens": 80975
    },
    "last_token_usage": {           // ← this turn only
      "input_tokens": 10223,
      "cached_input_tokens": 9984,
      "output_tokens": 145,
      "reasoning_output_tokens": 64,
      "total_tokens": 10368
    },
    "model_context_window": 258400
  },
  "rate_limits": {
    "primary":   { "used_percent": 1.0, "window_minutes": 300,   "resets_at": 1764406328 },
    "secondary": { "used_percent": 0.0, "window_minutes": 10080, "resets_at": 1764993128 },
    "credits":   { "has_credits": false, "unlimited": false, "balance": "0" }
  }
}
```

### ⚠️ Two traps

**1. Do not sum `total_token_usage`.** It is cumulative. Summing it across events produces a number
that grows quadratically with turn count.

**2. Do not blindly sum `last_token_usage` either.** Codex sometimes emits the *same* `token_count`
event twice — two identical events appear at session start in real logs.

The collector uses the **delta of the cumulative counter**, which is immune to both:

```
usage = total_token_usage(now) − total_token_usage(previous)
```

A duplicate emission produces a delta of zero and is skipped. Correctness of this approach is
provable: per-session sums reconstruct each session's final cumulative counter exactly.

Because deltas need a known starting point, Codex rollouts are **re-read in full** each poll rather
than resumed from a byte offset. The files are few and small, and `INSERT OR IGNORE` makes the
re-read free.

### Cached input is nested, not separate

`input_tokens` **includes** `cached_input_tokens`. The collector separates them so the cache maths
holds:

```ts
const freshInput = Math.max(0, input - cached);
```

### Cost is unavailable

Tokens are exact, but no published per-token rate for `gpt-5.1-codex-max` is loaded, so `cost_usd`
stays `NULL` and renders as `—`. **Exact tokens do not imply known cost.** To add a rate, see
[EXTENDING.md → Adding a model rate](EXTENDING.md#adding-a-model-rate).

### Bonus signal

Codex is the only tool that reports **its own remaining quota** (`rate_limits.primary.used_percent`).
That powers the `rate_limit_pressure` rule, which has no equivalent for the other tools.

---

## Cursor — no token data exists locally

**Location:** `~/.cursor/ai-tracking/ai-code-tracking.db` (SQLite)

### What is actually in it

```sql
CREATE TABLE ai_code_hashes (
  hash TEXT PRIMARY KEY,
  source TEXT NOT NULL,       -- e.g. 'composer'
  fileExtension TEXT,
  fileName TEXT,
  requestId TEXT,
  conversationId TEXT,
  timestamp INTEGER,
  model TEXT,                 -- e.g. 'composer-2-fast'
  createdAt INTEGER NOT NULL
);
-- also: scored_commits, conversation_summaries, tracked_file_content, tracking_state
```

**There are no token columns anywhere in this database.** It exists to power Cursor's
"% AI-written code" feature by hashing generated code, not to account for usage.

`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` was also checked: it is large
(400MB+) but its `ItemTable` holds no usage or token keys.

Verify for yourself:

```bash
sqlite3 ~/.cursor/ai-tracking/ai-code-tracking.db ".schema" | grep -i token   # → nothing
```

### What the collector does

Emits **one row per `requestId`** (a model call), not per code hash — 715 hashes on the development
machine corresponded to only 8 actual requests. All token fields are `NULL` and confidence is
`activity_only`.

> **Estimating tokens from lines of code was considered and rejected.** It would be a fabricated
> number wearing an "estimated" badge. Cursor's real accounting lives server-side behind its
> account, and this project does not automate web UIs.

The DB is opened **read-only** because Cursor may be running and holding the file.

---

## Antigravity — activity only

**Locations:**
- `~/.gemini/antigravity-ide/conversations/<uuid>.pb` — **encrypted**
- `~/.gemini/antigravity-ide/brain/<uuid>/` — plaintext artifacts

### Why there is no token count

Two hard constraints:

1. Antigravity is a **flat-rate subscription** product and exposes no client-readable per-token
   usage anywhere on disk.
2. Conversation payloads are **encrypted**. Byte inspection shows high-entropy data with no
   protobuf wire format:

   ```
   $ head -c 32 ~/.gemini/antigravity-ide/conversations/<uuid>.pb | xxd
   00000000: eb74 86cc 6a47 0091 e908 6e6d 6f90 fef3
   ```

   A protobuf stream starts with a field tag byte; `0xeb` is not a plausible one, and `file(1)`
   reports generic `data`.

### What is readable

`brain/<conversation-id>/` contains plaintext artifacts the agent wrote — implementation plans,
task files, and numbered `.resolved.N` revisions. Their **count is a turn-count proxy**, nothing
more.

```
brain/937423ff-.../
  implementation_plan.md
  implementation_plan.md.metadata.json
  implementation_plan.md.resolved.0
  implementation_plan.md.resolved.1
  ...
```

That proxy is **not** turned into a token number. Multiplying it by a guessed constant was
considered and rejected — it would be a fabricated figure wearing a badge. Vole emits one
`activity_only` row per conversation, with `NULL` token fields, so Antigravity shows up as real
activity in the call count and nowhere in the token or cost totals.

**Timing is approximate** — file mtimes, not real timestamps — so Antigravity events cluster rather
than spreading across a session.

---

## Confidence levels

Two, by policy. A token count is measured or it is absent; there is no derived tier.

| Level | Meaning | Token fields | In aggregates? |
|---|---|---|---|
| `exact` | Read verbatim from the tool's logs (a plain sum, or a delta of the tool's own counter) | Real numbers | Yes |
| `activity_only` | Call happened; tool records no tokens (Cursor, Antigravity) | **`NULL`** | **No** (still counted as a call) |

`activity_only` covers the tools that record real sessions and models but no token counts —
Cursor and Antigravity. Deriving a number for them from lines of code or turn counts was
considered and rejected: it would be a fabricated figure, exactly what this project refuses to
produce.

`NULL` rather than `0` matters: an absence must never be mistaken for a measurement of zero.

---

## Investigating a new tool

The method that produced everything above:

```bash
# 1. Find where it stores state
ls -la ~/.<tool> ~/.config/<tool> "~/Library/Application Support/<Tool>" 2>/dev/null

# 2. Find the biggest / most recent files — usage logs are usually both
du -sh ~/.<tool>/* | sort -h | tail

# 3. If JSONL: what line types exist, and do any mention tokens?
cat <file>.jsonl | jq -r '.type // "none"' | sort | uniq -c
grep -c token <file>.jsonl

# 4. If SQLite: does the schema even have token columns?
sqlite3 <file>.db ".schema" | grep -i token

# 5. If binary: is it parseable or encrypted?
file <file>; head -c 64 <file> | xxd
```

Then ask the one question that decides the confidence level:

1. Are there **real token counts** in the source? → `exact` (sum the real fields, or delta a
   cumulative counter — never a proxy times a constant)
2. Calls are recorded but no token data exists? → `activity_only`, `NULL` tokens

If the answer is "I could guess", the answer is `activity_only`. Guessing is the one thing this
project does not do.

Next: [EXTENDING.md → Adding a collector](EXTENDING.md#adding-a-collector).

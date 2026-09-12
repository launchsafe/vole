# System overview

A single, self-contained explanation of what Vole is, how it works end to end, and what
it is built from. Written to be read start to finish by someone who has never seen the
codebase. Every figure here was measured on a real machine, not estimated.

---

## 1. What the product is

Developers now run several AI coding agents side by side — Claude Code in one terminal,
Codex in another, Cursor in the editor. Each burns tokens independently, and none of
them tells you when one has gone *wrong*: stuck in a tool loop, retrying against a
broken API, or re-reading the same 200K-token context forty times.

Vole reads the log files those tools already write to disk, normalises them into one
schema, and surfaces two things:

- **Incidents** — a runaway agent, a token-burn spike, a retry storm, context pressure.
- **Spend** — what that usage would have cost at list price.

The ordering matters, and it is the product's whole position. Existing tools answer
*"how much did I spend?"*. Vole answers *"is anything going wrong right now?"*, and
shows spend as a side effect. **It is a monitor, not an accountant.**

Everything runs locally. There is no server, no account, and no scraping of any
vendor's web UI. The collector has no network code at all.

---

## 2. Shape of the system

Two processes and one file. That is the entire architecture.

```
  ┌──────────────────────────────────────────────────────────────────┐
  │  LOGS ALREADY ON DISK (written by other vendors' tools)           │
  │  ~/.claude/projects/**/*.jsonl        ~/.codex/sessions/**        │
  │  Cursor state.vscdb   OpenCode DB   Grok jsonl   Devin   Antigrav │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │  read-only, never modified
                                  ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  COLLECTOR  (Node / TypeScript, ~7,500 lines, zero runtime deps)  │
  │  parse → normalise → price → dedup → detect                       │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │  writes
                                  ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  ~/.vole/vole.db        SQLite, WAL mode, versioned migrations    │
  └───────┬──────────────────────────┬───────────────────┬───────────┘
          │ read-only                │                   │
          ▼                          ▼                   ▼
   macOS app (SwiftUI)         CLIs (top, digest,     MCP server
   menu bar + dashboard        pr, statusline)        (agents query
                                                       their own spend)
```

The collector is the only writer. Everything else opens the database read-only, so a
reader can never corrupt what the collector is building.

---

## 3. Languages, frameworks and tools

### Languages

| Language | Where | Why |
|---|---|---|
| **TypeScript** | Collector, rules, queries, CLIs, MCP server (~7,500 lines) | Runs anywhere Node runs, so the data layer is not tied to macOS |
| **Swift 6** | macOS app (~3,200 lines) | Native menu-bar behaviour and charts without shipping a browser |

### Runtimes and frameworks

| Thing | Version / detail | Role |
|---|---|---|
| **Node.js** | `>=22` required | Collector runtime |
| **`node:sqlite`** | Node standard library | Database driver. Chosen over `better-sqlite3` specifically to avoid a native build step — it is why the collector has **zero runtime dependencies** |
| **SwiftUI** | macOS 26 SDK | Entire app UI |
| **Swift Charts** | macOS 26 SDK | The incident-annotated timeline |
| **`MenuBarExtra`** | SwiftUI scene | Menu-bar presence with no Dock icon until a window opens |
| **SQLite3** | Ships with macOS | The app's own read-only database access, via the C API |
| **Swift Concurrency** | `actor`, `async/await` | `DB` is an actor so polling never blocks the UI thread |

### Build and development tooling

| Tool | Role |
|---|---|
| **pnpm 9** | Workspace/monorepo package manager (`packages/core`, `apps/mac`) |
| **TypeScript `tsc`** | Type checking only (`--noEmit`); nothing is transpiled to disk |
| **tsx** | Runs TypeScript directly, so the CLIs need no build step |
| **`node:test`** | Test runner — standard library, no Jest or Vitest |
| **esbuild** | Bundles the collector into one file for packaging |
| **postject** + Node SEA | Injects that bundle into a Node binary, producing a ~112 MB self-contained collector that runs with no Node installed |
| **Swift Package Manager** | Builds the macOS app (`swift build`) |
| **`codesign` / `notarytool`** | Developer ID signing and Apple notarisation for releases |
| **markdown-it + Chrome headless** | Builds this PDF (`pnpm docs:pdf`) |
| **GitHub Actions** | CI on `ubuntu-latest` (Node 22) and `macos-latest` |

### Deliberate non-dependencies

The collector depends on **nothing** at runtime. No HTTP client, no ORM, no SQLite
driver, no logging library. This is a security posture as much as a build choice: the
component that reads your AI transcripts is structurally incapable of transmitting
them, which is a stronger guarantee than a privacy policy.

---

## 4. How data flows, end to end

### 4.1 Collection

Each supported tool has a **collector** in `packages/core/src/collectors/`. A collector
takes the database handle, reads its source, and returns normalised `UsageEvent` rows.
It never writes to the store itself.

Sources are polled every 5 seconds by default. Collectors are incremental: they track a
byte offset, row id, or file mtime in `collector_state` so a poll re-reads only what is
new. Cursor's 434 MB store, for example, is skipped entirely when its mtime is unchanged.

### 4.2 Normalisation

Every source is flattened into one row shape, whatever the original format:

```
event_key   tool  model  session_id  project  ts
input_tokens  output_tokens  cache_write_5m  cache_write_1h  cache_read
reasoning_tokens  total_tokens  cost_usd
confidence  estimation_method  is_error  stop_reason  source  raw_ref
```

`event_key` is the idempotency contract. It is derived from the source's own identifier
(`claude_code:<messageId>`, `cursor:bubble:<composerId>:<bubbleId>`), so re-reading the
same log line can never create a second row — re-running the collector is always safe.

### 4.3 The deduplication trap

This is the single most important correctness detail in the product.

Claude Code writes **the same assistant message several times** as it streams. Early
copies carry `output_tokens: 0` and no `stop_reason`; the final copy carries the real
count. On the development machine the duplication factor is **2.15×** — naively summing
every record overstates usage by 115%.

Vole keys on the message id and keeps the **finalised** copy. Two consequences follow
that are easy to get backwards:

- Taking the *first* record undercounts output tokens.
- Summing *all* records more than doubles the total.

The upsert resolves this with `CASE WHEN excluded.total_tokens > usage_events.total_tokens`,
so a later, larger copy wins and a smaller one never erases a bigger one.

### 4.4 Pricing

Rates live in a data file (`packages/core/src/data/pricing.json`), not in code, so a new
model can be priced without a release. A per-installation override at
`~/.vole/pricing.json` is merged on top and validated — an impossible rate (negative,
non-numeric, infinite) is rejected and falls back to the built-in table.

Cost is computed exactly, not approximated, because Claude Code reports cache creation
already split by TTL:

```
cost = ( input      × rate.input
       + write_5m   × rate.input × 1.25
       + write_1h   × rate.input × 2.00
       + cache_read × rate.input × 0.10
       + output     × rate.output ) / 1_000_000
```

**An unknown model prices as `NULL`, never `$0`.** A zero would silently understate a
total; a null is visibly unknown and is excluded from sums.

### 4.5 Detection

Rules run over a trailing 120-day window after any pass that inserted rows. They are
pure functions of stored rows, so they are unit-testable without a database.

---

## 5. The confidence system

This is the product's central design commitment, and the thing it refuses to compromise.

| Tier | Meaning |
|---|---|
| **`exact`** | Read verbatim from the tool's own logs. `total_tokens` is a plain sum (or, for Codex, a delta of the tool's own cumulative counter). |
| **`estimated`** | The tool records no usable count, but a **deterministic, documented** method derives one. The method id is stored in `estimation_method`, and `pnpm verify` re-runs it against the stored inputs and fails on mismatch. |
| **`activity_only`** | The call demonstrably happened and the tool records nothing that could support even a falsifiable estimate. Tokens are `NULL` and the row is excluded from every token and cost aggregate. |

The rule that holds the whole thing together: **an estimate that cannot be re-derived
exactly from its stated method is a bug, not an estimate.** That is the entire
difference between the `estimated` tier and a guess, and it is why relaxing the original
"no estimates ever" policy was safe.

Preference order is always `exact` → `estimated` → `activity_only`. A row is left
`activity_only` rather than given an unfalsifiable number.

---

## 6. What each tool actually provides

Measured by direct inspection of each format, not from vendor documentation.

| Tool | Source on disk | Tokens | Cost |
|---|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | Exact, incl. subagents | Exact |
| **Codex CLI** | `~/.codex/sessions/**/rollout-*.jsonl` | Exact (delta of cumulative meter) | Unknown — no published rate |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | Exact | Exact (its own, per provider) |
| **Grok CLI** | `~/.grok/logs/unified.jsonl` | Exact | Unknown — no xAI rate loaded |
| **Cursor** | `…/Cursor/User/globalStorage/state.vscdb` | Exact to ~Mar 2026, then none | Unknown — no model recorded per message |
| **Devin** | `…/Devin/User/acp-messages/*.db` | None recorded | — |
| **Antigravity** | `~/.gemini/antigravity-ide/brain/<id>/` | None recorded | — |

### Why the hard cases are what they are

**Cursor is an archive, not a live feed.** Cursor keeps two unrelated local stores. The
attribution database (`ai-code-tracking.db`) has no token columns at all. The editor's
own `state.vscdb` does: one row per message carrying
`tokenCount: { inputTokens, outputTokens }` — 1,093 messages and 65,007,857 tokens on
the development machine. But measured month by month, every month from May 2025 to
March 2026 carries counts and **from April 2026 there are none** — 59 assistant turns
that April, more than March had, not one with a count. The field is still written, as a
zero. So Cursor legitimately spans two tiers: historical turns are `exact`, later ones
are `activity_only`.

**Antigravity payloads are encrypted.** Its `conversations/*.pb` files measure entropy
**8.00 of a possible 8.00**, and a protobuf wire-format walk decodes **zero** fields
before hitting an invalid tag. They are not parseable with any schema. The plaintext
artifacts under `brain/<id>/` prove a conversation happened, so one `activity_only` row
is emitted per conversation.

**Devin and Cursor's accounting is server-side.** Both run agents on their own
infrastructure and keep usage behind an account, which this project will not touch.

---

## 7. Storage

SQLite at `~/.vole/vole.db`, in WAL mode with `synchronous = NORMAL` and a 5-second
`busy_timeout`, because two writers are an explicitly supported configuration: the app
spawns its own embedded collector, and a developer may run `pnpm collect` beside it.

**Migrations** are a numbered, append-only list with a ledger table recording when each
ran. A store carries its schema number in `PRAGMA user_version`, and both the collector
and the app refuse to write a store written by a *newer* Vole — writing it would land
`NULL` in columns this build does not know about, which downstream is indistinguishable
from "the source did not record that field".

Two properties are worth calling out because both were bugs that had to be fixed:

- The version check and the migrations it decides on **must be in the same
  transaction**, or two collectors opening a fresh store both apply migration 1 and the
  loser dies on a unique-constraint violation.
- `PRAGMA journal_mode = WAL` takes an exclusive lock and does **not** run SQLite's busy
  handler, so `busy_timeout` does not cover it. Concurrent openers must retry it.

---

## 8. The detection engine

Five rules, in `packages/core/src/detect/`.

| Rule | Fires when |
|---|---|
| `billable_burn_spike` | A 10-minute window costs far more than that session's own normal |
| `repeat_call_loop` | High call volume with flat output and climbing cache reads — re-processing the same context |
| `error_storm` | A sustained failure ratio across many calls |
| `rate_limit_pressure` | Remaining quota crosses a threshold (Codex is the only source exposing this) |
| `context_pressure` | A call carries more than 80% of a *known* model window |

### How the burn rule actually works

Three design decisions make it usable rather than noisy:

**It scores on cost, not raw tokens.** About 85% of Claude Code's tokens are cache reads
priced at 0.1×. A token-based rule therefore mostly detects "the context got large" —
in practice it fired on 14.8% of all windows. Scoring on `SUM(cost_usd)` (or, where the
window is unpriced, on tokens excluding cache reads) reports money instead.

**The baseline is a leave-one-out median.** A window is compared against the median of
*all the other* windows in its group, so a spike cannot hide inside the baseline it
helped create.

**Only real windows are baseline candidates.** A window must clear 20,000 tokens to
count toward the baseline, so a stray small call cannot drag the median down and inflate
everyone else's multiple.

Grouping is `(tool, model, session)`, and the threshold is 3× the baseline — `warn`
below 6×, `critical` at or above it. A group needs at least 4 qualifying windows before
any comparison is made, which is a deliberate trade: a short, violent session has no
"normal" to be judged against and will not fire.

---

## 9. Verification — the trust mechanism

`pnpm verify` exists to answer one question: *are these numbers real?*

It independently re-derives **every stored row from its original source** and requires
an exact match — Claude Code, Codex, OpenCode, Grok and Cursor each have their own
reconciliation pass. It also asserts that every `activity_only` row is `NULL` in every
token and cost field, so an unmeasured row can never carry a number.

Two behaviours make it meaningful rather than decorative:

- On an empty store it **fails**, with *"there is nothing to verify; a PASS here would
  prove nothing."* It refuses to claim success it has not earned.
- Perturbing a single stored total by one token turns a run FAIL. (This is worth
  re-testing whenever the verifier changes; a checker that cannot fail proves nothing.)

---

## 10. The surfaces

**macOS app.** Menu-bar item showing live tokens or cost, tinted while an incident is
open. The dashboard window holds the KPI row, the incident-annotated timeline (tokens
stacked per tool, with every incident pinned to the bucket where its rule fired), the
incident feed, and a per-tool/model breakdown with a confidence badge on every row. The
store is re-read on a timer; `DB` is an actor so the read never blocks the UI.

**CLIs.** `top` (htop for agents — live sessions, context vs window, tok/min, cache
countdown), `digest` (a period summary as markdown), `pr` (agent spend on the current
git branch, for a PR description), `statusline` (one line for a status bar).

**MCP server.** Speaks newline-delimited JSON-RPC on stdio with no dependencies, exposing
`vole_summary`, `vole_live_sessions`, `vole_session`, `vole_incidents`, `vole_breakdown`,
`vole_whatif` and `vole_digest`. This is what lets an agent ask what its *own* session
has cost and how full its context is — the basis for cost-aware agents.

---

## 11. Build and distribution

`apps/mac/bundle.sh` assembles `Vole.app`. It also builds the collector into a single
self-contained executable — esbuild bundles the TypeScript, then Node's SEA support plus
postject inject it into a pinned Node binary — and embeds it at
`Contents/MacOS/vole-collector`. A packaged app therefore spawns its own collector on
launch and stops it on quit; nothing else needs installing.

`--release` additionally signs with a Developer ID certificate, notarises with Apple, and
staples the ticket. A plain build is ad-hoc signed and will only run on the machine that
built it.

Updates are checked against GitHub releases, and the downloaded archive's SHA-256 is
verified against the published checksum before the bundle is swapped. **This version
check is the only network call the application makes**, and it can be disabled with
`VOLE_NO_EGRESS=1`.

---

## 12. Testing

| Layer | State |
|---|---|
| Collector, rules, queries, pricing | 83 tests via `node:test`; run with `pnpm test` |
| Types | `pnpm typecheck` (`tsc --noEmit`) |
| Data integrity | `pnpm verify` — re-derives every row from source |
| macOS app | **No automated tests.** CI compiles it only |

That last row is the honest weak point. The app is ~3,200 lines and the entire user
interface, and every app-side bug found so far was found by *running* it, not by the
suite: a 55-second freeze, a corrupt store reported as healthy, and a schema constant
that silently blanked the whole dashboard.

The tests that exist are written to encode traps rather than restate the code —
*"anomaly keys are stable, so re-running cannot duplicate incidents"*, *"a lone spike
cannot hide inside its own baseline"*, *"unknown models cost null, never 0"*. A test
that merely re-implements the rule it is checking passes no matter how broken the real
code is, and is worse than no test at all.

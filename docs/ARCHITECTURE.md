# Architecture

Reference for how Vole is put together, and why the non-obvious decisions were made.
For what the product does and how to run it, see the [README](../README.md).

---

## Module map

```
packages/core/src/
  types.ts              Shared types. Confidence levels, UsageEvent, Anomaly.
  schema.ts             SQLite DDL as an inlined string.
  db.ts                 Connection, migrations, idempotent inserts, repricing, seed purge.
  pricing.ts            Versioned rate table, cache multipliers, context windows, computeCost().
  paths.ts              Source locations, with env overrides for tests.
  queries.ts            Read models: summary, timeseries, breakdown, anomalies, live sessions,
                        session detail, cache re-warm, what-if, digest.
  digest.ts             The digest as markdown.
  util/jsonl.ts         Incremental byte-offset line reader.
  util/format.ts        Compact numbers, money, countdowns — for the CLIs.
  collectors/
    claude-code.ts      Primary source. Exact. Deduped on message.id. Recursive (subagents).
    codex.ts            Exact tokens via cumulative deltas; tool names; self-reported window.
    cursor.ts           Activity only — no tokens exist locally.
    antigravity.ts      Activity only; no local token data.
    opencode.ts         Exact per-message tokens + cost from opencode.db; tools; child sessions.
    grok.ts             Exact per-turn tokens; tool executions; failed inferences as error rows.
    devin.ts            Activity only; ACP payloads carry no token data.
    index.ts            Registry; isolates per-collector failures.
  detect/
    burn-rate.ts        Token-burn rate spike.
    loop.ts             Runaway loop.
    error-storm.ts      Retry/failure ratio spike.
    rate-limit.ts       Quota pressure (Codex only).
    context-pressure.ts Context carried vs the model window.
    util.ts             Bucketing, leave-one-out median, confidence propagation.
    index.ts            detectAll() and detectBySource().
  cli/
    collect.ts          The monitor. One-shot or polling; desktop notifications.
    seed.ts             Demo data generator and purge.
    verify.ts           Per-message reconciliation against raw logs.
    top.ts              Live sessions in the terminal.
    pr.ts               Usage on the current branch, as markdown.
    digest.ts           Period digest, markdown or JSON.
    statusline.ts       One line for a status bar.
    mcp.ts              stdio MCP server over the queries.

apps/mac/Sources/Vole/
  DB.swift              Read-only SQLite3 + the read models ported from queries.ts.
  Store.swift           @Observable state, re-reads on the chosen interval.
  Theme.swift           Palette, formatters, labels, tool logos.
  MenuPanel.swift       The menu-bar panel.
  DashboardView.swift   The window: KPI row, timeline (Swift Charts), incidents, breakdown, settings.
  VoleApp.swift         MenuBarExtra + Window scenes, activation policy.
```

`packages/core` imports no UI framework. That constraint is what lets the collector, the seeder,
the verifier, the CLIs and the MCP server all share one implementation of parsing, pricing and
detection. The app has no Node runtime at all: it reads the same file through the SQLite3 library
that ships with macOS.

---

## Database schema

Written to `~/.vole/vole.db` (override with `VOLE_DB`). WAL mode.

### `usage_events`

One row per model call, normalised across all tools.

```sql
CREATE TABLE usage_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key             TEXT    NOT NULL UNIQUE,   -- dedup key
  tool                  TEXT    NOT NULL,          -- claude_code|codex|cursor|antigravity|opencode|grok|devin
  model                 TEXT,
  session_id            TEXT,
  project               TEXT,                      -- cwd / workspace
  git_branch            TEXT,
  ts                    INTEGER NOT NULL,          -- epoch ms UTC
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  cache_read_tokens     INTEGER,
  reasoning_tokens      INTEGER,
  total_tokens          INTEGER,
  cost_usd              REAL,                      -- NULL when rate unknown
  confidence            TEXT    NOT NULL,          -- exact|activity_only
  is_error              INTEGER NOT NULL DEFAULT 0,
  stop_reason           TEXT,
  source                TEXT    NOT NULL DEFAULT 'live',  -- live|seed
  raw_ref               TEXT                       -- "<file>#<line>" for auditability
);
```

Nullable token columns are deliberate. A tool that records no tokens stores `NULL`, not `0`, so an
absence can never be mistaken for a measurement of zero.

### `anomalies`

```sql
CREATE TABLE anomalies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  anomaly_key  TEXT    NOT NULL UNIQUE,
  rule         TEXT    NOT NULL,
  severity     TEXT    NOT NULL,          -- info|warn|critical
  tool         TEXT    NOT NULL,
  session_id   TEXT,
  model        TEXT,
  window_start INTEGER NOT NULL,
  window_end   INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  detail       TEXT    NOT NULL,          -- human explanation carrying real numbers
  observed     REAL    NOT NULL,
  baseline     REAL,
  threshold    REAL,
  confidence   TEXT    NOT NULL,          -- worst confidence among contributing events
  source       TEXT    NOT NULL DEFAULT 'live',
  detected_at  INTEGER NOT NULL
);
```

### `collector_state`

Byte offsets so polling only reads newly appended bytes.

```sql
CREATE TABLE collector_state (
  source_path     TEXT PRIMARY KEY,
  tool            TEXT    NOT NULL,
  last_offset     INTEGER NOT NULL DEFAULT 0,
  last_mtime      INTEGER,
  last_scanned_at INTEGER
);
```

---

## Idempotency: the `event_key` contract

Every collector produces a stable, natural key under a `UNIQUE` constraint, so re-scanning a file
can never double-count.

| Tool | Key | Why |
|---|---|---|
| Claude Code | `claude_code:<message.id>` | Kills the ~2.4× transcript duplication |
| Codex | `codex:<session_id>:<line_index>` | Stable across full-file re-reads |
| Cursor | `cursor:<requestId>` | One row per model call, not per code hash |
| Antigravity | `antigravity:<conversation_id>:<mtime>` | New row only when the conversation changes |
| OpenCode | `opencode:<message.id>` | One row per assistant turn |
| Grok | `grok:<session>:<timestamp>` | One row per inference; log is re-read in full |
| Devin | `devin:<session>:<turnId>` | Activity only; one row per agent turn |

The insert is `INSERT … ON CONFLICT(event_key) DO UPDATE … WHERE excluded.total_tokens >
total_tokens`. For every collector but Claude Code the conflict clause is dead weight (their keys
are immutable or already delta-based). Claude Code needs it: it writes each message to the
transcript several times while streaming, the first copy with `output_tokens: 0`, so a plain
ignore-on-conflict would freeze the row at zero output. The upgrade only ever raises a stored
row's token count, so re-reading identical data is still a no-op.

This is the property that makes the polling loop safe. The collector never has to reason about
"have I seen this before?" — the database answers it.

### Why Codex re-reads whole files

Codex usage is derived from the *delta* of a cumulative counter, so it needs a known starting
point. Resuming from a byte offset mid-file would lose the running total. Rollout files are few
and small, and `INSERT OR IGNORE` makes the re-read free, so the collector reads them in full and
recomputes deltas deterministically.

The delta approach also self-corrects for Codex emitting the same `token_count` event twice: a
duplicate contributes a delta of zero and is skipped.

---

## Detection design

All rules are pure: `(events, now) => Anomaly[]`. No database access, so they are unit-tested
against fixture arrays.

### Leave-one-out baselines

A window is compared against the median of *all other* windows, never a median that includes
itself.

With a plain median and sparse data, a single large window drags the baseline up far enough to
mask itself. Example: windows of `[10, 30]` have a median of 20, so 30 calls fails a `> 3×`
test that it should obviously pass. Excluding the candidate gives a baseline of 10, and the rule
fires correctly.

### Two-signal loop detection

Call frequency alone does not distinguish a stuck agent from a productive burst. The rule requires
**both** high call volume *and* the stuck signature: average output near-flat while cache reads
climb — an agent re-reading the same context and producing nothing.

### Source partitioning

`detectBySource()` runs the rules separately for each `source` value and folds the source into
`anomaly_key`.

Keeping seeded and live rows in separate *rows* is not enough if the *analysis* pools them: a
30-day synthetic history would redefine what "normal" means for real usage, and a genuine spike
could be masked by demo data. Partitioning is what makes demo data genuinely removable.

### Anomaly key stability

Keys bucket by rule + tool + session + time window, and never include `now`. A sustained incident
therefore produces one row rather than one row per poll, and re-running detection is idempotent.

---

## Confidence propagation

`worstConfidence()` takes the weakest confidence among the events contributing to an anomaly. An
incident is only as trustworthy as its least trustworthy input.

Token maths filters `activity_only` rows out entirely rather than coalescing them to zero —
counting a call with unknown size as zero would silently drag down per-call averages.

The read models enforce the same rule:

```sql
-- excluded from token sums, still counted as calls
COALESCE(SUM(CASE WHEN confidence != 'activity_only' THEN total_tokens END), 0)
```

---

## How the app reads the store

`DB.swift` opens `~/.vole/vole.db` (or `$VOLE_DB`) read-only through the system `SQLite3` module
and ports the read models from `queries.ts` one to one — same `confidence != 'activity_only'`
guard on every token aggregate, same `source = 'live'` filter, same bucketing. `Store.swift` runs
them on a timer (5s "live", or longer from Settings) on the main actor; the whole refresh is a few
milliseconds on a 10 MB database, so nothing is moved off-main until it shows up as a hitch.

The app distinguishes *quiet* from *collector down* with `collector_state.last_scanned_at`: the
collector stamps every source it touches on every pass, so `MAX(last_scanned_at)` is its heartbeat.

**Bucketing needs an explicit `CAST`** in both implementations. A bound numeric parameter makes
SQLite use floating-point division, so `(ts / n) * n` returns `ts` unchanged and every event
becomes its own bucket. `CAST(ts / ? AS INTEGER) * ?` is what actually aligns buckets to day/hour
edges.

The UI is Apple-native on purpose: system semantic colours and the standard controls, one brand
colour per tool that is never reused for status, severity always as a coloured glyph *with a
word*, and Liquid Glass only where the system supplies it (the menu-bar panel, the toolbar) —
never nested. See [apps/mac/README.md](../apps/mac/README.md) for building and packaging.

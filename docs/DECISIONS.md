# How this was built

An engineering record: the method, the decisions, and — most usefully — the bugs that were caught
and how. If you are picking this project up, this is the file that explains *why* the code looks
the way it does.

---

## The method: investigate before designing

The original brief specified four data sources and assumed each one worked a particular way. The
first action was **not** to write a parser. It was to look at what is actually on disk.

That investigation changed the plan substantially:

| Brief assumed | Reality found |
|---|---|
| Codex uses `~/.codex/projects/` JSONL like Claude Code | It uses `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, and emits *cumulative* counters |
| Cursor persistence "less standardised, investigate first" | Cursor stores **no token data at all** locally |
| Antigravity "token counts not exposed exactly" | Correct — and worse: conversation payloads are **encrypted** |
| Two confidence levels (`exact` / `estimated`) suffice | Cursor fits neither; a third level was required |

**Takeaway for anyone extending this:** an hour spent with `jq`, `sqlite3` and `xxd` before writing
code saved several wrong parsers. The investigation method is documented in
[DATA-SOURCES.md](DATA-SOURCES.md#investigating-a-new-tool).

---

## The five bugs that shaped the architecture

Each of these was caught by verification rather than by reading code. They are listed first because
they explain most of the non-obvious decisions.

### 1. Claude Code duplicates every usage record (~2.1×)

**Found:** counting raw usage rows (861) against unique `message.id` values (408) during the initial
investigation.

**Impact if missed:** every token count, every cost, and every anomaly baseline roughly doubled. The
product would have looked like it worked while being wrong everywhere.

**Fix:** `event_key = claude_code:<message.id>` with a `UNIQUE` constraint and `INSERT OR IGNORE`.

**Why this shape:** dedup could have been a `SELECT DISTINCT` at query time, but making it a
database constraint means the *polling loop* is also idempotent — the collector never has to ask
"have I seen this?". One decision solved two problems.

**Guard:** `pnpm verify` prints the live duplication factor on every run.

### 2. Codex double-counting, twice over

**Found:** a Codex total of 120M tokens looked implausible for five small sessions, so it was
checked against each session's own final cumulative counter.

Two distinct traps sat here:

- Summing `total_token_usage` (cumulative) grows quadratically with turn count.
- Summing `last_token_usage` (per-turn) *also* over-counts, because Codex sometimes emits the same
  `token_count` event twice.

**Fix:** derive usage from the **delta of the cumulative counter**. A duplicate emission produces a
delta of zero and is skipped.

**Verification:** per-session sums reconstruct each session's final cumulative counter *exactly*
(12,867,036 / 1,333,250 / 15,989,943 / 89,931,567 / 80,975). The 120M turned out to be real — one
session ran 1,513 turns, and cached context is re-read every turn.

**Lesson:** "this number looks too big" is a hypothesis, not a conclusion. It was worth checking,
and the check proved the code right rather than wrong.

### 3. Float division silently destroyed time bucketing

**Found:** API output showed bucket values like `1786160794400.9998` — not day boundaries.

**Cause:** a bound numeric parameter makes SQLite use floating-point division, so `(ts / n) * n`
returns `ts` unchanged. Every event became its own bucket: the chart would have drawn 1,579 bars
instead of 17.

**Fix:** `CAST(ts / ? AS INTEGER) * ?`, plus a regression test asserting that events seconds apart
collapse into one day bucket.

**Lesson:** the bug was invisible in the UI at a glance — the chart *rendered*, it was just wrong.
Checking the API payload rather than the picture is what caught it.

### 4. Anomaly baselines masked the anomalies

**Found:** a unit test that *should* have passed did not. With windows of `[10, 30]`, the median is
20, so 30 calls failed a `> 3×` test it should obviously have passed.

**Cause:** the outlier was included in the baseline it was being measured against.

**Fix:** `medianExcluding()` — leave-one-out baselines. A window is compared against the median of
all *other* windows.

**Lesson:** the test caught a real design flaw, not a coding slip. It mattered because real data is
sparse, which is exactly when a single window dominates the median.

### 5. Seed data contaminated live baselines

**Found:** after seeding, burn-spike incidents could not be attributed to a source.

**Cause:** detection ran over live and seeded rows *pooled together*. Keeping them in separate rows
is not enough if the **analysis** mixes them — 30 days of synthetic history would redefine what
"normal" means for real usage, and a genuine spike could be masked by demo data.

**Fix:** `detectBySource()` partitions events by `source` before running rules, and folds the source
into `anomaly_key`.

**Lesson:** "don't contaminate real data" is a statement about the statistics, not just the storage.

---

## Design decisions

### Confidence is a three-value system

The brief specified `exact | estimated`. Cursor has real sessions and models but **zero tokens**.
Labelling that "estimated" would mean fabricating numbers — precisely what the confidence system
exists to prevent.

`activity_only` rows store `NULL` (never `0`) and are excluded from every token and cost aggregate
while still counting as calls.

**Rejected alternative:** estimating Cursor tokens from lines of code. It would have produced a
plausible-looking number with an "estimated" badge, and a demo reviewer could not have told the
difference between that and Antigravity's defensible turn-count proxy. Fabrication that looks like
measurement is worse than an honest gap.

### Exact tokens ≠ known cost

Codex gives exact tokens, but no published per-token rate is loaded, so `cost_usd` is `NULL` and
renders `—`. Two separate ideas, two separate representations. Rendering `$0` would have been a
lie of a different kind.

### Cost is "equivalent API value", labelled

On a subscription plan you are not billed per token. Presenting a dollar figure as a bill would be
misleading, and omitting it entirely loses the number people react to. The compromise is to compute
list-price equivalent and **say so on the tile**.

It is computed *exactly*, not approximated: Claude Code reports cache creation already split by TTL,
so each component gets its own multiplier (read 0.1×, 5m write 1.25×, 1h write 2×).

### Rules are pure functions

`(events, now) => Anomaly[]`, with no database access. This makes them unit-testable against
fixture arrays, which is what allowed the leave-one-out flaw to surface in a test rather than in
production data.

### Loop detection needs two signals

Call frequency alone does not distinguish a stuck agent from a productive burst. The rule requires
high call volume **and** the stuck signature: output near-flat while cache reads climb.

This is validated by a negative test — 45 rapid calls *with* real output must **not** fire.

### Idempotency as a database constraint

Every collector produces a stable natural key; the schema enforces uniqueness; inserts ignore
conflicts. As a result:

- re-scanning a file is free and safe,
- `collector_state` offsets are a pure optimisation, not a correctness requirement,
- deleting `collector_state` triggers a harmless full re-parse.

### Verification compares per message, not by totals

Totals drift continuously while a Claude Code session is live — the logs grow underneath you. A
total-vs-total check can therefore neither prove nor disprove correctness.

`pnpm verify` reconciles **each stored row against its own source record**, and deliberately
re-implements the cost formula rather than importing `pricing.ts`, so a bug there cannot cancel
itself out.

This distinction was not academic: an early total comparison showed `$40.12` expected vs `$39.83`
stored. Both numbers were correct; the gap was drift. Per-message reconciliation resolved it to
400/400 with zero mismatches.

---

## Interface decisions

> **Superseded (September 2026).** The web dashboard and the Tauri widget described in the next
> few sections were removed: the product is the native macOS app in `apps/mac` plus the collector.
> The notes stay because the reasoning — chart animation versus polling, the palette relief rule,
> one UI over one data path — carried straight into the SwiftUI app.

### Recharts, not Tremor

The brief specified Tremor + React 19. Tremor 3.18 declares `react: ^18.0.0` and does not support
React 19. Rather than force a peer-dependency override in a time-boxed build, the project took the
brief's own stated fallback — Recharts, which supports React 19 explicitly — and hand-built the
stat tiles.

### The signature: incidents pinned to the timeline

The first UI kept the usage chart and the incident list separate, which made the reader do the
correlation themselves: see a spike, hunt the list for the cause.

Pinning each incident onto the exact bucket where its rule fired collapses that into one glance,
and the highlight is bidirectional. This is information design, not decoration — it is the one
element the tool is remembered by.

### Chart animation is disabled

Recharts animates entry over 1.5s; the dashboard polls every 3s. Left on, the chart re-animates
from zero on every refresh — flickering roughly half the time. A live monitor should look stable.

This also explains why two early screenshots showed an "empty" chart: they caught it mid-animation.
The DOM inspection that diagnosed it (`document.querySelectorAll('.recharts-bar-rectangle path')`
returned 70 elements with correct fills) is the debugging move worth remembering.

### Palette was re-validated, not assumed

The categorical palette was validated against a *warm* dark surface. This design uses cool graphite,
so the earlier results no longer applied and the palette was re-run against the actual surfaces.

Dark passes every check. Light passes separation checks but two slots fall below 3:1 contrast, so
the **relief rule** applies — the dashboard ships a labelled legend *and* a full breakdown table,
so no value is ever carried by colour alone.

### One UI, two windows

The Tauri widget loads the dashboard's own `/widget` route rather than reimplementing a second
interface. One component set, one polling path, one design system. The Rust side contributes only
the desktop shell.

The live menubar title is pushed *from* the page *into* Rust via a single command, which avoids
giving the Rust binary its own HTTP client and compile cost.

---

## What was deliberately not built

Recorded so nobody re-litigates them without new information.

| Not built | Why |
|---|---|
| Cursor token estimates | Would be fabricated. No local source exists. |
| Antigravity payload decryption | Encrypted; attempting it is out of scope and fragile. |
| WebSocket live updates | Polling is simpler and self-heals. The brief said add it only if polling was solid and time allowed. |
| Schema migrations | The database is disposable — it rebuilds from source logs in seconds. |
| Cloud sync / multi-machine | The project's premise is local-only. |
| Web-UI scraping for any tool | Explicitly out of scope, and fragile by nature. |

---

## Honest limitations

These are real and currently unaddressed. See [ROADMAP.md](ROADMAP.md) for what to do about them.

- **`is_error` covers API errors only.** Failed *tool* results inside a turn are not correlated
  back to the assistant message that issued them, so `error_storm` under-counts on live data. It
  fires reliably on seeded data only.
- **Antigravity timing is approximate** — file mtimes, not real timestamps.
- **Codex and Cursor data may be stale** depending on your usage; their parsers are correct but may
  contribute only history.
- **Production build untested.** Only `next dev` has been exercised.
- **The app is ad-hoc signed** and not packaged for distribution.

---

## The habit worth copying

Nearly every fix above came from the same move: **check the claim against the source rather than
against the code**.

- Raw log counts, not the parser's opinion.
- API payloads, not the rendered chart.
- The DOM, not the screenshot.
- An independently re-implemented formula, not the one under test.

The single most valuable artefact in this repo is `pnpm verify`, because it makes that habit
automatic.

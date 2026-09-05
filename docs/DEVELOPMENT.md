# Development guide

Everything needed to get productive in this codebase, including how to debug it when a number
looks wrong.

---

## Prerequisites

| Requirement | Version | Needed for |
|---|---|---|
| Node | ≥ 22 | The collector, CLIs, tests |
| pnpm | ≥ 9 | Workspace management |
| Xcode 26 | with the macOS 26 SDK | The app (`swift build`); its CLT also compiles `better-sqlite3` |

Built and tested on **macOS 26.5 (arm64)**. The collectors read macOS/Linux paths; Windows would
need `paths.ts` updated.

```bash
git clone https://github.com/launchsafe/vole
cd vole
pnpm install
```

`better-sqlite3` compiles a native binding during install. If that fails, you are missing Xcode
CLT (`xcode-select --install`).

---

## First run

```bash
pnpm collect:once     # parse local logs, print a summary
pnpm app              # the menu-bar app (swift run)
```

If `collect:once` prints all zeros, you have no local agent logs — run `pnpm seed` for demo data.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm collect:once` | One parse pass over all sources, with a verbose summary |
| `pnpm collect` | Continuous polling every 5s — **this is the monitor** |
| `pnpm app` | The macOS app via `swift run` (no bundle) |
| `pnpm app:bundle` | `build/Vole.app`, release build, ad-hoc signed, opened |
| `pnpm test` | Unit tests (rules, queries, bucketing, invariants) |
| `pnpm typecheck` | `tsc --noEmit` in every package (`tsx` strips types without checking them) |
| `pnpm verify` | Per-message reconciliation against raw logs |
| `pnpm seed` | Generate 30 days of demo data |
| `pnpm seed:purge` | Remove every seeded row |
| `pnpm top` | Terminal view of live sessions (`--once` for a single frame, `--since=<min>`) |
| `pnpm pr` | Agent usage on the current git branch as markdown (`--since=<days>`, `--json`) |
| `pnpm digest` | Period digest as markdown (`--range=`, `--json`) |
| `pnpm statusline` | One status-bar line for a session (stdin JSON with `session_id`, or `--session=`) |
| `pnpm mcp` | stdio MCP server; run with `pnpm --silent` so only protocol JSON reaches stdout |

Collector flags:

```bash
pnpm --filter @vole/core collect -- --once            # single pass
pnpm --filter @vole/core collect -- --once --verbose  # + summary tables
pnpm --filter @vole/core collect -- --interval=30     # poll every 30s
pnpm --filter @vole/core collect -- --no-notify       # no desktop notifications (Linux notify-send path only)
```

App:

```bash
swift run --package-path apps/mac Vole --dump          # headless: print the parsed summary and exit
swift run --package-path apps/mac Vole --range=7d      # open with a range preset
VERSION=0.2.0 apps/mac/bundle.sh                       # package build/Vole.app
```

---

## Project layout

```
packages/core/          Plain TypeScript. No UI imports.
  src/collectors/       One file per tool. Returns normalised rows; never touches SQL.
  src/detect/           One file per rule. Pure functions, unit-tested without a DB.
  src/cli/              collect (the monitor), seed, verify, top, pr, digest, statusline, mcp.
  src/db.ts             Connection, migrations, idempotent inserts, repricing.
  src/queries.ts        Read models — shared by the CLIs and the MCP server, ported to Swift.
  src/pricing.ts        Rate table, context windows, computeCost().

apps/mac/               SwiftUI, Swift Package, no dependencies.
  Sources/Vole/DB.swift        Read-only SQLite + read models ported from queries.ts.
  Sources/Vole/Store.swift     Polling state.
  Sources/Vole/*View.swift     Menu-bar panel and dashboard window.
```

**The important constraint:** `packages/core` imports no UI framework, and the app has no Node
runtime. Anything the app shows must be a query that can be expressed in `queries.ts` *and* ported
to `DB.swift`; if a query is only useful in one place, it still starts in core so `pnpm test` can
cover it.

### Layering rules

```
collectors  →  return UsageEvent[]        (never write SQL)
db          →  writes rows                (never parses logs)
detect      →  pure functions             (never reads the DB)
queries     →  read models                (never mutates)
DB.swift    →  the same read models       (read-only; the collector owns writes)
views       →  Store in, SwiftUI out      (never touch SQLite)
```

---

## The database

Lives at `~/.vole/vole.db` (WAL mode). Override with `VOLE_DB`.

It is **disposable** — delete it and re-run `pnpm collect` to rebuild from source logs.

```bash
sqlite3 ~/.vole/vole.db

.tables
SELECT tool, confidence, COUNT(*), SUM(total_tokens) FROM usage_events GROUP BY 1,2;
SELECT source, rule, COUNT(*) FROM anomalies GROUP BY 1,2;
SELECT * FROM collector_state;
```

Useful resets:

```bash
rm -rf ~/.vole            # full reset
sqlite3 ~/.vole/vole.db "DELETE FROM collector_state;"  # force full re-parse
sqlite3 ~/.vole/vole.db "DELETE FROM anomalies;"        # re-run detection clean
```

Deleting `collector_state` is safe: `event_key` is `UNIQUE` and inserts are `INSERT OR IGNORE`,
so a full re-parse cannot duplicate anything.

### Testing against fixtures

`paths.ts` reads `VOLE_HOME_OVERRIDE`, so you can point collectors at a fixture tree:

```bash
VOLE_HOME_OVERRIDE=/tmp/fixture-home \
VOLE_DB=/tmp/test.db \
pnpm --filter @vole/core collect -- --once --verbose
```

---

## Testing philosophy

Two layers, deliberately different in kind.

### 1. Unit tests — `pnpm test`

Rules and queries are pure or DB-only, so they are tested against fixture arrays and temp
databases. 15 tests covering rule thresholds, bucket alignment, and confidence invariants.

Tests encode *intent*, not just behaviour. Example — a test that pins the boundary deliberately:

```ts
test('loop: exactly 3x the baseline does not fire (threshold is strictly greater)', ...)
```

### 2. Reconciliation — `pnpm verify`

This is the one that matters. It:

- re-implements the cost formula **independently** of `pricing.ts`, so a bug there cannot cancel
  itself out;
- compares **per message**, not by totals — totals drift continuously while a Claude Code session
  is live, so a total-vs-total check can neither prove nor disprove correctness;
- reports the live duplication factor.

```
  duplication factor          2.11x  <- inflation avoided by dedup
  reconciled per-message      400
  cost mismatches             0
  worst cost delta (USD)      0.00e+0

  PASS — every stored row matches its source record.
```

**Run `pnpm verify` after any change to a collector or to pricing.** If the PASS line changes,
stop and investigate before doing anything else.

---

## Debugging recipes

### "A number looks wrong"

Work outward from the source, not inward from the UI.

```bash
# 1. Does the raw log agree?
cat ~/.claude/projects/*/*.jsonl | jq -r 'select(.message.usage!=null) | .message.id' | sort -u | wc -l

# 2. Does the DB agree with the raw log?
pnpm verify

# 3. Do the two read models agree with the DB?
pnpm --silent digest --range=all --json | head -20                # core's queries
swift run --package-path apps/mac Vole --dump                     # the app's port of them
sqlite3 ~/.vole/vole.db "SELECT COUNT(*), SUM(total_tokens) FROM usage_events;"

# 4. Only then look at the view.
```

Nine times in ten the answer is at step 2 or 3.

### "The app says 'Waiting for the collector' but data exists"

The app keys that state on `collector_state.last_scanned_at`, the collector's heartbeat. Check it,
and check the app is reading the file you think it is (`$VOLE_DB` overrides the default):

```bash
sqlite3 ~/.vole/vole.db "SELECT MAX(last_scanned_at) FROM collector_state;"
swift run --package-path apps/mac Vole --dump      # prints the path it opened
```

If the collector was started against a different `VOLE_DB`, the two are looking at different files.

### "Collector finds no files"

```bash
ls ~/.claude/projects/ ~/.codex/sessions/ 2>&1
sqlite3 ~/.vole/vole.db "SELECT tool, COUNT(*) FROM collector_state GROUP BY 1;"
```

Collectors fail in isolation — one broken source is reported in `notes` and does not stop the
others. Run with `--verbose` to see those notes.

### "A number in the app differs from `pnpm top` / `pnpm digest`"

The app charts `source = 'live'` rows only and never includes seed data; the CLIs do the same.
If they still differ, `DB.swift` and `queries.ts` have drifted — diff the SQL, they are meant to be
the same statement.

---

## Conventions

- **Comments explain *why*, not *what*.** Nearly every comment in this codebase documents a
  constraint or a trap, because the tricky parts are all non-obvious.
- **`NULL` never becomes `0`.** Unknown cost and absent tokens render as `—`.
- **Numbers in the app use `.monospacedDigit()`** so columns stay comparable.
- **Colours are the system palette**, plus one brand colour per tool in `Pal.series`; status
  colours are never reused as a series colour.
- **Match the surrounding code.** The codebase is small and consistent; follow the file you are in.

Next: [EXTENDING.md](EXTENDING.md) to add a tool, a rule, or a panel.

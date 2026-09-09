# Roadmap

Concrete ways to take this further, ranked within each tier by value-to-effort. Each entry names
the files involved so you can start immediately.

Effort is rough: **S** = an afternoon · **M** = a day or two · **L** = a week or more.

---

## Tier 1 — Close the known gaps

These are documented weaknesses. Fixing them makes existing claims fully true.

### Correlate tool errors back to their assistant message · **M**

**Problem:** `is_error` only captures API errors (`isApiErrorMessage`). Failed *tool results* inside
a turn are not linked to the assistant message that issued them, so `error_storm` under-counts on
live data — it currently fires reliably only on seeded data.

**Approach:** while parsing a Claude Code transcript, buffer `tool_use` block ids from assistant
messages, then scan subsequent `type: "user"` entries whose content contains
`tool_result` blocks with `is_error: true`. Map the result back via `tool_use_id` and set
`is_error = 1` on the originating event.

**Files:** `packages/core/src/collectors/claude-code.ts`, plus a fixture test.

**Watch out:** the tool result may arrive after the assistant event has already been inserted. Either
buffer within the file pass, or add a second `UPDATE` pass keyed on `event_key`.

### Signed, notarised app · **S–M**

**Problem:** `bundle.sh` ad-hoc signs `Vole.app`; it runs locally but cannot be distributed.

**Approach:** an Apple Developer ID, `codesign --options runtime`, `notarytool`, and a `.dmg`.
`bundle.sh` already assembles the bundle, so this is the last mile. A Homebrew cask after that.

### Collector as a sidecar · **M**

You still start `pnpm collect` yourself. The app could launch and supervise it (a `Process` with
the bundled Node, or a `launchd` agent installed from Settings), so the whole product is one icon.

**Files:** `apps/mac/Sources/Vole/Store.swift`, `VoleApp.swift`.

---

## Tier 2 — Make it a better monitor

### Port the core-only views into the app · **M**

The highest-value item on this list. These are complete and tested in `packages/core`, and reachable
from `pnpm top`, `pnpm digest` and the MCP server, but the app does not draw them yet:

- **Live sessions** — `getLiveSessions()`: context vs window gauge, tokens/min, last tools, the
  prompt-cache countdown and re-warm cost, open incidents.
- **Session drill-down** — `getSessionDetail()`: context per call as one line per agent thread,
  the subagent cost tree, "what grew the context" (the largest jumps and the tools whose results
  came back before them). Link from every incident.
- **Digest** — `getDigest()` / `digestMarkdown()`: the "your agent week" card with a share sheet.
- **What-if** — `getWhatIf()`: the same token split at other models' list rates, labelled as
  arithmetic only.

Each is a `DB.swift` port of one query plus a SwiftUI section; see
[EXTENDING.md → Adding a panel to the app](EXTENDING.md#adding-a-panel-to-the-app).

### Budget thresholds and a burn-down · **M**

Let the user set a daily or monthly token/cost budget and show pace against it — "at this rate you
will hit your budget on the 22nd".

**Approach:** a small `settings` table or a config file, a `budget_exceeded` rule, and a `Gauge`
in the app. A single ratio against a limit is a meter, not a pie.

**Files:** new `packages/core/src/detect/budget.ts`, new settings storage, a new metric row.

### Incident deep links · **S**

An incident names a session; the app should open that session's drill-down (above) from the
incident row, and the desktop notification should open the app to it.

### Incident acknowledgement · **S**

Add `acknowledged_at` to `anomalies` so handled incidents can be dismissed. Without it the feed
becomes noise over time.

**Note:** requires a schema change — see
[EXTENDING.md → Changing the schema](EXTENDING.md#changing-the-schema).

---

## Tier 3 — Broaden coverage

### More tools · **M each**

Gemini CLI, GitHub Copilot CLI (`~/.copilot/` exists on many machines), Aider, Cline, Continue.
Follow [EXTENDING.md → Adding a collector](EXTENDING.md#adding-a-collector), and do the
investigation step first — the whole point is to establish honestly what each one records.

### Cross-platform paths · **S**

`paths.ts` assumes macOS/Linux layouts. Windows needs `%APPDATA%` variants. The `home()` indirection
already exists, so this is contained.

### Import Claude Code's own cost data · **S**

Some Claude Code versions record additional cost metadata. Worth re-checking the transcript schema
periodically and cross-verifying against the computed figure — a second independent source would
strengthen `pnpm verify`.

---

## Tier 4 — Bigger swings

### Multi-machine aggregation · **L**

The premise is local-only, so this is a genuine architectural change. If you do it, keep collection
local and sync only the normalised `usage_events` rows — never raw transcripts, which contain
source code and prompts.

**Warning:** this crosses a privacy line the project currently guarantees. Make it opt-in, explicit,
and documented.

### Anomaly detection that learns · **L**

Current rules are fixed-threshold and explainable, which is a feature: every incident says exactly
why it fired. Any statistical model must preserve that. A reasonable middle path is per-session
seasonal baselines (weekday/hour aware) rather than a global median.

**Do not** replace explainable rules with an opaque score. "Possible runaway loop — 31 calls in 5
min while output stayed at 262 tokens" is the product.

### Live agent control · **L**

The logical endpoint of a sentry: not just detecting a runaway loop but offering to stop it. Would
require process discovery and a kill/pause mechanism per tool. High value, high risk — a false
positive kills real work.

### Historical rollups · **M**

`usage_events` grows without bound. Add a monthly rollup table and prune raw rows beyond a retention
window. Not urgent — SQLite handles millions of rows fine — but eventually needed.

---

## Good first issues

If you are new to the codebase, these are self-contained:

1. **Keyboard shortcuts for the range picker** in the app (`1`/`7`/`3`/`a`).
2. **A `--json` flag on `collect`** so the summary can be piped into other tools.
3. **Export the breakdown table as CSV** from the app (a share/save button).
4. **Launch at login** — the Settings toggle exists; wire it to `SMAppService`.
5. **A `--range=` flag on `pnpm top`** and colour for the context gauge in the terminal.
6. **Register the MCP server** from the app's Settings pane (writes the config for each tool).

---

## Principles to preserve

Whatever you build, these are what make the project defensible. Breaking them costs more than any
feature gains.

1. **Never invent a number.** If a tool does not record it, the field is `NULL` and the UI says so.
2. **Keep `exact` / `estimated` / `activity_only` visible** wherever a number is shown.
3. **Keep incidents explainable.** Every anomaly carries the real figures that triggered it.
4. **Keep `pnpm verify` passing**, and extend it when you add a source with exact data.
5. **Keep collection idempotent.** Stable `event_key`s; re-running must never double-count.
6. **Keep seed and live data separate** — in storage *and* in statistical baselines.
7. **Keep it local.** No scraping, no web-UI automation, no silent network calls.

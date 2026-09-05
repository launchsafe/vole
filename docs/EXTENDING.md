# Extending Vole

Step-by-step recipes with real code. Each one is a complete change: files to touch, code to write,
and how to verify it worked.

- [Adding a collector (a new tool)](#adding-a-collector)
- [Adding an anomaly rule](#adding-an-anomaly-rule)
- [Adding a model rate](#adding-a-model-rate)
- [Adding a panel to the app](#adding-a-panel-to-the-app)
- [Changing the schema](#changing-the-schema)
- [Tuning rule thresholds](#tuning-rule-thresholds)

---

## Adding a collector

Say you want to support a tool called **Aider**.

### Step 0 — Investigate before writing code

Do not skip this. The method is in
[DATA-SOURCES.md → Investigating a new tool](DATA-SOURCES.md#investigating-a-new-tool). You must
answer one question first:

> Does this tool record real token counts, a defensible proxy, or nothing?

That answer decides your `confidence` value, and everything downstream depends on it.

### Step 1 — Register the tool

`packages/core/src/types.ts`:

```ts
export type Tool = 'claude_code' | 'codex' | 'cursor' | 'antigravity' | 'aider';
```

TypeScript will now flag every place that needs updating. Follow the errors.

### Step 2 — Add the path

`packages/core/src/paths.ts`:

```ts
export const paths = {
  // ...
  /** Aider chat history: ~/.aider/history/*.jsonl */
  aiderHistory: () => join(home(), '.aider', 'history'),
};
```

Use the `home()` helper, never `homedir()` directly — that is what makes
`VOLE_HOME_OVERRIDE` work for fixture-based tests. Follow the per-source override pattern too
(`process.env.VOLE_<SOURCE> ?? join(home(), …)`), so any install can point a single source at a
non-standard location without touching code.

### Step 3 — Write the collector

`packages/core/src/collectors/aider.ts`:

```ts
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';
import { getState, setState, type DB } from '../db';
import { readNewLines, parseLine } from '../util/jsonl';
import { computeCost } from '../pricing';
import type { CollectorResult, UsageEvent } from '../types';

/**
 * Aider — <exact | estimated | activity_only>, because <the actual constraint you found>.
 */
export function collectAider(db: DB): CollectorResult {
  const root = paths.aiderHistory();
  const events: UsageEvent[] = [];
  const notes: string[] = [];
  let filesScanned = 0;

  // A missing directory is normal, not an error: the user may not have this tool.
  if (!existsSync(root)) {
    return { tool: 'aider', events, filesScanned, notes: [`No directory at ${root}`] };
  }

  for (const file of readdirSync(root)) {
    if (!file.endsWith('.jsonl')) continue;
    const filePath = join(root, file);
    filesScanned++;

    const state = getState(db, filePath);
    let result;
    try {
      result = readNewLines(filePath, state?.last_offset ?? 0);
    } catch (err) {
      notes.push(`Could not read ${file}: ${(err as Error).message}`);
      continue;   // one bad file must not stop the rest
    }

    for (const line of result.lines) {
      const entry = parseLine<any>(line);
      if (!entry?.usage) continue;

      const tokens = {
        input_tokens: entry.usage.prompt_tokens ?? 0,
        output_tokens: entry.usage.completion_tokens ?? 0,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 0,
      };

      events.push({
        // Must be STABLE across re-reads — this is what makes polling idempotent.
        event_key: `aider:${entry.id}`,
        tool: 'aider',
        model: entry.model ?? null,
        session_id: entry.session ?? null,
        project: entry.cwd ?? null,
        git_branch: null,
        ts: Date.parse(entry.timestamp),
        ...tokens,
        reasoning_tokens: 0,
        total_tokens: tokens.input_tokens + tokens.output_tokens,
        cost_usd: computeCost(entry.model ?? null, tokens),
        confidence: 'exact',
        is_error: 0,
        stop_reason: null,
        source: 'live',        // collectors NEVER write 'seed'
        raw_ref: filePath,
      });
    }

    setState(db, filePath, 'aider', result.newOffset, result.mtimeMs);
  }

  return { tool: 'aider', events, filesScanned, notes };
}
```

### Step 4 — Register it

`packages/core/src/collectors/index.ts`:

```ts
import { collectAider } from './aider';
export { collectAider };

const REGISTRY: { tool: Tool; run: (db: DB) => CollectorResult }[] = [
  // ...
  { tool: 'aider', run: collectAider },
];
```

### Step 5 — Add UI identity

`apps/mac/Sources/Vole/Theme.swift`:

```swift
// Pal.series — one brand colour per tool, never reused for status.
case "aider": return Color(red: 0.13, green: 0.59, blue: 0.95)
// Pal.symbol — SF Symbol fallback when no logo is bundled.
case "aider": return "terminal"
// Labels.order / Labels.tool / Labels.toolShort
"aider": "Aider"
```

Drop a `aider.png` into `Sources/Vole/Resources/` and `ToolIcon` picks it up automatically; add
the name to the `monochrome` set if the mark is near-black. The CLIs need nothing — they print the
tool id — but `packages/core/src/digest.ts` and `cli/top.ts` carry a label map worth extending.

### Step 6 — Verify

```bash
pnpm collect:once
```

Check three things:

1. Your tool appears with a plausible call count.
2. Re-run it — `dedup-skipped` should equal `parsed`, and `new` should be `0`. If not, your
   `event_key` is not stable.
3. `confidence` is what you decided in Step 0.

```bash
sqlite3 ~/.vole/vole.db \
  "SELECT confidence, COUNT(*), SUM(total_tokens IS NULL) FROM usage_events WHERE tool='aider' GROUP BY 1;"
```

If you chose `activity_only`, every token column must be `NULL` — the invariant test in
`queries.test.ts` covers this pattern.

### Step 7 — Document it

Add a section to [DATA-SOURCES.md](DATA-SOURCES.md) and a row to the README table. **This is not
optional.** The project's credibility rests on every number being traceable to a documented source.

---

## Adding an anomaly rule

Rules are pure functions: `(events, now) => Anomaly[]`. No DB access, so they are trivially
testable.

### Step 1 — Name it

`packages/core/src/types.ts`:

```ts
export type AnomalyRule =
  | 'burn_rate_spike' | 'loop_suspected' | 'error_storm' | 'rate_limit_pressure'
  | 'context_thrash';
```

### Step 2 — Write it

`packages/core/src/detect/context-thrash.ts`:

```ts
import type { Anomaly, UsageEvent } from '../types';
import { bucketOf, groupBy, medianExcluding, withTokens, worstConfidence, fmt, shortId } from './util';

const WINDOW_MS = 15 * 60 * 1000;
const MIN_CALLS = 10;
const RATIO_THRESHOLD = 0.97;   // cache reads this dominant means almost no new work

/**
 * Context thrash: the session is re-reading an enormous cached context to produce
 * almost nothing new. Distinct from a loop, which is about call *frequency*.
 */
export function detectContextThrash(events: UsageEvent[], now: number): Anomaly[] {
  const out: Anomaly[] = [];

  // withTokens() drops activity_only rows — they have no tokens to reason about.
  for (const [sessionId, group] of groupBy(withTokens(events), (e) => e.session_id ?? 'none')) {
    const windows = groupBy(group, (e) => String(bucketOf(e.ts, WINDOW_MS)));

    for (const [bucketStr, evs] of windows) {
      if (evs.length < MIN_CALLS) continue;

      const read = evs.reduce((s, e) => s + (e.cache_read_tokens ?? 0), 0);
      const total = evs.reduce((s, e) => s + (e.total_tokens ?? 0), 0);
      if (total === 0) continue;

      const ratio = read / total;
      if (ratio < RATIO_THRESHOLD) continue;

      const first = evs[0];
      if (!first) continue;
      const bucket = Number(bucketStr);

      out.push({
        // Stable key: rule + tool + session + window. Never include `now`,
        // or every poll creates a duplicate incident.
        anomaly_key: `context_thrash:${first.tool}:${sessionId}:${bucket}`,
        rule: 'context_thrash',
        severity: ratio > 0.99 ? 'critical' : 'warn',
        tool: first.tool,
        session_id: sessionId,
        model: first.model,
        window_start: bucket,
        window_end: bucket + WINDOW_MS,
        title: `Context thrash in ${first.tool} session ${shortId(sessionId)}`,
        // Put the real numbers in the text. An incident the reader cannot check is noise.
        detail:
          `${(ratio * 100).toFixed(1)}% of ${fmt(total)} tokens in 15 min were cached re-reads ` +
          `across ${evs.length} calls. The session is re-processing context rather than ` +
          `producing new work.`,
        observed: ratio,
        baseline: RATIO_THRESHOLD,
        threshold: RATIO_THRESHOLD,
        confidence: worstConfidence(evs),   // only as trustworthy as its weakest input
        source: first.source,
        detected_at: now,
      });
    }
  }
  return out;
}
```

### Step 3 — Register it

`packages/core/src/detect/index.ts`:

```ts
import { detectContextThrash } from './context-thrash';
export { detectContextThrash };

export function detectAll(events, rateLimits = [], now = Date.now()): Anomaly[] {
  return [
    // ...
    ...detectContextThrash(events, now),
  ];
}
```

`detectBySource()` picks it up automatically — it wraps `detectAll`.

### Step 4 — Label it in the UI

`apps/mac/Sources/Vole/Theme.swift`, `Labels.rule`, and the `RULE` map in
`packages/core/src/digest.ts`:

```swift
"context_thrash": "Context thrash",
```

### Step 5 — Test both directions

The negative test matters as much as the positive one. A rule that fires on everything is worse
than no rule.

```ts
test('context thrash: healthy cache use does not fire', () => {
  const events = Array.from({ length: 20 }, (_, i) =>
    ev({ ts: T0 + i * 30_000, cache_read_tokens: 50_000, total_tokens: 100_000 }));
  assert.equal(detectContextThrash(events, T0).length, 0);
});

test('context thrash: near-total cached re-reads fires', () => {
  const events = Array.from({ length: 20 }, (_, i) =>
    ev({ ts: T0 + i * 30_000, cache_read_tokens: 99_500, total_tokens: 100_000, output_tokens: 40 }));
  const found = detectContextThrash(events, T0);
  assert.equal(found.length, 1);
});

test('context thrash: keys are stable across runs', () => {
  const a = detectContextThrash(events, T0);
  const b = detectContextThrash(events, T0 + 999_999);   // different "now"
  assert.deepEqual(a.map(x => x.anomaly_key), b.map(x => x.anomaly_key));
});
```

### Step 6 — Exercise it in the seeder

Real logs may never trigger your rule. Add a block to `packages/core/src/cli/seed.ts` that
deliberately produces the pattern, so a demo shows it. Follow the existing blocks.

### Step 7 — Verify end to end

```bash
pnpm test
pnpm seed:purge && pnpm seed
sqlite3 ~/.vole/vole.db "SELECT source, rule, COUNT(*) FROM anomalies GROUP BY 1,2;"
```

Run `pnpm collect:once` twice — the anomaly count must not grow. If it does, your `anomaly_key`
is unstable.

---

## Adding a model rate

Rates are data, not code: `packages/core/src/data/pricing.json`:

```json
{
  "models": {
    "gpt-5.1-codex-max": { "input": 1.25, "output": 10.0, "effective_from": "2026-08-30" }
  }
}
```

Then remove it from the `unpriced` map in the same file if listed. New rows are priced at once,
and rows stored before the rate existed are priced the next time the collector starts
(`repriceUnpriced()` in `db.ts`) — no manual backfill.

Cache multipliers are model-independent by default (read 0.1×, 5m write 1.25×, 1h write 2×). A
model whose provider prices cache reads differently sets a flat `"cache_read": <$/MTok>` on its
entry, which replaces the read multiplier for that model only. Dated snapshot ids
(`claude-haiku-4-5-20251001`) resolve to their alias's rate, so only the alias needs an entry.

The same file's `context_windows` map gives each model's window in tokens; it drives the
`context_pressure` rule and the context gauge in `pnpm top` / the MCP live-session view. Add a model there only when its window is
published — an unknown window is skipped, never guessed.

A per-installation override (`~/.vole/pricing.json`, or `$VOLE_PRICING`) merges over the built-in
table — add rates there without touching the repo.

Always run `pnpm verify` afterwards. It re-implements the formula independently and will catch a
mistyped rate. If you add a rate to `pricing.json`, mirror it in the `RATES` table at the top of
`packages/core/src/cli/verify.ts` — that copy is deliberate, so a typo in the product's rate is
caught instead of cancelling out.

---

## Adding a panel to the app

A panel is a read model in core (so it is tested, and reachable from the CLIs and MCP), the same
query ported to Swift, and a view.

### Step 1 — Query in core

`packages/core/src/queries.ts`:

```ts
export interface SessionRow {
  session_id: string; tool: Tool; calls: number; tokens: number; started: number;
}

export function getTopSessions(db: DB, range: Range, includeSeed: boolean): SessionRow[] {
  const from = rangeStart(range);
  const seedClause = includeSeed ? '' : " AND source = 'live'";
  return db.prepare(
    `SELECT session_id, tool, COUNT(*) AS calls,
            COALESCE(SUM(CASE WHEN confidence != 'activity_only' THEN total_tokens END), 0) AS tokens,
            MIN(ts) AS started
     FROM usage_events
     WHERE ts >= ? AND session_id IS NOT NULL${seedClause}
     GROUP BY session_id ORDER BY tokens DESC LIMIT 10`
  ).all(from) as SessionRow[];
}
```

> Note the `confidence != 'activity_only'` guard. **Every** token aggregate needs it, or tools
> that record no tokens quietly distort the result.

Add a test in `queries.test.ts`, and expose it as an MCP tool in `cli/mcp.ts` if an agent could
use it.

### Step 2 — Port it to Swift

`apps/mac/Sources/Vole/DB.swift` — the same SQL, character for character where possible, on the
existing `run(_:_:_:)` helper:

```swift
struct SessionRow: Identifiable {
    let sessionID: String, tool: String, calls: Int, tokens: Int, started: Int
    var id: String { sessionID }
}

func topSessions(_ r: DateRange) -> [SessionRow] {
    var out: [SessionRow] = []
    run("""
        SELECT session_id, tool, COUNT(*),
               COALESCE(SUM(CASE WHEN \(tf) THEN total_tokens END), 0), MIN(ts)
        FROM usage_events WHERE ts >= ? AND session_id IS NOT NULL AND source = 'live'
        GROUP BY session_id ORDER BY 4 DESC LIMIT 10
        """, [r.startMs()]) { row in
        out.append(SessionRow(sessionID: colText(row, 0) ?? "", tool: colText(row, 1) ?? "?",
                              calls: colInt(row, 2), tokens: colInt(row, 3), started: colInt(row, 4)))
    }
    return out
}
```

Then add a `topSessions` property to `Store.swift` and set it inside `refresh()`.

### Step 3 — View

`apps/mac/Sources/Vole/DashboardView.swift` — a `Section` in the relevant pane, standard controls,
nothing custom:

```swift
Section("Top sessions") {
    ForEach(store.topSessions) { s in
        LabeledContent {
            Text(Fmt.compact(s.tokens)).monospacedDigit()
        } label: {
            Label { Text(s.sessionID.prefix(8)) } icon: { ToolIcon(tool: s.tool, size: 14) }
        }
    }
}
```

### UI checklist

- Numbers use `.monospacedDigit()` so columns stay comparable.
- `NULL` renders as `—` via `Fmt.compact` / `Fmt.money`, never `0`.
- Non-exact data carries `ConfidenceBadge`.
- Colours are the system palette or `Pal.series(tool)`; status colours stay reserved.
- Empty state says what to do (see `SetupCard`), not just "no data".
- Run `swift run Vole --dump` to check the new query against the real file before wiring the view.

---

## Changing the schema

The database is disposable — it rebuilds from source logs — so there is no full migration system.
`openDb()` in `db.ts` does run a tiny `migrate()` that **adds new nullable columns** to existing
databases (that is how `user`/`machine` landed), so the common case is painless. Anything more
(renaming, re-typing, backfilling) still requires a rebuild.

1. Edit `SCHEMA` in `packages/core/src/schema.ts`.
2. Update `UsageEvent` / `Anomaly` in `types.ts`.
3. Update the `INSERT` statements in `db.ts` (both column list and `@named` params).
4. New nullable column? Add it to `migrate()` and existing databases pick it up automatically.
   Anything else, rebuild:

```bash
rm ~/.vole/vole.db*
pnpm collect:once && pnpm seed
```

If you need real migrations later, see [ROADMAP.md](ROADMAP.md).

---

## Tuning rule thresholds

Every threshold is a named constant at the top of its rule file:

```ts
const WINDOW_MS = 10 * 60 * 1000;
const MIN_TOKENS_IN_WINDOW = 20_000;   // floor: below this a "spike" is noise
const SPIKE_MULTIPLE = 3;
```

To see the effect of a change:

```bash
sqlite3 ~/.vole/vole.db "DELETE FROM anomalies;"
pnpm collect:once
sqlite3 ~/.vole/vole.db "SELECT rule, severity, COUNT(*) FROM anomalies GROUP BY 1,2;"
```

Two principles worth preserving:

**Keep the absolute floor.** Ratios alone fire on trivial data — 3 errors out of 4 calls is a quiet
session, not an incident.

**Keep baselines leave-one-out.** `medianExcluding()` stops an outlier inflating the baseline it is
measured against. Reverting to a plain median makes lone spikes invisible, which is the exact
failure this project was built to catch.

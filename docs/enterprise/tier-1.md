# Tier 1 — Ship it, stop lying, and cut the four seams everything else hangs on

[← Enterprise roadmap index](../ENTERPRISE-ROADMAP.md) · 24 features

Nothing in this roadmap is demonstrable while the packaged app fatalErrors on launch, the Codex
collector overwrites its own rows, detection burns fifteen seconds per poll at fleet scale, and
SECURITY.md's no-network claim is false. This tier is short by design — weeks, not a quarter — and
contains only two kinds of work. First, the ship blockers: a bundled .app that actually launches,
a committed .icns so `sharp` disappears, a pinned Node in the SEA build instead of whatever the
builder's `process.execPath` happened to be, `busy_timeout` with a read-only open path, the Codex
event_key rewrite, the tools-union widening upsert, and an anomaly upsert with a separate
escalation channel so a warn can become a critical. Second, the four seams every later tier
attaches to: the `onEntry` hook in all six content-bearing collectors (the only place content will
ever exist), a widened `CollectorResult`, a numbered `schema_migrations` path with `user_version`
shared with DB.swift, and a scanner cadence lane with its own `scan_state` so filesystem discovery
never joins the five-second poll. It ends with `collector_runs` and a per-collector heartbeat,
because today one collector writes the heartbeat and every non-Claude user sees 'Setting up…'
forever. A design partner cannot install anything until this tier is done, and every feature in
tiers 2 through 8 would otherwise re-parse transcripts per rule and re-invent the same seam badly.

Legend: `category` · `buyer` · effort **S**/**M**/**L**/**XL** · feasibility (*exact* =
readable from local data today, *partial*, *new instr.* = needs something written that does
not exist, *network* = crosses the network line) · value 1–5, 5 meaning a security lead blocks
the rollout without it. `unscored` came from a completeness sweep and skipped the verifier.

---

### 1. Anomaly upsert with a separate escalation channel

`Behaviour` · `CISO` · **M** · exact · 5/5

db.ts:137 INSERT_ANOMALY is INSERT OR IGNORE on a stable anomaly_key, so severity, observed,
baseline and detail freeze at first sight while the 10-minute window is still open under 5-second
polling: a window first seen at 3.1x (warn) that ends at 8x stays warn forever and the one desktop
notification fired at the lower level. Convert to ON CONFLICT(anomaly_key) DO UPDATE SET
severity/observed/baseline/threshold/detail/window_end WHERE excluded.observed >
anomalies.observed OR severity_rank(excluded.severity) > severity_rank(anomalies.severity),
keeping anomaly_key deterministic and free of now().

**In the app** — Dashboard > Incidents rows stop reading 'warn' on a window that ended critical
and gain a small upward arrow where the severity was raised, whose tooltip names the old and new
figures; the menu-bar glyph tint (liveSeverity) escalates in place;

**Source** — packages/core/src/db.ts:137-146 INSERT_ANOMALY/insertAnomalies; cli/collect.ts:69-73;

**Limit** — Only observed can arbitrate an upgrade cleanly; a ratio rule whose observed falls
while severity rises (error_storm) needs its own comparator or it silently never escalates.

*Corrects the earlier entry "Incident noise controls: window chaining, per-session cap, info
rollup".*

### 2. Union tool names across content-block copies and widen the upsert

`Tool ledger` · `Eng mgr` · **S** · exact · 4/5

Claude Code writes one JSONL line per content block (thinking, text, each tool_use) under the same
message.id with identical usage; claude-code.ts:65-72 keep() retains one copy, so tool names on
the other lines are lost — live DB right now: 7,114 of 14,921 claude_code rows with
stop_reason='tool_use' have tools NULL (47.7%), out of 16,411 claude_code rows. It cannot heal on
a later pass because db.ts:101 only rewrites a row when excluded.total_tokens is STRICTLY greater,
and the sibling copies carry equal tokens.

**In the app** — MenuPanel's top-5 tools list stops under-reporting by half; the Dashboard hover
callout and every per-tool drill-down become countable, and rows that stay NULL after the rebuild
render 'no tool recorded' rather than being absent from the count.

**Source** — packages/core/src/collectors/claude-code.ts:65-72,150-151;
packages/core/src/db.ts:87-101;

**Limit** — Healing only works while the source transcript still exists; Claude Code prunes at
cleanupPeriodDays (unset here, so the tool default applies) and rows older than that stay NULL
forever, so the fix needs a documented one-time rebuild and the UI must distinguish 'no tool
recorded' from 'no tool used'.

*Corrects the earlier entry "tool_calls ledger with tool_result error join and every v1 rule that
counts tool usage; v1 notes only that copies share message.id, under 'Correlation ids: request_id,
turn_id, entry_uuid columns'".*

### 3. verify: report pruned sources, reconcile Grok, and FAIL on an empty store

`Governance` · `Procurement` · **M** · exact · 5/5

cli/verify.ts treats any row whose transcript is missing as a hard failure (claudeNotInLogs === 0
inside the PASS expression at :528-536), but Claude Code prunes transcripts after
cleanupPeriodDays and users delete project directories, so every install older than roughly 30
days fails permanently — this install is 22 days old, which is why nobody has hit it yet.
verify.ts:146 also calls the read-write openDb, so on a fresh clone or with a wrong VOLE_DB it
creates ~/.vole/vole.db, counts zero of everything and prints PASS.

**In the app** — Settings replaces the hard-coded 'Verification: Every stored row reconciled'
string with the last real verify result, its timestamp and the pruned-row count; the same three
figures appear at the foot of every evidence bundle and in the digest.

**Source** — packages/core/src/cli/verify.ts:20-29,146,271,528-536; ~/.claude/.last-cleanup and
cleanupPeriodDays in ~/.claude/settings.json (unset here, so the tool default applies).

**Limit** — A pruned row can never be re-proved from local evidence — it becomes a permanent third
class between pass and fail, and an auditor has to accept 'source deleted by the vendor tool' as
evidence of nothing rather than as evidence of correctness.

*Corrects the earlier entry "History horizon and retention-loss disclosure".*

### 4. Incident figures reach every reader: observed, baseline, threshold

`Desktop` · `CISO` · **S** · exact · 5/5

Principle 3 says incidents are explainable with real figures and the columns are written by every
rule (anomalies.observed, baseline, threshold, detected_at, anomaly_key — schema.ts:42-64), yet no
reader selects them: queries.ts:230 builds IncidentRow without them and DB.swift:227 mirrors that
omission, so the app feed, MCP vole_incidents, the digest and every v1 artefact promising 'the
exact figures that fired' ship a prose sentence and nothing machine-readable.

**In the app** — Incidents list: the existing disclosure row (DashboardView.swift:475) expands to
the fact block plus the anomaly_key, with Why this fired / Copy evidence (JSON including the three
figures) / Show on Timeline buttons; the same three fields appear in vole_incidents, the digest
and the export schema.

**Source** — anomalies.observed/baseline/threshold/detected_at/anomaly_key; queries.ts:226-236
IncidentRow;

**Limit** — INSERT OR IGNORE on anomaly_key (db.ts:137) freezes the first verdict, so observed and
baseline are the values at first sight and not the worst seen — every figure must be labelled 'at
detection', and the templated detail string can disagree with a re-derived figure until an
explicit upsert-on-greater-observed clause and a re-notify path land.

*Corrects the earlier entry "RuleConfig contract, effective threshold in every incident,
conformance tests".*

### 5. Ship-blocker gate: a bundled .app that actually launches

`Platform` · `Platform` · **S** · exact · 5/5

Three defects still make a downloaded build fragile and v1 has no item for any of them, while its
Tier 7 release pipeline assumes a working app. Icon/build.mjs:15 resolves sharp by globbing
node_modules/.pnpm/sharp@*/ — sharp has zero hits in pnpm-lock.yaml and Icon/Vole.icns is
untracked in git, so bundle.sh:37 runs the generator on every fresh clone and require(undefined)
throws; build-sea.mjs:49 copies process.execPath, so a Homebrew Node ships a collector with
/opt/homebrew dylib links that dies after notarisation succeeds;

**In the app** — The app launching from a fresh clone and a fresh account at all, and Settings →
About reporting the real version instead of 0.1.0 on a 0.1.4 build.

**Source** — apps/mac/Icon/build.mjs:15 and the untracked apps/mac/Icon/Vole.icns;
apps/mac/bundle.sh:24,37,58,59;

**Limit** — The code map's top-ranked ship-blocker is already fixed and is corrected here:
Theme.swift now defines `Res`, which looks in Contents/Resources/Vole_Vole.bundle before falling
back to Bundle.module, and all three call sites (VoleApp.swift:51,102 and ToolIcon) go through it
— so the remaining exposure is only that the .module fallback still fatalErrors if a future layout
change drops the bundle, which is exactly what a launch-the-.app CI job catches and static review
does not.

*Corrects the earlier entry "Release pipeline: signed, notarised, SBOM, SLSA provenance, cosign,
Homebrew cask, vole doctor --verify-install".*

### 6. Content boundary as a branded type, with verify --content as its runtime twin

`Governance` · `DPO` · **M** · exact · 4/5

'Vole never stores prompt or tool content' is the load-bearing claim for every DPO conversation,
and today it is an unenforced convention spread across seven collector parse loops where the raw
line is in scope (claude-code.ts:91-99, codex.ts:118, opencode.ts:104, devin.ts:71, grok.ts:102)
-- and the DLP scanner is about to put far more content in scope than exists today. Give the raw
readers a branded return type -- type Content = string & { readonly __content: unique symbol } --
that only hashOf(), classifyOf() and lengthOf() accept, so a UsageEvent or secret_sightings field
can never be assigned a raw line without an explicit, greppable cast.

**In the app** — Settings -> Privacy gains a 'No content stored' card showing the last verify
--content result with its timestamp, the number of casts through the boundary in the shipped
build, and a link to each cast site in the source.

**Source** — The five collector parse loops named above; types.ts UsageEvent;

**Limit** — Casts remain possible and a determined contributor can widen the boundary -- the
control is that every widening is a visible diff in review, not that it is impossible. It also
covers only Vole's own store: the vendor transcripts on the same disk hold the full content and
remain by far the larger exposure, which the card must say beside the green tick.

*Extends the earlier entry "Redaction manifest and verify --content (prove the DB and exports hold
no content)".*

### 7. Detection budget: O(W) baselines and skip-empty polls

`Behaviour` · `Platform` · **S** · exact · 3/5

detect/util.ts:56 medianExcluding copies, filters and sorts the whole window array once per
window, and burn-rate.ts:43 and loop.ts:34 each call it per window, giving O(W^2 log W) per
tool+model per poll — measured 164 ms at 2k windows, 2.4 s at 8k and 15.6 s at 20k, which is
roughly one year of daily use for a single tool+model — while collect.ts:56 re-runs every rule
over the entire usage_events table every 5 seconds even when zero rows were inserted. v1 adds
roughly forty more rules onto that same loop plus scans over tool_calls, findings and posture,
which is arithmetically impossible at 5-second cadence on a laptop.

**In the app** — Nothing visible by design — it is what keeps Settings > Refresh interval honest
and the published CPU/RAM footprint claim defensible; the only user-facing effect is that
Dashboard incident freshness stops lagging by whole poll cycles.

**Source** — packages/core/src/detect/util.ts:56; detect/burn-rate.ts:43;

**Limit** — Skipping detection on empty polls delays purely time-based firings — a window that
crosses a threshold because time passed rather than because rows arrived — until the next insert;
that must be documented and the first pass after startup kept unconditional.

*Corrects the earlier entry "RuleConfig contract, effective threshold in every incident,
conformance tests".*

### 8. Read-model contract and capability-probed navigation shell

`Desktop` · `Platform` · **L** · exact · 2/5

DashSection is a closed four-case enum (DashboardView.swift:190-238) and DB.swift hand-restates
queries.ts although README.md:436 claims a one-to-one port (no zero-fill, limit 100 vs 500, model-
only breakdown), so every new screen costs two divergent implementations. Make each shared read
model a named SQL view created by migrate() in db.ts (v_people, v_agent_inventory,
v_incident_explained, v_coverage) so the Swift port shrinks to `SELECT * FROM v_x WHERE ts >= ?`
plus a row decoder; stamp PRAGMA user_version in migrate() and read it in DB.open;

**In the app** — NavigationSplitView sidebar: 12 rows in three groups, each with a count badge and
a grey 'unavailable' dot; a persistent amber banner in the StaleBanner slot reading 'Database
schema v7, this app reads v5 — Costs and Posture are hidden';

**Source** — apps/mac/Sources/Vole/DashboardView.swift:216 DashSection, DB.swift:139 run() Int-
only binds and the ports at DB.swift:150-274; packages/core/src/schema.ts SCHEMA and db.ts:41-53
migrate() PRAGMA table_info probing (no version stamp today);

**Limit** — A probe proves a table exists, not that its collector ran or that it holds rows — an
empty Data Exposure screen means 'no findings recorded', never 'no secrets leaked', and the two
stay indistinguishable until per-collector run records exist.

*Corrects the earlier entry "Outcomes surfaces: repo/branch panel in the app and vole pr footer".*

### 9. Two-writer safety and a read-only DB open path

`Platform` · `Platform` · **S** · exact · 4/5

db.ts:60 sets no busy_timeout (node:sqlite default 0) and sqlite.ts:59 issues a deferred BEGIN,
while two writers are an explicitly tolerated configuration — Collector.swift:10-12 spawns the
embedded collector next to a possibly running `pnpm collect`. Any overlap yields immediate
SQLITE_BUSY: a poll logs 'pass failed', and the unguarded first runOnce() at collect.ts:155 can
exit the process before polling ever starts.

**In the app** — Removes the silent stall behind MenuPanel's StaleBanner and the 'Setting up'
SetupCard when the collector aborts on a lock; Settings → Database status can then distinguish
'read-only reader attached' from 'collector down'.

**Source** — packages/core/src/db.ts:56,60; packages/core/src/sqlite.ts:59;

**Limit** — A read-only open cannot create or migrate the store, so a reader launched before the
first collect must render 'no database yet' rather than silently creating one — which is exactly
what verify.ts:146 does today and why it prints PASS on an empty DB. busy_timeout only bounds the
wait;

*Corrects the earlier entry "Collector as a launchd agent".*

### 10. Codex collector v2 as a Tier 1 correctness fix: thread state, spawn edges and rollout byte offsets

`Platform` · `Platform` · **M** · exact · 4/5

v1 files Codex collector v2 under Tier 6 platform coverage, but it is the fix for the second-
ranked bug in the repo (codex.ts:197 keys sub-agent rollouts identically to their parent, a
principle-5 violation) and the precondition for any Codex ledger row. ~/.codex/state_5.sqlite
(verified today: 66 threads) carries per-thread id, rollout_path, model, model_provider,
approval_mode, sandbox_policy, git_branch, git_origin_url, cli_version, tokens_used,
reasoning_effort, agent_nickname and a thread_source JSON holding
subagent.thread_spawn.{parent_thread_id, depth}; thread_spawn_edges now has 2 rows, so v1's
warning that it is empty is stale and the parent/child tree is directly readable.

**In the app** — Dashboard → Breakdown shows real Codex model rows instead of em dashes;
repo/branch grouping and pnpm pr stop being Claude-only;

**Source** — ~/.codex/state_5.sqlite tables threads and thread_spawn_edges;
~/.codex/thread_history_1.sqlite tables thread_turns and thread_items;

**Limit** — thread_history_1.sqlite is a partial projection — 6 turns across 66 threads here — so
byte offsets exist only for recent turns and the collector must fall back to size+mtime skipping
for the rest. threads.first_user_message is prompt content and must never be SELECTed.

*Corrects the earlier entry "Codex collector v2: thread metadata, spawn tree, meter cross-check
(Tier 6) — promote to Tier 1 and add thread_turns byte offsets".*

### 11. Annotated timeline: incident marks drawn, UTC buckets rendered in local time, sparkline zero-filled

`Desktop` · `CISO` · **S** · exact · 4/5

README.md:261-263 promises an incident-annotated timeline; DashboardView.swift:13-23 already
computes marks() and then draws nothing but a hover count, so Mark.severity is dead code. Draw one
PointMark per bucket in Pal.severity colour beneath the bars plus a thin incident lane under the
plot, and make a click select that bucket and filter the Incidents list to it.

**In the app** — Overview timeline: severity-coloured marks pinned on the x-axis with an incident
lane below the plot; bars align with the hover callout, which prints the UTC window it aggregates;

**Source** — anomalies.window_start/window_end/severity/rule (schema.ts:42-64) already loaded into
Store.incidents; DashboardView.swift:13 marks(), :36,:57,:69 chart;

**Limit** — An incident pins to the bucket of its window_start, so a burn window straddling
midnight UTC appears once, on the earlier day, and a UTC-anchored bar can still straddle two local
days — true local-midnight bucketing would change the keys in both readers and is a separate,
larger decision.

*Corrects the earlier entry "Incident noise controls: window chaining, per-session cap, info
rollup".*

### 12. Aggregate confidence label: replace MIN(confidence)

`Desktop` · `DPO` · **S** · exact · 3/5

queries.ts:80 and DB.swift:180 both compute a group's confidence as MIN(confidence), relying on
'activity_only' sorting alphabetically before 'exact'. On this machine Grok stores 789 exact rows
alongside 969 activity_only rows, so the summary returns tool='grok' with 168,352,826 tokens
wearing the 'no tokens' badge — a true figure labelled untrustworthy, which is principle 2
inverted. Replace the expression in both readers with `CASE WHEN SUM(confidence !=
'activity_only') = 0 THEN 'activity_only' ELSE 'exact' END` and expose an activityOnlyCalls count
beside it so a mixed group renders as visibly mixed rather than silently rounded to one label.

**In the app** — MenuPanel's top-5 tools list and Dashboard > Breakdown stop showing 'no tokens'
next to a 168M-token Grok row; the mixed case renders 'exact (969 calls without tokens)';

**Source** — packages/core/src/queries.ts:80; apps/mac/Sources/Vole/DB.swift:180;

**Limit** — A two-value enum cannot express 'mostly exact' — constraint 4 forbids adding an
estimated tier even though ROADMAP principle 2 names one — so the call count beside the badge is
the only honest expression of the mix, and a group of one exact row among a thousand activity_only
rows still reads 'exact' with the count telling the reader why.

*Corrects the earlier entry "vole export with versioned public schema (vole.event.v1)".*

### 13. Collector process supervision: the orphan, the exit status, and launchd throttling

`Platform` · `Platform` · **M** · exact · unscored

Confirmed live on this machine right now: two `Vole.app/Contents/MacOS/vole-collector` processes,
both PPID 1, started ten seconds apart, 570 MB RSS each, with no parent Vole.app running —
`Collector.swift`'s own ponytail comment predicts this and calls it "wasteful, not unsafe";
measured, it is 1.1 GB against a 50 MB budget and one of them was sampled at 28.4% CPU. Add a
pidfile at `~/.vole/collector.pid` holding pid + executable path + start time, written by
collect.ts and checked by `Collector.start()`: a live pid whose executable path matches means
adopt, not spawn;

**In the app** — Settings > Footprint gains a Collector row: running / adopted-unmanaged / crashed
(N times today) / not running, with the pid and last exit status.

**Source** — ~/.vole/collector.pid; Process.terminationHandler exit status;

**Limit** — A pidfile is advisory — a SIGKILLed collector leaves a stale one, which is why the
check verifies the recorded executable path and start time rather than liveness alone. Vole cannot
supervise a collector it did not spawn (a developer's hand-run `pnpm collect`), and reports that
case as "adopted, unmanaged" rather than pretending to own it.

*Corrects the earlier entry "Collector as a launchd agent".*

### 14. Ledger scan cursors and insert-gated, bounded-window detection

`Platform` · `Platform` · **M** · exact · 3/5

The ledger is unaffordable under the current poll design: every 5 seconds the collector full-scans
a 507 MB opencode.db (46,584 parts, 12,292 of them tool parts), re-parses every Codex rollout,
then re-runs every rule over the whole usage_events table at O(W² log W) — measured at 15.6 s per
poll at 20k windows. Add ledger_state(source_key, last_cursor, last_scanned_at) and gate detection
on totalInserted > 0 with each rule bounded to a trailing window instead of the full table.

**In the app** — Settings 'Collector' block shows last pass duration, rows scanned and per-source
cursor age; the stale banner distinguishes 'no new data' from 'collector down' instead of showing
'Setting up…' forever.

**Source** — ~/.local/share/opencode/opencode.db part.rowid/time_updated (schema verified today);
collector_state.last_offset/last_mtime;

**Limit** — rowid is not stable across a VACUUM and can be reused after deletes, so the cursor is
paired with a time_updated re-check and a full re-scan is forced whenever max(rowid) goes
backwards.

*Corrects the earlier entry "Collector self-health: collector_runs, vole doctor, coverage matrix,
freshness attestation (Tier 1), which measures the pass but never bounds it".*

### 15. Open the rule and tool enums the app renders

`Desktop` · `Developer` · **S** · partial · 3/5

types.ts:60 declares AnomalyRule as a closed five-value union, Theme.swift:152 maps exactly those
five rule ids to labels, and Theme.swift:142 Labels.order is a hard-coded seven-tool allowlist
iterated by both DashboardView.swift:44 toolTotals and :532 breakdownByTool. Every new rule
therefore renders as a raw snake_case id, and every new tool disappears from the stacked bars and
the Breakdown pane while still inflating yMax, the hover total and the KPI token count — a
silently wrong number rather than a visibly missing one.

**In the app** — Dashboard > Breakdown and the stacked timeline include every tool present in the
data (a Kiro or Copilot row appears the day its collector lands); Incidents shows 'Destructive
command' rather than destructive_command, with the rule's one-line explanation on hover.

**Source** — packages/core/src/types.ts:60-66 AnomalyRule; apps/mac/Sources/Vole/Theme.swift:142
Labels.order and :152 rule labels;

**Limit** — A humanised fallback label is a guess at wording, never at meaning: until a rule is in
the catalogue its incident shows the raw id beside its real figures, which is the honest
degradation. A tool with no logo asset falls back to an SF Symbol in its series colour, so brand
parity lags the data by a release.

*Corrects the earlier entry "Plugin SDK for custom collectors and rules".*

### 16. Honest coverage: per-collector heartbeat, four source states and a coverage strip

`Desktop` · `Platform` · **M** · new instr. · 5/5

collector_state.last_scanned_at is the app's only liveness signal (DB.swift:244 feeding
Store.swift:132-140) and setState has exactly one caller, claude-code.ts:111 — all 621 state rows
on this machine are claude_code — so a Codex-, OpenCode- or Grok-only Mac shows 'Setting up, a few
seconds' forever while rows accumulate behind it, and a collector that goes quiet is invisible.
The one-line fix comes before v1's collector_runs ledger (roughly 17,000 rows/day at a 5s cadence,
needing its own retention): after r.commit?.() in runOnce write a per-tool heartbeat row plus that
collector's notes.

**In the app** — A seven-chip strip pinned under the Overview toolbar and above the MenuPanel
hero: green fresh, amber stale with its last-seen time, grey no artifacts found, red path exists
but unreadable;

**Source** — packages/core/src/cli/collect.ts:36-60 CollectorResult.notes/filesScanned (printed
under --verbose, never persisted); collectors/claude-code.ts:111 setState;

**Limit** — A heartbeat proves the collector ran, not that the tool's store was readable or
complete, so the note must be stored beside it; backlog_bytes exists only for Claude Code because
every other collector re-reads in full, making backlog absent rather than zero.

*Corrects the earlier entry "Collector self-health: collector_runs, vole doctor, coverage matrix,
freshness attestation".*

### 17. Scanner cadence and scan_state, so discovery never joins the 5-second loop

`Platform` · `Platform` · **S** · exact · 3/5

cli/collect.ts runs every 5 s and already re-runs all five detection rules over the entire
usage_events table each pass; the discovery scanners this product needs (codesign per binary, a
Chrome History copy-and-query, a full /Applications walk, launchd plist enumeration) are orders of
magnitude more expensive and must not ride that loop. Add a collector_state-shaped
scan_state(scanner TEXT PRIMARY KEY, last_run_at, last_input_digest, last_duration_ms) table —
like collector_state it carries no source column because it holds no events and is never
partitioned or purged with seed data.

**In the app** — Settings gains a per-scanner row (last run, duration, next due); the Coverage
screen shows a stale marker on any surface whose scanner has not completed within two cadences,
reusing the noData/stale/live vocabulary Store.swift collectorStatus already uses.

**Source** — New scan_state table in ~/.vole/vole.db; directory mtimes and (size, mtime) pairs as
input digests;

**Limit** — Cadence means detection is delayed by up to one cadence: a local model runtime started
and stopped between two scans is never seen, so port and process evidence carries a timestamp,
never a claim of continuity.

### 18. schema_migrations: a numbered, ledgered, single-writer migration path

`Platform` · `Platform` · **M** · exact · unscored

db.ts migrate() is three hand-written PRAGMA table_info probes over two tables, and PRAGMA
user_version on the live store reads 0 — the store cannot say which schema it is. Replace it with
a forward-only numbered list of steps {version, name, kind:'ddl'|'backfill', sql} applied inside
one BEGIN IMMEDIATE with a busy_timeout set (the Node writer sets none today, only journal_mode
and synchronous), then PRAGMA user_version = N interpolated from the step's own literal because
that pragma cannot be parameterised.

**In the app** — Settings → Store: schema version, schema hash, and the last five ledger rows
(version, name, applied_at, duration, rows changed); a red row when a step failed and the store is
mid-upgrade.

**Source** — PRAGMA user_version (0 on ~/.vole/vole.db today), sqlite_schema.sql,
pragma_table_list, packages/core/src/db.ts migrate(), packages/core/src/schema.ts

**Limit** — The ledger can only describe steps applied after it exists. Every store created before
it gets one synthetic row (version 0, name 'pre-ledger', applied_at NULL) and NULL must render as
'unknown', never as a date.

### 19. The upgrade boundary on the Coverage strip: 'not recorded before v0.2', never zero

`Desktop` · `Eng mgr` · **S** · exact · unscored

The failure this prevents is specific and silent: add permission_mode in v0.2 and every chart of
it shows a hard drop to zero on the migration day, because rows older than the column are NULL and
NULL renders as absence. Join the migrations ledger to the data — for each column a migration
introduced, store first_populated_ts (min ts of a row where it is non-NULL) and
unbackfillable_rows from the backfill step — and draw a vertical boundary at that timestamp
carrying the version label. Left of the boundary is shaded and labelled 'not recorded before v0.2
(schema 4, applied 2026-09-14)';

**In the app** — Coverage strip gains one boundary marker per column in view, and the timeline
chart shades the pre-column region instead of plotting zeros; hovering the marker shows the
schema_migrations row that created it.

**Source** — schema_migrations (version, name, applied_at), per-column MIN(ts) WHERE col IS NOT
NULL over usage_events, backfill step's rows_unbackfillable

**Limit** — The boundary is per column, so a screen mixing columns of different vintages has more
than one and the strip must show the oldest boundary affecting the figure on screen. It knows only
that the column changed — it cannot know that the user's mental model of the metric changed with
it.

*Extends the earlier entry "Honest coverage: per-collector heartbeat, four source states and a
coverage strip".*

### 20. Readability matrix: no screen may render a bare zero

`Desktop` · `CISO` · **M** · exact · unscored

A zero on the Shadow AI screen must mean "we looked and found nothing", never "we were not allowed
to look" — absence of evidence rendered as evidence of absence is principle 1 broken in the
direction that gets someone fired. Every read model that can return 0 joins `scan_access` on its
root and returns a `readable` state beside the count, written twice per the read-model parity rule
(queries.ts and the DB.swift port, EXTENDING.md). The view layer then renders three different
things from the same 0: `ok` → "0";

**In the app** — A new Readability table inside the Coverage strip, and the same four-state pill
on every per-surface card of the Shadow AI screen and every source row of the People view. The
menu-bar SetupCard gains a line — "3 of 17 read roots unreadable" — deep-linking via vole:// to
Settings > Permissions.

**Source** — scan_access joined to each read model's root; rendered through the existing null-
formatting path.

**Limit** — The matrix is per root, not per file — one unreadable file inside a readable directory
stays invisible, and a directory that lists but whose children fail to open reads as `ok`. A pill
can be up to one scanner interval stale, which is why the probe age is shown next to it rather
than hidden.

*Corrects the earlier entry "Coverage and denominators: what Vole did not read".*

### 21. collector_runs: a measured footprint budget that names its metric

`Platform` · `Platform` · **M** · exact · unscored

Buyer need #12 asks for "~50MB/1% CPU", and measured on this machine the answer depends entirely
on which counter you publish: one `--once` pass over the real sources reports `peak memory
footprint 50,976,936` and `maximum resident set size 1,071,464,448` from `/usr/bin/time -l` — a
21x gap — while `ps` shows the two live bundled `vole-collector` processes at ~570 MB RSS each.
Add `collector_runs(started_at, duration_ms, rss_peak_bytes, cpu_user_ms, cpu_sys_ms,
files_scanned, events_parsed, exit_status, tier_shed TEXT, source)`, written at the end of each
pass from `process.memoryUsage.rss()` and `process.cpuUsage()` — both node builtins, so the SEA
stays zero-dependency.

**In the app** — Settings > Footprint: sparklines of duration_ms and rss over 24h against a drawn
budget line, plus the current tier state ("all scanners" / "discovery shed since 14:02").

**Source** — process.memoryUsage.rss() and process.cpuUsage() inside collect.ts;
proc_pid_rusage(RUSAGE_INFO_CURRENT).ri_phys_footprint read live by the Swift app.

**Limit** — Node cannot read its own phys_footprint, so the *stored* series is RSS and is roughly
20x pessimistic against Activity Monitor's Memory column; the live phys_footprint is displayed but
never persisted, because DB.swift is a read-only consumer by contract.

### 22. store_version_gate: an older binary opens a newer store read-only and says so

`Platform` · `Platform` · **S** · exact · unscored

An old collector on a new store today is silently wrong rather than broken: openDb() runs
db.exec(SCHEMA) (all IF NOT EXISTS, no-ops), migrate() finds nothing to add, and INSERT_EVENT
writes its old column list, so every column the newer schema added lands NULL — indistinguishable
downstream from 'the source did not carry this field', which breaks principle 1 by upgrade rather
than by parser. Verdicts are worse: anomalies are INSERT OR IGNORE on anomaly_key, so an old
binary's rule semantics win permanently over the new one's.

**In the app** — A blocking banner on every screen: 'This store was written by Vole 0.3 (schema
7); this app knows schema 5.

**Source** — PRAGMA user_version; packages/core/src/db.ts openDb()/INSERT_EVENT/INSERT_ANOMALY;

**Limit** — A downgrade cannot un-write rows, only refuse to read them: rows an older binary wrote
before written_by_schema_version existed carry NULL there and are 'unknown writer' forever.

### 23. Backfill as a declared step: the widening the tokens-only-grow upsert can never perform

`Platform` · `Platform` · **M** · partial · unscored

The upsert rewrites a stored row only when excluded.total_tokens > usage_events.total_tokens, and
its SET list never touches model, session_id, project, git_branch, agent_id, raw_ref, confidence
or source — so a column added today stays NULL on every existing row forever unless something
explicitly UPDATEs it. The only precedent is repriceUnpriced(), which is unbounded, full-table and
runs inside the 5-second poll. Add kind:'backfill' to the F1 ledger: a select naming the still-
NULL rows, rows_per_pass, and a resumable cursor column (last ts completed), applied oldest-first
so the rows nearest the evidence horizon fill before their source disappears;

**In the app** — Settings → Store → Backfill: per pending column, rows filled / rows remaining /
rows unbackfillable, with the pass cursor date and 'paused — collector busy' when a pass yields.

**Source** — packages/core/src/db.ts INSERT_EVENT upsert WHERE clause and repriceUnpriced();
usage_events.raw_ref;

**Limit** — The backfill's ceiling is the evidence horizon and must be printed with it: a row
whose raw_ref file the tool's own cleanup has already deleted can never be filled from anything,
so it is counted as unbackfillable and rendered 'not recorded', never 0.

### 24. Read-model parity check in CI

`Platform` · `Eng mgr` · **S** · exact · 2/5

VoleApp.swift already has a headless --dump that prints a summary, incident count, bucket count
and breakdown count from DB.swift. Turn it into `--dump --json` emitting every shared view's rows,
add `vole query --json <view>` on the TypeScript side, and have the macOS CI job run both against
one fixture database and diff them. This is the only mechanism that keeps a hand-written Swift
port honest as tables multiply, and it would have caught the three parity bugs the code map
already found: no zero-fill in DB.swift's timeseries, a 100-row incident cap in DB.swift against
500 in queries.ts, and breakdown by model only.

**In the app** — No user-visible surface by design; failures appear in CI, and at runtime the
existing schema-version banner is what a user sees when the app and collector disagree.

**Source** — apps/mac/Sources/Vole/VoleApp.swift --dump branch; packages/core/src/queries.ts read
models;

**Limit** — It compares numbers for the manifest views on a fixture database: it cannot catch a
rendering bug, a chart binning bug (the UTC-vs-local issue lives in the view layer, not the
query), or drift in the bespoke screens that stay hand-ported. It only runs on macOS runners, so a
Linux-only CI pass proves nothing about the app.


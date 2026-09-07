# Tier 8 — Fleet, reconciliation and compliance at scale: what an enterprise signs for

[← Enterprise roadmap index](../ENTERPRISE-ROADMAP.md) · 44 features

Everything that crosses a device boundary is last, opt-in and normalised-rows-only, because the
local-first principle is the thing that got Vole through the questionnaire and the works council
in the first place. This tier is the enterprise deal: fleet sync of redacted rows with
SSO/SCIM/RBAC, k-anonymity with complementary suppression for aggregate mode, purpose-bound
queries with a closed purpose union, retention split by data class showing the AI Act six-month
floor against the minimisation ceiling, erasure that survives the next poll with an Art. 19
propagation report, a DSAR export that answers Art. 15(1)(h) with the logic and not just the rows,
a works-council pack with a DPIA pre-filled from measured facts, and a checkpoint chain witnessed
by a sink the buyer already runs — because a hash chain in a developer-writable SQLite is not
tamper-evident against the seat owner and the docs must say so. It also holds the FinOps half that
needs network: `vole reconcile` as the single egress-declared command,
Anthropic/OpenAI/Cursor/Copilot adapters, the `reconcile_gap` rule and the reconciliation coverage
report that says what share of spend is even checkable, all resting on the `cost_basis` stamped at
insert and the unpriced counters that keep aggregates honest. Finally it holds the lifecycle work
an established buyer eventually demands: departure evidence packs, credential residency and
liveness sweeps, `activity_after_departure`, scope-change diffs for movers, device decommission
with seal-attest-erase, and evidence freeze on notice. None of it is the reason anyone buys Vole;
all of it is why they can.

Legend: `category` · `buyer` · effort **S**/**M**/**L**/**XL** · feasibility (*exact* =
readable from local data today, *partial*, *new instr.* = needs something written that does
not exist, *network* = crosses the network line) · value 1–5, 5 meaning a security lead blocks
the rollout without it. `unscored` came from a completeness sweep and skipped the verifier.

---

### 1. Console-blind spend and the shadow_account_spend rule

`Shadow AI` · `FinOps` · **L** · network · 5/5

A local session is console-blind when its exact tokens map to no vendor row for its day, model and
identity. Three classes are already detectable from stored rows: an agent talking to a non-vendor
model (2,661 `claude_code` calls and 559.1M tokens here carry `qwen3.8-27b-fp8`, `glm-5.2`,
`anthropic/claude-ccr-<hex>`, `fable-fusion-27b`, `openrouter/stealth/ox-alpha` — Anthropic's
console will never show one of them); a vendor entitlement consumed through a third party (3,336
OpenCode messages with `providerID='github-copilot'`);

**In the app** — Reconciliation screen right pane 'Console never saw this', plus a dedicated
incident card listing the model set and the token total; the Breakdown gains a 'console-blind'
badge on any model absent from the reconciled vendor's model list.

**Source** — usage_events (tool, model, cost_usd IS NULL, session_id) joined to vendor_ledger and
vendor_identities; ~/.claude-code-router/ and settings `env.ANTHROPIC_BASE_URL` as corroborating
evidence.

**Limit** — 'Console never saw it' is provable only for a window and identity the reconcile
actually pulled; without a successful pull the rule must not fire at all, and under a subscription
plan it can never fire for Anthropic.

### 2. cost_basis stamped at insert, with unpriced counters in every aggregate

`FinOps` · `FinOps` · **M** · exact · 5/5

`cost_usd` today mixes three incompatible definitions with no marker: Anthropic list-equivalent
for claude_code via computeCost, OpenCode's own provider bill for opencode rows (opencode.ts:143),
and genuine zero for free models — and getSummary runs a bare `SUM(cost_usd)` that adds $1,778.48
of list-equivalent value to $580.26 of provider-reported dollars and calls the result one KPI.
Worse, that SUM silently drops 4,723 of 29,284 live rows (16%) whose cost is NULL, including 3,550
exact-confidence rows (claude_code 2,678, codex 83, grok 789) representing real tokens whose model
has no rate.

**In the app** — Every cost figure in MenuPanel, the Dashboard KPI tile and Breakdown gains a
basis chip; a mixed roll-up renders 'mixed basis' with a tap-through split, and the unpriced count
sits beside the total as '$1,778.48 · 2,678 calls unpriced' instead of an unqualified dollar
figure.

**Source** — packages/core/src/queries.ts:56,79,294,459,615 SUM(cost_usd); pricing.ts computeCost
and unpricedReason;

**Limit** — Existing rows have no basis and must migrate as NULL rather than be guessed, and since
the upsert only rewrites a row when total_tokens strictly grows, backfilling basis on historical
rows needs an explicit one-shot widening UPDATE keyed on event_key, not the normal collect loop.

*Corrects the earlier entry "Contract rate cards, rate_source labelling and seat-price
comparison".*

### 3. DSAR export that answers Art. 15(1)(h): the logic, not just the rows

`Governance` · `DPO` · **M** · exact · 5/5

v1's 'vole dsar export' ships the subject's rows plus the manifest and policy; Art. 15 also
requires categories, recipients, the retention period and, for anything resembling automated
evaluation, meaningful information about the logic involved.

**In the app** — Privacy Center → 'Export my data' producing the bundle with a preview listing its
sections; every row in the existing Incidents feed gains a 'Why this fired' disclosure showing the
same three figures — the same disclosure a security lead wants for triage.

**Source** — anomalies.observed/.baseline/.threshold/.rule/.window_start/.window_end (stored,
never read); rule thresholds today hard-coded as module constants at burn-rate.ts:4-7,
loop.ts:4-8, error-storm.ts:4-6, rate-limit.ts:4-5, context-pressure.ts:5-7;

**Limit** — Incidents detected before rule-version stamping existed can only cite today's
thresholds and must be labelled 'thresholds not recorded at detection time'. INSERT OR IGNORE at
db.ts:137 freezes the first verdict, so observed is the value at first sight rather than the worst
value in the window, and the export has to say which.

*Extends the earlier entry "Data-subject access and erasure: vole dsar export and vole forget".*

### 4. Enterprise demo story: seed --story, an unmissable demo bar and a guided tour

`Desktop` · `Eng mgr` · **M** · exact · 3/5

cli/seed.ts produces one implicit user, one project and four rule firings — nothing a security
buyer wants to see. Add `pnpm seed --story=enterprise`, still writing only source='seed',
generating twelve pseudonymous employees across three machines, an unsanctioned Grok CLI on two
hosts, three secret findings at different lifecycle states, a bypassPermissions session with a
destructive command and a quota-exhausted day: enough to populate every screen. The app gains a
demo-mode bar that is impossible to miss, extending the existing 'Demo Data' toolbar item
(DashboardView.swift:325), plus a scripted six-stop tour, and every export path refuses seed rows
so a demo can never become evidence.

**In the app** — A persistent striped bar across the top of the window whenever any visible row is
seed, with a 'Purge demo data' button; Cmd-Shift-D starts the tour, which walks Overview → Shadow
AI → Data Exposure → Live Sessions → Incidents → Evidence bundle with a caption per stop.

**Source** — cli/seed.ts source='seed' rows and purgeSeed in db.ts; the seedClause appended by
every production query;

**Limit** — Seed data is fiction and must never appear in an evidence bundle, a posture coverage
ratio or an exported metric — the only guard is the source column, and getSessionDetail
(queries.ts:399) has no source clause today, so drill-downs leak seed rows until that is fixed.

*Extends the earlier entry "vole.computer static site with docs, downloads, changelog, signed
appcast, demo page and status monitor".*

### 5. Per-active-agent-host meter, computed and auditable offline

`Platform` · `Procurement` · **S** · exact · 3/5

v1 prices per seat; the research supports per active agent host, flat, at roughly $7-10/month with
a free tier at ten hosts, because that is what Fleet ($7/host) and the 'AI Usage Control' budget
line (+73% to 2027) support, and because a seat count cannot be verified from a laptop while an
active host can. Ship `vole hosts --range=30d`: COUNT(DISTINCT user || '@' || machine) over
sessions with at least one live row, plus the underlying rows, so a customer audits their own
invoice without contacting anyone — no activation call, no phone-home, the same figure on the
invoice derivable from their own database.

**In the app** — Settings → Licence shows the 30-day active-host count with a 'show the rows'
disclosure and the edition (Core / Enterprise / Fleet), and states in one line that collection,
rules and every read model behave identically in all three.

**Source** — usage_events.user and usage_events.machine — two columns db.ts:19-35 stamps on every
row at insert and that no query in queries.ts or DB.swift has ever selected

**Limit** — A host that never runs the collector is never counted, so the meter is a floor and
never an inventory; the MDM's own device list is the expected set to reconcile against.

*Corrects the earlier entry "docs/PACKAGING.md: three editions and per-seat pricing".*

### 6. principal_lifecycle: a declared state, never an inferred one

`Identity` · `CISO` · **S** · exact · unscored

An append-only principal_lifecycle(principal_id, state
active|departing|departed|scope_changed|suspended, effective_from, effective_to, declared_by,
basis, decl_hash, source, first_seen, last_seen) sourced from a new lifecycle[] block in
~/.vole/policy/identity.json (managed mode) or an explicit `vole lifecycle set` (personal mode);
one row per declaration, never updated in place, so the state at any past instant is a query
(latest effective_from <= t), not a mutable column. Nothing in the codebase may write this table
from observation: silence means the collector was off, the tool's retention pruned the source, or
the person was on leave — it never means departed.

**In the app** — People view gains a state chip beside each principal (Active / Departing since /
Departed / Moved) whose popover shows declared_by, basis, effective_from and the decl_hash; a new
Lifecycle screen lists declarations chronologically.

**Source** — ~/.vole/policy/identity.json (new lifecycle[] block); `vole lifecycle set` CLI;

**Limit** — Vole cannot know anyone left a company. It records who said so, when, and on what
basis.

### 7. Departure evidence pack: one principal, one window, a denominator on every figure

`Export` · `CISO` · **L** · exact · unscored

`vole pack --principal <id> --window 30d --basis <text>` is the existing incident-bundle and
export machinery scoped to one principal and one window, writing a packs(pack_id, principal_id,
window_start, window_end, basis, purpose, created_at, row_counts_json, chain_head) row and the
checkpoint-chain head over what it emitted.

**In the app** — Lifecycle screen action 'Build departure pack', opening in the just-in-time
evidence viewer with the existing pre-export field preview and re-identification scan, a coverage
column per section, and the not-covered list rendered before the export button is enabled.

**Source** — vole.db only — usage_events, tool_calls, secret_sightings, dlp_egress, context_edges,
ai_surfaces, grants/overrides, anomalies, collector_runs, evidence_freeze; no new disk read

**Limit** — It proves what the agents recorded while the collector ran, not what the human did —
browser chat, phone, personal laptop and any tool with no collector are absent by construction and
are named in a 'not covered' section. A window whose source was pruned reads 'source deleted',
never 'no activity'.

*Extends the earlier entry "Compliance evidence pack export".*

### 8. Credential residency and liveness sweep: the rotation worklist at exit

`Posture` · `CISO` · **M** · partial · unscored

At a departing or departed declaration, enumerate where provider credentials still live on this
device — names and metadata only, never a value. Reads ~/.codex/auth.json auth_mode ('chatgpt'
here), last_refresh (2026-09-07T05:08:23Z here), presence booleans for OPENAI_API_KEY and
tokens.account_id; Keychain service names from `security dump-keychain` attributes, which on this
machine list Claude Code-credentials, Cursor Safe Storage, Grok Bot Safe Storage,
com.anthropic.operon-cli and com.local.gemini-gateway-for-claude;

**In the app** — Lifecycle panel section 'Rotate on exit': one copyable row per credential with a
state chip (live OAuth, refreshed <date> / key name present / no use observed) and a link to the
sessions that used that provider.

**Source** — ~/.codex/auth.json (auth_mode, last_refresh, key presence); security dump-keychain
attribute names;

**Limit** — A name is not a valid credential and absence is not proof one was never there. A
locked keychain or a missing Full Disk Access grant yields NULL, not zero.

*Extends the earlier entry "key_residency: naming where else this key lives, so a spend gap stops
being a mystery".*

### 9. Departure delta against the principal's own baseline, purpose-gated

`Data exposure` · `CISO` · **M** · exact · unscored

Inside the pack only, and only for a principal whose declared state is departing or departed: a
table comparing the last N days against that same principal's prior 90-day median in exposure-
relevant counts alone — secret_sightings by class, dlp_egress destinations, off-device pushes from
context_edges and agent_pushed_data_off_device, repositories first touched in the window, package
installs, VCS pushes to non-corporate remotes, and unsanctioned surfaces first seen. No composite
score, no cross-person ranking, no output or productivity axis; the inalienable exclusion floor
stays in force and the table refuses to render when either window's coverage fraction is below the
pack's floor.

**In the app** — A section inside the departure-pack preview, deliberately unreachable from the
People view or any live screen, with both windows' coverage fractions printed beside every pair of
figures.

**Source** — secret_sightings, dlp_egress, context_edges, tool_calls, VCS/package action ledgers,
usage_events.project — all existing rows, no new read

**Limit** — A change in counts is not intent. A quiet baseline can mean the collector was off or
the tool's retention pruned the window, and the same delta appears when someone simply finished a
project and started another.

### 10. Costs screen and `vole showback` with the coverage fraction attached to every total

`FinOps` · `FinOps` · **L** · exact · 4/5

The app's cost KPI is `SUM(cost_usd)` in DB.swift:161, which silently drops the 16% of rows with
no price, so the headline understates and nobody can tell. Give Costs its own screen where every
total reads 'across N of M calls; P unpriced (<reason>)' using pricing.ts unpricedReason, with
breakdown dimensions that already exist as columns but have never been grouped: `user` and
`machine` (stamped on all 29,284 rows since day one and selected by no query), project/repo,
agent, model, tool and confidence.

**In the app** — A Costs screen with a totals header carrying the coverage fraction inline, a
stacked bar with a dimension picker (user/machine/repo/agent/model), and a table whose unpriced
rows render an em dash and a reason chip instead of $0.00;

**Source** — usage_events.{user, machine, project, model, tool, agent_id, cost_usd, cost_basis,
confidence}; pricing.ts unpricedReason and data/pricing.json;

**Limit** — This is equivalent API value, not an invoice: subscription seats, Bedrock/Vertex
routing and non-Anthropic list rates are not modelled, and cost is not date-aware because
pricing.json's effective_from is never read.

*Extends the earlier entry "Repo identity and attribution keys (repo slug, team, ticket)".*

### 11. Erasure that survives the next poll, plus an Art. 19 propagation report

`Governance` · `DPO` · **L** · partial · 5/5

v1's 'vole forget' deletes rows and will not work: only the Claude Code collector is incremental
(byte offsets in collector_state, all 513 rows claude_code), while Codex (codex.ts:72), Grok
(grok.ts:75), OpenCode (opencode.ts:53), Devin (devin.ts:30), Cursor (cursor.ts:32) and
Antigravity (antigravity.ts:21) re-read their entire source every poll and ignore the _db
argument, so erased rows reappear within one five-second cycle. v1 spotted exactly this for prune
and added a per-tool pruned_before_ts, but erasure is keyed by subject or session rather than by
time and a timestamp watermark cannot express it.

**In the app** — Privacy Center → 'Erasure requests': scope, requested date, rows deleted at the
time, and rows suppressed at ingest since — the last column being the proof the erasure still
holds. Beside it 'Where your data went': one row per sink with target, last send, row count and a
recall verdict with its reason.

**Source** — db.ts insertEvents / insertAnomalies (the single write path), the six full-re-read
collectors named above, collector_state byte offsets for Claude Code; export_state / sync_log
written by the SIEM forwarder and evidence-pack features;

**Limit** — Erasure in Vole is not erasure on the machine — the underlying transcript in
~/.claude/projects or ~/.codex/sessions still holds the content, and deleting those breaks 'claude
--resume'. Rows in a signed zip on someone's laptop, or a batch a Splunk HEC endpoint already
accepted, cannot be recalled, and the report says so rather than pretending otherwise.

*Corrects the earlier entry "Data-subject access and erasure: vole dsar export and vole forget".*

### 12. Reconciliation screen with a state chip on every cell

`Desktop` · `FinOps` · **L** · network · 2/5

A three-pane screen — vendor ledger, local ledger, delta — where no cell ever shows a bare number:
each carries its unit, its basis and one of six state chips (matched, vendor-only, local-only,
units-differ, not-comparable, stale). Cells drill to the contributing sessions on the local side
and to the group_by and bucket boundary on the vendor side. It needs both read models written
twice per constraint 13, and the UTC-bucket-drawn-with-local-calendar bug (DashboardView.swift:69)
must be fixed first or daily reconciliation rows land in the wrong local day west of UTC — the
exact failure mode that would make a correct reconciliation look broken.

**In the app** — A 'Reconciliation' item in the Manage group, opening on the coverage report until
a vendor pull has run, then on the delta table with the quota card and identity chip in the
header.

**Source** — vendor_ledger, vendor_identities and billing_units tables joined to usage_events; new
queries.ts read models ported to DB.swift.

**Limit** — Every figure is as fresh as its slowest input — a Copilot column is roughly two days
stale by construction and must render its own age, not the screen's — and rows the vendor prices
but Vole cannot (Codex and Grok carry NULL cost_usd on every row here) show 'not comparable',
never a zero delta.

### 13. store_budget: measured bytes per table and index, and the indexes no read model plans through

`Platform` · `Platform` · **M** · exact · unscored

One row per schema object refreshed on the scanner cadence, never in the 5-second loop: object,
kind (table|index), bytes from dbstat (SELECT name, SUM(pgsize) FROM dbstat GROUP BY name — 4 ms
on this store), rows, bytes_per_row, and a used_by_reads count from EXPLAIN QUERY PLAN run over
each registered read model. Measured here without prompting: usage_events is 11.27 MB over 29,969
rows = 376 B/row, its five indexes are 5.48 MB = 183 B/row, so 32% of the 17.2 MB file is index,
the -wal adds 6.0 MB and -shm 32 KB, and file total (page_count × page_size) is the only figure
any surface could show today.

**In the app** — Settings → Store: a bar per object sorted by bytes, the three real file sizes (db
/ wal / shm from stat), and 'days of headroom at the last 7 days' measured growth' which stays
blank until seven daily snapshots exist.

**Source** — dbstat virtual table, PRAGMA page_count/page_size/freelist_count, pragma_table_list,
stat() on ~/.vole/vole.db, -wal and -shm; packages/core/src/queries.ts and the DB.swift ports as
the registered read-model set

**Limit** — dbstat is a compile-time option — present in the Node 26.7.0 / SQLite 3.53.4 here
(pragma_compile_options shows ENABLE_DBSTAT_VTAB), but the SEA freezes whatever Node the builder
ran, so the probe runs at runtime and per-object bytes go NULL, never estimated or divided evenly,
leaving only the file total.

*Extends the earlier entry "Collector self-health: collector_runs, vole doctor, coverage matrix,
freshness attestation".*

### 14. Evidence freeze on notice: hash the sources before they age out

`Export` · `CISO` · **M** · exact · unscored

On this machine 1,758 of 1,758 Grok rows already reference a ~/.grok/logs file that no longer
exists, while 570 Claude, 83 Codex, 204 Devin and 10,885 OpenCode source paths still resolve — and
the oldest surviving Claude transcript (2026-08-15) is six weeks newer than ~/.claude.json
firstStartTime (2026-07-02). So the moment a departing or departed declaration lands, one bounded
pass walks the distinct raw_ref paths behind that principal's rows in the window and writes
evidence_freeze(freeze_id, principal_id, declared_at, path, exists, size_bytes, mtime, sha256,
consumed_to_offset, rows_referencing, source) — file metadata and a digest, never a byte of
content, so the content boundary holds.

**In the app** — A Freeze card on the principal's Lifecycle panel: 'Frozen 2026-09-07 — 11,208
rows, 1,752 sources hashed, 10 already gone', broken down per tool, with a Re-freeze action that
appends.

**Source** — usage_events.raw_ref paths (~/.claude/projects/**.jsonl,
~/.codex/sessions/**/rollout-*.jsonl, opencode.db, Devin acp-messages/*.db); fs stat + sha256 over
those files

**Limit** — A digest proves the file's bytes at freeze time, not at event time, and a source
deleted before the freeze is gone for good — the pack must then say 'source deleted', never 'no
activity'. Hashing is I/O, so it runs under the same byte budget as the DLP scanner and records
sha256=NULL with reason='budget' rather than stalling a poll.

### 15. activity_after_departure: the credential that outlived the person

`Identity` · `CISO` · **S** · exact · unscored

A pure rule over rows the store already holds: for any principal whose latest declaration at time
t is 'departed', any live usage_event, tool_call or surface_activity row with ts > effective_from
on this device fires, with anomaly_key = 'live:activity_after_departure:<principal_id>:<UTC day
bucket>:<tool>' — deterministic, no now() in the key (constraint 3), one incident per principal
per day per tool. It fills the three explainability columns nothing selects today: observed = rows
after the declaration, baseline = the principal's rows in the seven days before it, threshold = 0.

**In the app** — Red banner on the principal's Lifecycle panel plus a standard incident card with
its figures; the row counts into the menu bar's security count and into acting-now when the
session is live.

**Source** — usage_events.ts / tool_calls / surface_activity joined to
principal_lifecycle.effective_from; no new disk read

**Limit** — A shared laptop, a CI runner or a sudo session under the leaver's OS account produces
identical rows — the principal_conflict guard tags those and the incident says 'attributed weakly'
instead of naming a person. The rule keys on the event's own ts, not on ingest time, so a re-read
of an old source after the declaration is not counted as new activity.

### 16. Scope-change diff for movers, with a residual-reach column

`Posture` · `CISO` · **M** · exact · unscored

A 'scope_changed' declaration with an effective_from triggers a diff computed from ledgers already
in the store, never from a policy statement: projects and repositories touched, MCP endpoint
identities registered, grant/override entries with the file that granted each authority, remote-
execution destinations from context_edges, secret-store retrievals, and each surface's sanctioned
state. Adds the view v_scope_diff(principal_id, effective_from, dimension, value, before_window,
after_window, state kept|added|removed|residual).

**In the app** — Two-column before/after panel on the Lifecycle screen with 'Residual reach'
pinned at the top, each row linking to the exact file and entry that grants it, and a 'no before'
state when the move predates the collector.

**Source** — grant/override ledger (settings.json, settings.local.json, .mcp.json, managed
policy), ai_surfaces, context_edges, action_targets, usage_events.project — all already in vole.db

**Limit** — Reachability here is what local configs and past actions show, not what the IdP or the
repo host authorises; a permission granted server-side and never exercised locally is invisible,
so 'residual' is a floor and never the full entitlement set.

### 17. vendor_identities: mapping a local session to a console row

`Identity` · `DPO` · **M** · partial · 3/5

Reconciliation against a vendor console is impossible until a local session maps to a console row,
and every vendor keys on something different (email, accountUuid, api_key_id, chatgpt account_id,
Cursor userId, GitHub login). Add `vendor_identities(vendor, local_key_kind, local_key,
vendor_id_kind, vendor_id_hmac, plan, org_id_hmac, auth_path, first_seen, last_seen,
evidence_artifact)`, filled from disk only: ~/.claude.json oauthAccount.{accountUuid,
organizationUuid, organizationType, billingType, organizationRole}; transcript type:'bridge-
session'.{ownerAccountUuid, ownerOrganizationUuid};

**In the app** — Settings → Identity: one row per detected account showing vendor, plan, auth
path, org role and the sentence 'this is how your sessions map to the console', with a copy-hash
action for support; the same chip appears in the Reconciliation screen header.

**Source** — ~/.claude.json oauthAccount (all fields confirmed present);
~/.claude/projects/**/*.jsonl type:'bridge-session' (18 files here);

**Limit** — An HMAC over a few hundred known employee emails or account ids is reversible by
whoever holds the key, so the hash is a join key and not a privacy control — pseudonymity comes
from not storing the value at all.

*Extends the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 18. Cache economics with the 5m-versus-1h split, and the burn-rate rule that ignores multipliers

`FinOps` · `FinOps` · **M** · exact · 4/5

Cache is the largest single cost lever and Vole mishandles it in three places today:
getLiveSessions computes rewarm_cost as always ×write5m (queries.ts:340) even for 1h writes billed
at 2.0×; the burn-rate rule scores raw `total_tokens` including 0.1×-priced cache reads, which is
why 188 of 244 live incidents fire on windows that are ~99% cache reads; and no view separates the
three multipliers at all.

**In the app** — A Cache economics card on the Breakdown and Reconciliation screens: four token-
class bars with their multipliers, the read/fresh ratio, re-warm cost split by TTL class, and a
vendor-confirmed tick on the 5m/1h split once a pull has run.

**Source** — usage_events.{input_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
cache_read_tokens}; data/pricing.json cache_multipliers {read 0.1, write5m 1.25, write1h 2.0} and
the per-model flat cache_read override;

**Limit** — Only Claude Code splits the two TTL classes on disk: Codex reports
cache_write_input_tokens as a single field (and codex.ts:204 hard-codes it to 0 today), OpenCode
reports one cache.write number, and Grok reports only cached_prompt_tokens — so the 5m/1h split is
NULL for three of the four token-bearing tools and no vendor confirmation is possible there.

*Corrects the earlier entry "Cache re-warm incident and 1h-vs-5m TTL premium audit".*

### 19. Retention split by data class, with the AI Act floor shown against the minimisation ceiling

`Governance` · `DPO` · **S** · exact · 4/5

v1 has one 'vole prune --keep=90d'. Privacy needs classes whose pressures point in opposite
directions: behavioural rows (usage_events) minimise downward; incident evidence (anomalies,
findings) has an upward floor wherever the org has declared itself a deployer under EU AI Act Art.

**In the app** — Privacy Center → 'Retention' table: class, days, reason, oldest row held, next
prune; a red row when a declared floor exceeds the configured value.

**Source** — usage_events, anomalies, collector_state, plus the audit/access/collector_runs
tables; ~/.vole/policy.json retention block;

**Limit** — Vole does not know whether the org is a deployer of a high-risk AI system, and whether
a deterministic rule engine even falls under Annex III 4(b) is unsettled — Annex III obligations
were deferred to 2027-12-02 by Regulation (EU) 2026/1744. The floor is a value the profile
declares;

*Extends the earlier entry "Historical rollups, retention prune, bounded detection window and
legal hold".*

### 20. Measured reclaim: VACUUM INTO a scratch copy is the measurement, the in-place VACUUM is the decision

`Platform` · `Platform` · **S** · exact · unscored

The obvious gate is freelist_count, and on this store it is wrong: freelist_count reads 0 yet a
full VACUUM still took the file from 4,198 to 4,036 pages — 663 KB reclaimed by defragmentation
alone, in 60 ms. So the honest sequence is: check free disk ≥ file size, VACUUM INTO a scratch
path (28 ms / 16.5 MB measured here), compare stat sizes, delete the scratch, and run the in-place
VACUUM only if the measured delta clears a threshold — the reclaimed figure reported is the one
observed on this machine's own data, never a rule of thumb.

**In the app** — Settings → Store → Maintenance: last run, bytes actually reclaimed, next
eligibility, and an explicit 'not measured — 17.2 MB required, 4 MB free' state rather than a
skipped run reported as success.

**Source** — PRAGMA freelist_count / page_count / page_size, VACUUM INTO, PRAGMA optimize, PRAGMA
wal_checkpoint, statfs for free disk, collector_state.last_scanned_at

**Limit** — VACUUM takes an exclusive lock. At 30K rows that is 60 ms and invisible;

### 21. Art. 30 record and the Art. 15(1)(c) recipients answer, both with an unknown denominator

`Export` · `DPO` · **M** · partial · unscored

Two exports off `v_processing_register`, both refusing to drop the unknowns. `vole register
--art30` emits an org-level record of processing activities: recipient, legal entity,
contract_scope, third-country transfer yes/no/unknown, safeguard cited by the pack, categories of
data evidenced (from the dlp_egress data-class column, not from prose), retention default,
evidence count and first/last seen — with a mandatory header line counting the surfaces whose
recipient could not be resolved and the egress rows with no in-force terms entry. `vole dsar
--recipients <principal>` answers Art.

**In the app** — An 'Export register' button on the Processing Register with the pre-export field
preview and re-identification scan already used by evidence bundles; on the People view, a per-
person 'Recipients' tab rendering the same rows the DSAR export would contain, gated by the
existing per-person view gate and subject notice.

**Source** — v_processing_register (processing_terms pack × terms_basis × recipient_state ×
dlp_egress data classes), export field registry, ~/.vole/policy/identity.json for the principal

**Limit** — An Art. 30 record is the controller's document;

*Extends the earlier entry "DSAR export that answers Art. 15(1)(h): the logic, not just the
rows".*

### 22. Quota ledger: the real cachedUsageUtilization shape, a scoped rule key, and the percent-to-money bridge

`FinOps` · `FinOps` · **M** · exact · 4/5

v1 describes `~/.claude.json cachedUsageUtilization` as `{fetchedAtMs, five_hour, seven_day,
limits[].{percent, resets_at}}`;

**In the app** — MenuPanel gains a headroom line ('7-day 42%, resets 9 Sep 10:00 UTC, read 3 h
ago');

**Source** — ~/.claude.json cachedUsageUtilization — verified live here: fetchedAtMs
1788763107042, utilization.seven_day.utilization 42 resets_at 2026-09-09T10:00:00Z, limits[]
session 0% / weekly_all 42% / weekly_scoped 61% scope.model.display_name 'Fable' is_active true,
all *_dollars null, extra_usage.is_enabled false, spend.used.amount_minor 0;

**Limit** — The percent covers the whole account across every surface — claude.ai web, Cowork,
Claude Desktop, other machines — so the implied full-window value is an upper bound on what Vole's
share explains and degrades to nonsense the moment the account is used elsewhere. The snapshot
refreshes only while Claude Code is running, so the reading can be hours stale;

*Corrects the earlier entry "Claude subscription quota tracker (5-hour / 7-day windows)".*

### 23. vole import --context and the devcontainer feature: rows from a container arrive as rows, never as estimates

`Platform` · `Platform` · **L** · new instr. · unscored

The deployment answer to a gap that cannot be closed by reading harder. Ship three things:
`docs/COVERAGE-TOPOLOGY.md`, one page stating plainly which contexts Vole reads and which it
counts-but-cannot-read; a published devcontainer feature and container image layer that installs
the collector inside the image and points it at a spool directory the container already mounts, so
a devcontainer run writes `~/.vole/contexts/<context_id>/events-*.ndjson` in the normalised
UsageEvent shape with its own declared context and origin;

**In the app** — Topology card rows gain a state chip: unmonitored / spool present, not imported /
imported <n> rows at <time>. Settings gains an Import Contexts pane listing discovered spool
directories with row counts and a dry-run preview before anything is written.

**Source** — ~/.vole/contexts/<context_id>/*.ndjson written by the collector running inside the
container; the feature manifest published for devcontainer `features`;

**Limit** — This only helps images the organisation actually rebuilds and mounts a spool into — a
container already running, a Codespace, a CI runner nobody controls, and every SSH remote get
nothing, and for SSH remotes the honest answer stated in the doc is 'install Vole there too'. Vole
still never exec's into a running container;

*Corrects the earlier entry "Headless CI mode (GitHub Action / container step)".*

### 24. Retention with a receipt, gated on what can still be rebuilt

`Governance` · `DPO` · **M** · exact · unscored

The v1 prune item treats deletion as free — roll up, delete the live rows, move on — and the
reason it is not free is in this repo: docs/EXTENDING.md still calls the store 'disposable — it
rebuilds from source logs', which stopped being true the moment a row outlived its source. Add
store_prunes(id, ran_at, trigger, data_class, table_name, rows_deleted, oldest_deleted_ts,
newest_deleted_ts, bytes_before, bytes_after, policy_clause): one row per data class per pass,
counts taken from the statement's own .changes and bytes from store_budget, with trigger being
'policy' (retention_days) or 'budget' (a store_budget threshold).

**In the app** — Privacy Center → Retention: one row per pass showing class, rows deleted, the
exact date range destroyed and bytes reclaimed, plus a 'refused' section listing classes held back
because their source is gone.

**Source** — usage_events.raw_ref existence on disk, ~/.claude/.last-cleanup, cleanupPeriodDays,
store_budget bytes, ~/.vole/policy retention clause

**Limit** — A receipt proves what was destroyed, not what it said: after a class is pruned the
only honest DSAR answer for that window is 'deleted on <date>, N rows, class X', and it must be
worded as one. A legal hold protects Vole's own rows only — it cannot stop Claude Code's cleanup
deleting the transcript underneath, so a held range can still lose its evidence.

*Corrects the earlier entry "Historical rollups, retention prune, bounded detection window and
legal hold".*

### 25. Uncosted rows: local and free-tier providers render an em dash, never $0.00

`FinOps` · `FinOps` · **S** · exact · 3/5

Eleven of the thirteen providers behind OpenCode on this machine report cost exactly 0.0 —
opencode Zen (2,803 messages), qwen38-fp8 (2,802), openrouter free-tier (724), qwen38-heretic
(590), qwen38-base (268), ollama (184), fable-fusion (84), qwen-h200 (57), qwen, unsloth-studio,
qwen12 — 7,521 assistant messages in total. Storing 0.0 and rendering '$0.00' invents a number in
the direction nobody checks: an H200 running a 27B model has a real hourly cost the provider never
bills, and a free-tier row is a rate-limited entitlement rather than free compute.

**In the app** — Breakdown and Costs screens gain a distinct 'uncosted' section listing local and
free-tier providers with token totals and an em dash for cost, plus a one-line 'declare a rate in
units.json to price these' affordance that deep-links to Settings → Units.

**Source** — ~/.local/share/opencode/opencode.db `message.data.providerID` and `data.cost` (13
providers, 7,521 zero-cost assistant rows here versus 3,364 priced); local runtime evidence from
loopback provider ids ollama / unsloth-studio / qwen-h200 and their listening ports.

**Limit** — A provider-reported 0.0 is ambiguous between 'genuinely free', 'not yet computed by
the provider' and 'self-hosted', so the classifier only distinguishes local/loopback providers
with confidence and marks the rest as uncosted-unknown rather than guessing.

### 26. Purpose-bound query layer with a closed purpose union

`Governance` · `DPO` · **L** · exact · 3/5

The code map already asks for a where({from, includeSeed, user, machine, tool, project}) builder
to replace the seedClause hand-spliced at 8 sites in queries.ts and TOKEN_FILTER at 6. Give that
builder a required purpose argument from a closed union — security_incident | cost_allocation |
capacity | self_view | dsar — and attach to each purpose the columns it may select and whether it
may group by subject. A purposes.test.ts walks every exported read model and fails the build if
one omits a purpose, or if a query whose purpose is not security_incident, self_view or dsar
selects subject_id.

**In the app** — Privacy Center → 'Purposes' table listing each purpose, the columns it may read
and the count of queries bound to it, generated from the test's own fixture so the screen cannot
drift from the code.

**Source** — queries.ts (all read models, seedClause at 8 sites, TOKEN_FILTER at 6), cli/mcp.ts
TOOLS array, DB.swift read-model ports.

**Limit** — On a single-user machine the reader is the subject, so purpose binding is bookkeeping
rather than access control; it becomes a real control only where the reader is not the subject — a
fleet relay or a shared machine.

*Extends the earlier entry "Purpose limitation policy: role query rights, per-table retention,
sealed-until-incident".*

### 27. billing_units: a declared bridge for credits, seats and premium requests, or an em dash

`FinOps` · `FinOps` · **S** · exact · 3/5

The four vendors bill in four incompatible units — Anthropic in tokens and USD, OpenAI in tokens
and USD for API but ChatGPT seats for Codex, Cursor in requestsCosts and totalCents, Copilot in
premium requests and seats — and every dashboard that shows a single number has invented the
conversion. Rather than invent one, add `~/.vole/units.json` following the pattern pricing.json
already establishes for overrides, where an admin declares `{vendor, unit, usd_per_unit,
effective_from, note, author}`, plus a `billing_units` table recording which declaration priced
which row.

**In the app** — Settings → Units: an editable list of each declared rate with who declared it and
when, and a staleness flag; every converted dollar figure anywhere in the app carries a small
superscript linking back to the declaration that produced it.

**Source** — ~/.vole/units.json (new); vendor_ledger.unit;

**Limit** — A seat price divided across a month is an allocation choice, not a measurement — the
tool can carry it but must never present it as spend or sum it into a spend total. Premium-
request-to-dollar rates change with GitHub's published multipliers and are not fetched, so a stale
declaration silently mis-prices;

### 28. AI literacy and tool-usage record per subject

`Governance` · `Procurement` · **S** · exact · 3/5

EU AI Act Art. 4 has been enforceable since 2026-08-02 and obliges deployers to ensure staff have
sufficient AI literacy; the evidence an auditor asks for is a per-person record of which AI
systems each employee actually uses, which Vole already holds and throws away.

**In the app** — Privacy Center → 'Your AI tools' card: one row per tool and model with first
seen, last seen and session count, plus imported training rows where present; the fleet view shows
only the aggregate.

**Source** — usage_events DISTINCT (tool, model) with MIN/MAX(ts) and COUNT(DISTINCT session_id)
per subject; an org-supplied CSV for the training column.

**Limit** — It proves use, never competence — the record shows a person ran a model, not that they
understood it, and the training column is imported rather than derived. Tools Vole has no
collector for are absent from the record rather than zero, so the coverage screen must ship
alongside it or the record reads as a false negative.

### 29. Budget burn-down scoped by cost_basis, with a budget_indeterminate verdict

`FinOps` · `FinOps` · **M** · exact · 3/5

A dollar budget is meaningless over a column that mixes Anthropic list value, OpenCode's provider
figure and 4,723 NULLs, so correct the budget design before it ships: `~/.vole/budgets.json`
limits are declared per `(scope, cost_basis)` — a budget against anthropic_list for a repo, a
token budget where no basis exists — and the pure detect/budget.ts rule computes burn only over
rows matching that basis.

**In the app** — A budget card per declared scope showing spent / limit / remaining with the
window boundary, and — where the basis is impure — an amber 'indeterminate: 2,678 unpriced calls
in scope' state in place of a percentage rather than a misleading bar.

**Source** — ~/.vole/budgets.json (new); usage_events.{cost_usd, cost_basis, project, model, user,
tool};

**Limit** — A budget can only bind on what has a price, and here 100% of Codex and Grok exact rows
and 16% of Claude Code calls do not — refusing to show a percentage in that case is the feature,
not a limitation to engineer around.

*Corrects the earlier entry "Budgets, budget_exceeded rule and labelled pace projection".*

### 30. Device decommission: seal, attest, erase — and the hold that names its declarer

`Governance` · `DPO` · **L** · exact · unscored

`vole decommission --principal <id> --out <path>` runs three gates that cannot be skipped or
reordered. Seal: export that principal's rows through the deny-by-default field registry, plus the
evidence_freeze manifest, plus the checkpoint chain, then hash what was written. Attest: recompute
the chain over the archive and print the head beside the store's store_epoch, so the archive can
be shown to be the store it came from.

**In the app** — A Decommission sheet with the three gates as sequential steps, a hold banner
naming the declarer and expiry when the erase gate is blocked, and a final receipt (rows erased
per table, chain head, pruned_before_ts per tool, hold status) that is itself exportable.

**Source** — vole.db tables only, plus the export field registry and legal_hold declarations from
~/.vole/policy; no agent artifact is modified

**Limit** — Erasing Vole's rows does not touch the agents' own transcripts under ~/.claude,
~/.codex, opencode.db or the Devin stores — the receipt says so and lists the paths that still
hold source data, because deleting those is the vendor's data and breaks `claude --resume`.

*Extends the earlier entry "Data-subject access and erasure: vole dsar export and vole forget".*

### 31. k-anonymity with complementary suppression for aggregate mode

`Governance` · `DPO` · **M** · partial · 3/5

Roadmap-v1's aggregate sync mode 'suppresses cells with fewer than k devices', but primary
suppression alone leaks: if the row total and the org total ship unsuppressed, a single suppressed
cell is recovered by subtraction, and a row with exactly one suppressed cell always is. Implement
the standard two-pass rule — suppress primary cells with n<k, then suppress additional cells per
row and per column until no suppressed value is derivable from published margins, and never
publish a margin whose complement is one suppressed cell. Two further corrections to the v1 text:
k must count distinct subjects, not devices, since one person with a laptop and a desktop
currently counts as two;

**In the app** — Privacy section → 'Aggregate preview' renders the exact grid that would be
published, with suppressed cells shown as '— (n<k)' and a footer stating k, the number of primary
suppressions and the number of complementary ones, so a DPO can inspect the published artefact
before it exists.

**Source** — Daily rollups over usage_events GROUP BY (day, tool, model, project-slug) with
COUNT(DISTINCT subject_id) resolved through the principals binding; k from ~/.vole/policy.json.

**Limit** — Suppression is computed per publication, so an adversary differencing successive daily
publications with shifting cell sets can still reconstruct a suppressed cell; the only sound
answer is a fixed publication schedule with a stable cell set, which the docs must state as a
deployment requirement rather than a nice-to-have.

*Corrects the earlier entry "Identity pseudonymisation modes at sync (cleartext / HMAC-org-key /
aggregate-only k)".*

### 32. Vendor rate cards read from disk, in the vendor's own unit, with the real context ceiling

`FinOps` · `FinOps` · **M** · exact · unscored

debug-logs/<id>/models.json carries the vendor's full billing table per model:
billing.token_prices.{default,long_context}.{input_price, output_price, cache_price,
cache_write_price, context_max}, billing.restricted_to (pro_plus, business, enterprise, max) and
capabilities.limits.{max_context_window_tokens, max_output_tokens,
max_non_streaming_output_tokens}. The chat store keeps a per-session copy in
inputState.selectedModel.metadata: pricing 'In: 1000 · Out: 5000 AICs/1M tokens', inputCost,
outputCost, cacheCost, cacheWriteCost, priceCategory, maxInputTokens 223790, auth.{providerLabel,
accountLabel}.

**In the app** — Costs prints an AIC subtotal on its own line with an em dash in the USD column
until an admin supplies a conversion in policy; the Models table shows the vendor's declared
ceiling beside the observed peak, and a tier chip where two ceilings exist.

**Source** — <editor root>/User/globalStorage/github.copilot-chat/debug-
logs/<sessionId>/models.json; chatSessions/*.jsonl inputState.selectedModel.metadata

**Limit** — Prices are AICs per 1M tokens, not dollars: they are stored with unit='AIC' and never
converted, because the AIC rate is not on this machine. models.json only exists once someone has
opened the Copilot debug log — 22 files across 11 sessions here — so coverage is opportunistic and
each card carries observed_at rather than pretending to be current.

*Extends the earlier entry "billing_units: a declared bridge for credits, seats and premium
requests, or an em dash".*

### 33. Server-tool billing line (web_search_requests, web_fetch_requests)

`FinOps` · `FinOps` · **S** · exact · 2/5

Anthropic bills server-side tools per request rather than per token, and
`message.usage.server_tool_use.{web_search_requests, web_fetch_requests}` appears on 29,114
assistant lines in this machine's transcripts — every one of them discarded at claude-
code.ts:138-146. `~/.claude.json projects[].lastTotalWebSearchRequests` and each cost-state
`modelUsage[model].webSearchRequests` confirm the vendor counts them as a separate line item.
Until they are stored and priced, every reconciliation against Anthropic's cost_report carries a
permanent unexplained delta that reads as shadow spend.

**In the app** — Breakdown gains a 'server tools' row under each model with the request count and
its own cost line; the Reconciliation delta table shows web searches as a first-class row
alongside the five token classes.

**Source** — ~/.claude/projects/**/*.jsonl `message.usage.server_tool_use.{web_search_requests,
web_fetch_requests}` (29,114 occurrences here); ~/.claude.json
`projects[].lastTotalWebSearchRequests`;

**Limit** — Every occurrence on this machine is zero, so the columns will be all-zero until
someone runs web search — the feature is proven by field presence, not by a live figure, and the
view must not imply otherwise. No other tool in the set reports server tools at all, so this line
exists for Claude Code only and is NULL elsewhere.

*Corrects the earlier entry "Provider, service-tier and gateway attribution columns".*

### 34. Checkpoint chain over exported rows, witnessed by the sink the buyer already configured

`Governance` · `Procurement` · **M** · partial · unscored

Every export batch appends one export_checkpoints row: (epoch_id, seq_from, seq_to, row_count,
rows_sha256, prev_checkpoint_sha256, checkpoint_sha256, sink_id, acked_at), where rows_sha256
covers the exact bytes the deny-by-default field-registry encoder emitted in export_seq order, so
it is reproducible from the store at any later time. Checkpoints ship as ordinary rows through the
same sink, so there is no new network path and no addition to the declared egress inventory.

**In the app** — Settings > Evidence carries a chain state chip (intact / broken at seq N /
unverifiable — pruned), the last checkpoint seq and time, and which sink holds it. Each evidence
bundle embeds the checkpoint covering its window plus the sink's ack timestamp.

**Source** — export_seq change cursor and the durable export outbox; the field-registry encoder's
serialized bytes;

**Limit** — It proves only that rows which reached the sink were not altered afterwards. It cannot
prove a row was ever created — an event deleted before its batch was encoded is invisible to the
chain, which is what evidence_gaps and witness-orphans exist for.

*Corrects the earlier entry "Tamper-evident audit log (hash chain + signed checkpoints)".*

### 35. Reconciliation coverage report: what share of spend is even checkable

`FinOps` · `CISO` · **M** · partial · 5/5

Classify every local row on three axes for a range and print the share of list value in each
bucket: priced versus unpriced (2,661 of 15,933 Claude Code calls here carry NULL cost); exact
versus activity_only (Cursor, Antigravity, Devin and 969 failed Grok calls can never be reconciled
on tokens); and reconcilable auth path versus not (Console API key = reconcilable;

**In the app** — The Reconciliation screen opens on this report when no vendor pull has ever run;
afterwards it stays as a permanent header strip so no delta table is ever read without its
denominator.

**Source** — usage_events.{confidence, cost_usd, model, tool}; vendor_identities.{auth_path,
plan};

**Limit** — Coverage is computed over rows Vole holds, so it cannot account for agents Vole does
not collect or for machines it is not installed on — it is a statement about this endpoint and
says so in its first line.

### 36. Works-council pack: DPIA pre-filled with measured facts, plus BV and CSE skeletons

`Governance` · `DPO` · **M** · partial · 3/5

v1 generates DPIA sections from the manifest, which is a statement of intent; a works council
argues proportionality with numbers. Fill the necessity, proportionality and risk tables from the
running install: rows per table, which columns are non-NULL and at what rate (2,008 of 28,948 rows
here have no model and 12,930 no branch), how many manifest fields are personal data, the k
achieved for each aggregate, the count of content-reading scanners enabled, and the collector's
measured CPU and wall time from collector_runs.

**In the app** — Privacy Center → 'Generate works-council pack' button; the resulting document's
fact table is previewed in-app so the developer sees the same numbers the council will.

**Source** — PRAGMA table_info plus COUNT and non-NULL scans over the live DB,
packages/core/src/sync/manifest.ts, ~/.vole/policy.json, collector_runs duration rows, the lawful-
basis record.

**Limit** — Templates, not legal advice, and the measured figures describe one machine — fleet-
wide numbers do not exist until sync is on, so the pack must label them 'one endpoint, <date
range>'. It cites the co-determination trigger;

*Extends the earlier entry "Compliance documentation pack generated from the manifest
(docs/compliance/)".*

### 37. vendor_ledger: the vendor's own billing figures, read from disk with zero network

`FinOps` · `FinOps` · **L** · partial · 4/5

Every vendor Vole covers already writes its own billing figure to local disk, so reconciliation
can start before any API key exists.

**In the app** — New Reconciliation screen, left pane 'Vendor says': one row per vendor figure
with unit, window boundaries, artifact path and observed_at beside it; the session detail drill-
down gains a 'Vendor $0.2025 / Vole $0.2019' line, and a per-project line anchored on lastCost.

**Source** — ~/.claude/projects/**/*.jsonl `type:'cost-state'` (present on this machine);
~/.claude.json `projects[].lastCost` (6 of 23 non-null: <redacted-local-path> 0.39005, .../landing 2.02543,
one exactly 0) and `cachedUsageUtilization.spend.used.amount_minor` (0 here);

**Limit** — cost-state is written at session end, so an interrupted or crashed session has no
vendor figure at all — NULL, never zero. `hasUnknownModelCost:true` means the vendor's own number
is itself incomplete, so the row is stored with that flag and is never treated as ground truth.

*Extends the earlier entry "Claude Code cost-state cross-check in pnpm verify".*

### 38. Reconciliation delta view with a not_comparable state that refuses to invent a gap

`FinOps` · `FinOps` · **M** · partial · 4/5

A view over `vendor_ledger` LEFT JOIN a same-shaped local aggregate, keyed on (vendor, UTC day,
model, identity), producing `vendor_value`, `local_value`, `delta`, `delta_pct` and a `state` enum
of `matched | vendor_only | local_only | units_differ | not_comparable`. The arithmetic obeys
principle 1 absolutely: when the local side contains any activity_only row or any row with NULL
cost_usd for that cell, `delta` is NULL and `state` is `not_comparable` — a missing local number
is never read as zero, which is the single most common way FinOps tools manufacture a fake gap.

**In the app** — Reconciliation screen centre pane: the delta table sorted by absolute vendor_only
value, each row expanding to the contributing local sessions and the vendor-side group_by that
produced it;

**Source** — vendor_ledger; usage_events (source='live') grouped by CAST(ts/86400000) day, model
and identity;

**Limit** — On a single laptop most vendor_only spend is simply other employees' machines, so the
view must label single-host mode explicitly and scope the vendor query to this identity or the
number is meaningless.

### 39. `pnpm verify --reconcile`: cost arithmetic checked against the vendor's own local figure

`FinOps` · `FinOps` · **M** · partial · 2/5

verify.ts today reconciles Claude Code, OpenCode and Codex rows against their own source logs
(Grok is never reconciled at all, and it PASSes on an empty DB). Add a third leg comparing Vole's
computed per-session sums against the vendor's own local figure: cost-state `totalCostUSD` and
`modelUsage[model].costUSD` per session, and `~/.claude.json projects[].{lastCost,
lastTotalInputTokens, lastTotalOutputTokens, lastTotalCacheReadInputTokens,
lastTotalCacheCreationInputTokens}` per project, failing with the exact delta and the session id
when they diverge beyond a token-rounding tolerance.

**In the app** — Settings replaces the hard-coded 'Verification: Every stored row reconciled'
string with the last verify result, its timestamp, the covered fraction and per-leg pass/fail —
including the vendor-figure leg and the honest 'Grok: not reconciled'.

**Source** — ~/.claude/projects/**/*.jsonl type:'cost-state' (e.g. totalCostUSD
0.20247400000000002 with a two-model modelUsage breakdown);

**Limit** — cost-state exists only for sessions that ended cleanly and lastCost holds only the
most recent session per project, so this leg covers a sample and must report the covered fraction
rather than a bare PASS.

*Extends the earlier entry "Claude Code cost-state cross-check in pnpm verify".*

### 40. `vole reconcile`: the single opt-in, egress-declared network command

`FinOps` · `Platform` · **L** · network · 3/5

One CLI, never the collector daemon and never the app on a timer: `vole reconcile
--vendor=anthropic --from=2026-08-01 --to=2026-08-31 [--yes]`. It first prints the exact hosts,
paths and query parameters it will call, the identity it will scope to and the columns it will
write, then refuses to proceed without `--yes` or a `reconcile.confirmed` flag in
`~/.vole/reconcile.json`, and it is gated by the same no-egress switch that the update check must
respect.

**In the app** — Settings → Reconciliation: a disabled-by-default toggle per vendor showing the
endpoint list, the credential source (env var name or Keychain item), 'last run / rows written /
bytes received', and a 'Run now' button that shells the CLI and streams its declared plan before
executing anything.

**Source** — ~/.vole/reconcile.json (new, user-created); env ANTHROPIC_ADMIN_KEY /
OPENAI_ADMIN_KEY / CURSOR_API_KEY / GITHUB_TOKEN;

**Limit** — This crosses the local-first line by design and must be documented as such in
SECURITY.md alongside the existing undisclosed UpdateChecker egress, which has to be fixed first
or the disclosure is a lie. It only works for someone holding org-admin credentials — a developer
running Vole on their own laptop cannot run it at all.

*Related to the earlier entry "Opt-in update check and CI-enforced self-egress allowlist".*

### 41. Anthropic Admin API adapter (usage_report/messages, usage_report/claude_code, cost_report)

`FinOps` · `FinOps` · **L** · network · 3/5

Three GETs against `https://api.anthropic.com` with `x-api-key: <sk-ant-admin…>` and `anthropic-
version: 2023-06-01`, using an Admin key only an org owner can mint.
`/v1/organizations/usage_report/messages` takes `starting_at`, `ending_at`, `bucket_width`
(1m|1h|1d) and `group_by[]` of api_key_id|workspace_id|model|service_tier|context_window,
returning per-bucket `uncached_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`,
`cache_creation.ephemeral_1h_input_tokens`, `cache_read_input_tokens`, `output_tokens` and
`server_tool_use.web_search_requests` — the same five token classes usage_events already stores,
which is why this diff is arithmetic rather than estimation.

**In the app** — Reconciliation screen, Anthropic tab: the five token-class rows plus web searches
side by side, vendor versus Vole, with the exact bucket boundary and the group_by that produced
the vendor column printed above the table.

**Source** — api.anthropic.com Admin API; joined locally on ~/.claude.json
`oauthAccount.{accountUuid, organizationUuid}` and transcript `type:'bridge-
session'.{ownerAccountUuid, ownerOrganizationUuid}` — opaque ids only, never
emailAddress/fullName/organizationName which sit in the same object.

**Limit** — The Admin API exists only for Console API organisations. This machine's account is
`organizationType:'claude_max'` with `billingType:'stripe_subscription'` — a subscription — so
none of these three endpoints returns anything for it and the entire Anthropic leg degrades to the
local-cache vendor_ledger.

### 42. OpenAI Admin API adapter, and the ChatGPT-seat hole it names instead of filling

`FinOps` · `FinOps` · **L** · network · 3/5

`GET https://api.openai.com/v1/organization/usage/completions` with `Authorization: Bearer sk-
admin-…`, params `start_time`, `end_time`, `bucket_width` (1m|1h|1d) and `group_by[]` of
project_id|user_id|api_key_id|model|batch, returning `input_tokens`, `output_tokens`,
`input_cached_tokens` and `num_model_requests` per bucket; `GET /v1/organization/costs` gives 1d
buckets grouped by project_id|line_item in USD.

**In the app** — Reconciliation screen, OpenAI tab; under auth_mode 'chatgpt' the whole tab
becomes one honest panel: 'This machine's Codex sessions bill against a ChatGPT team seat
(plan_type: team).

**Source** — api.openai.com Admin API;

**Limit** — Codex CLI logged in with a ChatGPT account — the default, and the case on this machine
— produces zero rows in /v1/organization/usage/completions because that consumption is seat-based
and lives in ChatGPT admin, which has no public per-turn usage API. For the most common Codex
deployment the answer is a documented 'cannot compare', not a number.

### 43. Cursor and Copilot adapters: reconciliation where the units can never match

`FinOps` · `FinOps` · **L** · partial · 4/5

Two vendors where the honest output is a count or a unit mismatch, never a cost diff, and the
adapter's job is to say so with figures. Cursor: `POST https://api.cursor.com/teams/filtered-
usage-events` (HTTP Basic, team API key as username, empty password) returns per-event
`timestamp`, `model`, `kindLabel`, `maxMode`, `isTokenBasedCall`, `requestsCosts` and
`tokenUsage.{inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,totalCents}`, with
`/teams/spend` for per-user spendCents and `/teams/members` for the email↔userId map — but Vole's
Cursor collector is activity_only, so the join is requestId-count-per-day-and-model versus vendor
event-count, a call-count reconciliation.

**In the app** — Reconciliation screen, Cursor and Copilot tabs: Cursor shows two count columns
per day and model with a permanent 'tokens: vendor only' chip; Copilot shows a 'Vendor unit:
premium requests.

**Source** — api.cursor.com Admin API and api.github.com Copilot metrics/billing; local side
~/.cursor/ai-tracking/ai-code-tracking.db
`ai_code_hashes.{requestId,conversationId,model,timestamp}` (0 rows here) and
~/.local/share/opencode/opencode.db `message.data.providerID='github-copilot'` (3,336 rows,
$575.19).

**Limit** — Cursor's Admin API is Enterprise-tier only, and `ai_code_hashes` records accepted AI
code rather than every model call, so local counts are a systematic lower bound the view must
state rather than call a gap.

*Related to the earlier entry "GitHub Copilot collector (VS Code agent mode exact output tokens;
CLI activity_only)".*

### 44. reconcile_gap rule, and the three explainability columns nobody has ever selected

`FinOps` · `CISO` · **L** · network · 4/5

A pure detection rule in the existing `(events, now) => Anomaly[]` shape, over vendor_ledger and
the local aggregate. It fires when a (vendor, identity, UTC day, direction) cell has both sides
non-NULL, the same unit, and `|vendor − local| / vendor > 0.15` on at least two consecutive days —
the consecutive-day gate exists purely to absorb bucket-boundary and timezone skew, not to soften
the finding. `anomaly_key = 'reconcile:<vendor>:<identity_hmac>:<day>:<direction>'`, deterministic
and free of now().

**In the app** — Incident feed card reading 'Anthropic billed 41.2M output tokens on 2026-08-14;
Vole observed 28.7M for this identity (30% gap, threshold 15%)', with a 'show the sessions' action
and an automatic suppression when the day predates the local transcript retention horizon.

**Source** — vendor_ledger; usage_events;

**Limit** — Anomalies are INSERT OR IGNORE on anomaly_key, so the first verdict is frozen — a gap
that widens on a later pull will not escalate without an explicit upsert clause and a re-notify
path, and this rule needs that change more than any existing rule does.


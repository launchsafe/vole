# Tier 7 — Getting evidence off the laptop honestly: triage, export, and the SIEM contract

[← Enterprise roadmap index](../ENTERPRISE-ROADMAP.md) · 49 features

A security team does not adopt a tool that only speaks through one Mac app, and the market
research is unambiguous that buyers want SIEM-native events, not another console. But every row
that leaves is a privacy decision, so export is engineered as a gate rather than a feature: a
deny-by-default field registry with a NULL-omitting encoder, versioned shapes for the secret and
tool-call ledgers, `export_seq` with replay that cannot rewind the live tail, a durable outbox
with backpressure and audited drops, a sink capability matrix that states delivery semantics
truthfully, and `(device_id, event_key)` as the dedupe key. Wire formats are OTLP against a pinned
semconv snapshot (with honestly zero-length chat spans rather than fabricated durations),
incidents as log records carrying the figures that fired, syslog and CEF for the SIEMs that
predate JSON, a Sentinel connector generated from the field registry, and osquery ATC tables so
Vole is the source rather than a competing console. Alongside it ships the triage layer the app
has never had — `case_key`, the append-only `finding_actions` disposition ledger, bulk disposition
over an explicit id set, timed mutes with mandatory expiry, and per-rule detection quality with a
labelled-fraction floor — plus the incident evidence bundle with byte-offset provenance and the
custody sentence stating exactly what it is allowed to claim, and a heartbeat with a log-source-
stopped dead-man's switch. This tier turns a laptop tool into something a SOC can run, and the
pilot conversion depends on it.

Legend: `category` · `buyer` · effort **S**/**M**/**L**/**XL** · feasibility (*exact* =
readable from local data today, *partial*, *new instr.* = needs something written that does
not exist, *network* = crosses the network line) · value 1–5, 5 meaning a security lead blocks
the rollout without it. `unscored` came from a completeness sweep and skipped the verifier.

---

### 1. Deny-by-default export field registry with a NULL-omitting encoder

`Export` · `Procurement` · **M** · exact · 5/5

The 'never a prompt leaves' claim must be structural, not a review habit. Add
packages/core/src/export/fields.ts: a frozen table of {column, wire_name, transform} entries
(project -> repo_slug|hmac, raw_ref -> dropped, session_id -> passthrough, user/machine ->
hmac_or_cleartext per policy identity.mode) and build every payload — OTLP attributes, Splunk HEC
event object, Elastic doc, syslog SD-PARAMs — by iterating that table, never from an object
literal or a SELECT * spread.

**In the app** — Settings → Export gains two panels rendered from fields.ts at runtime: 'Fields
that leave' (column, wire name, transform, example value) with a second list of columns that are
structurally unable to leave, and an 'Absence' strip showing, for the last 24 h of exported rows,
the count and share that carried no tokens, no cost and no model — the same three numbers the
reference Grafana panel shows.

**Source** — packages/core/src/schema.ts column list; packages/core/src/db.ts ORIGIN spread;

**Limit** — The registry proves nothing about fields Vole never collected — a reviewer still has
to read the collectors to see that tool_use.input was never parsed into memory.

*Extends the earlier entry "Redaction manifest and verify --content (prove the DB and exports hold
no content)".*

### 2. case_key: the case identity beneath the time bucket

`Governance` · `CISO` · **M** · exact · unscored

Every rule builds anomaly_key ending in the UTC bucket epoch (burn-rate.ts:54, loop.ts:50, error-
storm.ts:32, context-pressure.ts:53, rate-limit.ts:24), so the 'stable key' triage assumes is not
stable across recurrences: the same runaway loop next window is a different row. Add a nullable
case_key column on anomalies plus idx_an_case, emitted by each rule as the identical tuple minus
the bucket (rule + source + subject dims, never now(), never a session for burn_rate which groups
tool+model).

**In the app** — Incidents becomes case-first: one row per case carrying 'seen N times, first
window / last window', disclosure-triangle expanding to the individual findings with their own
figures. The case id is the vole:// deep-link target and the anchor the sidebar open-count counts.

**Source** — ~/.vole/vole.db anomalies.anomaly_key and anomalies.window_start (verified 250/250
tail == window_start); key construction in packages/core/src/detect/*.ts

**Limit** — burn_rate_spike's subject is tool+model only, so its case can never be attributed to a
session - the session_id on the row is evs[0].session_id (burn-rate.ts:58), the first event in the
window, not the case's owner. A pack bump that changes a rule's dimensions produces a new
case_key;

*Corrects the earlier entry "Finding lifecycle and acknowledgement".*

### 3. Triage queue: the incidents screen the app has never had

`Desktop` · `CISO` · **L** · exact · unscored

Today the incident feed (DashboardView.swift:415-525) groups by Calendar.current.startOfDay and
prints rule/tool/confidence/detail with no state, no figures and no order but time, over
getAnomalies which does not even SELECT observed/baseline/threshold (queries.ts:230). Replace it
with a worked queue backed by a new v_triage read model (case_key, rule, worst severity,
recurrence count, first/last window, state, state age, principal, the ledger row the case points
at) written twice, in queries.ts and DB.swift, per the read-model parity rule. The list is case-
first, sorted severity then recurrence then age, with observed/baseline/threshold rendered inline;

**In the app** — New Incidents screen replacing the feed: a left rail of open counts by rule and
by disposition, a group-by control (rule | case | principal), a persistent filter bar, a header
line reading 'N open / M labelled / K unlabelled', and one-key jump into the evidence viewer.

**Source** — anomalies.observed/baseline/threshold/severity/rule/detected_at (schema.ts:42-64)
plus finding_actions.state; renders through queries.ts and the DB.swift port

**Limit** — Grouping by principal is a workload view only - counts and ages, never a rate per unit
of activity and never a ranking - and it sits behind the same gate and access log as the People
view, because 'no productivity axis' has to survive the screen that most tempts you to build one.

### 4. Timed mute: mandatory expiry, hidden-count and renewal accounting

`Control` · `Platform` · **M** · exact · unscored

A mute is a finding_actions row with state='muted' and a NON-NULL expires_at; the writer rejects a
mute without one, so a mute can never become permanent silence by omission. Detection is untouched
- rules still fire and rows still land in anomalies under INSERT OR IGNORE - so the mute only
hides the case from the queue and from the notification freshness gate (collect.ts:16,72;

**In the app** — A mute control in the case row with a required duration picker and a live
countdown chip; an Expiring Mutes list in the Policy screen showing scope, expiry, renewals so far
and hidden-count to date;

**Source** — finding_actions.expires_at; anomalies.detected_at and case_key;

**Limit** — The hidden count is exact for a mute because the rows were still written, but it is a
LOWER BOUND whenever the central suppression register turned the same detector off in the same
window - nothing was evaluated then, so both counts must be shown side by side with the register's
figure winning.

*Extends the earlier entry "Scoped suppressions stored as auditable info incidents".*

### 5. Triage writes take the collector path: the ~/.vole/inbox spool

`Platform` · `Platform` · **M** · new instr. · unscored

DB.swift opens READONLY and only falls back to READWRITE for WAL edge cases (DB.swift:129-133),
and the standing constraint is that it stays a read-only consumer - so triage writes cannot
originate in the app process without creating the second writer the store has no busy_timeout for
(db.ts:60). Instead the app and the CLIs append one JSON object per line to
~/.vole/inbox/actions.jsonl with O_APPEND and a single write syscall, and an eighth collector
reads it using the same byte-offset cursor in collector_state that claude-code.ts:111 already
maintains, inserting finding_actions inside the existing single-writer transaction and calling
commit() only after the insert succeeds.

**In the app** — Invisible by design, surfaced twice: a pending badge on any action the collector
has not yet ingested, and a line in the Privacy Center path receipts naming
~/.vole/inbox/actions.jsonl as a file Vole writes rather than reads.

**Source** — new ~/.vole/inbox/actions.jsonl; collector_state byte-offset cursor (schema.ts);

**Limit** — An action taken while the collector is stopped is durable but invisible until the next
pass, so the UI shows it from an in-memory echo and the database never learns a fabricated
timestamp; two clocks are stored (ts from the app, ingested_at from the collector) and a
clock_suspect line is ingested in arrival order, never reordered.

### 6. export_seq change cursor and replay that cannot rewind the live tail

`Export` · `Platform` · **M** · exact · 5/5

Every forwarder needs a resumable cursor, and roadmap-v1's export_state(sink, last_rowid,
last_sent_at) is broken by Vole's own upsert: db.ts rewrites an existing row in place when
excluded.total_tokens is strictly greater without changing usage_events.id, so a rowid high-water
mark never re-sends the corrected row — measured here, 410 of 987 Claude message.id values in one
transcript appear 2-3 times, the first copy a streaming placeholder with output_tokens 0, so a
rowid-cursor SIEM would keep the zeros forever.

**In the app** — Settings → Export: a per-sink row showing last_seq / max_seq and an 'N events
behind' number, with a red badge when the gap stops shrinking for two poll intervals; plus a
Replay panel with a date-range picker, a dry-run toggle and a cancellable progress row showing
rows and bytes sent.

**Source** — packages/core/src/db.ts INSERT_EVENT upsert (ON CONFLICT ... WHERE
excluded.total_tokens > usage_events.total_tokens);

**Limit** — Only rows whose total_tokens grow are re-emitted. The SET list never touches model,
project, git_branch or confidence, so a row corrected downward, or one that merely gains a model
value, is invisible to the cursor until that WHERE/SET is widened explicitly.

*Corrects the earlier entry "SIEM forwarder (Splunk HEC / Elastic bulk / Datadog Logs)".*

### 7. control_intents ledger: notification actions that record a request, gated on an exact PID mapping

`Control` · `Platform` · **L** · new instr. · 3/5

Store.swift:151-176 builds a plain UNMutableNotificationContent with no categoryIdentifier, so an
incident notification is informational only. Register a UNNotificationCategory per rule in
VoleApp.init with actions Pause session, Quarantine repo, Snooze 1h, Open evidence; pressing one
writes a single row to a new control_intents table (intent, target session_id, pid, actor,
requested_at, expires_at, state, source) whose state machine is requested -> enforced ->
expired_unenforced -> stale_not_sent, and the UI renders that state rather than implying the
action happened.

**In the app** — Notification Center action buttons per rule; an Actions strip on the incident
drill-down;

**Source** — apps/mac/Sources/Vole/Store.swift:151-176 and VoleApp.init (UNUserNotificationCenter
categories); ~/.claude/sessions/<pid>.json
{pid,sessionId,cwd,startedAt,procStart,version,entrypoint,kind};

**Limit** — Vole is out of the request path, so an intent is honoured only where a consumer
exists: today that is Claude Code alone (an exact-PID signal, or the hook once it exists). Codex,
OpenCode, Grok, Cursor, Devin and Antigravity have no consumer at all, so their rows expire
unenforced and the UI must never render that as a completed action.

*Corrects the earlier entry "Pause / resume / stop a session with confirm-to-act notifications".*

### 8. finding_actions: the append-only disposition ledger

`Governance` · `DPO` · **M** · exact · unscored

Add finding_actions(id, action_id UNIQUE, case_key, anomaly_key, state, actor, actor_kind,
reason_code, note, expires_at, content_rev, label_mode, batch_id, ts, ingested_at, source) -
append-only, never UPDATEd, never DELETEd, carrying a source column and the same seed/live
partition and purge as every other table. The latest action per case is denormalised onto
anomalies.state/state_ts/state_actor by one idempotent statement, UPDATE anomalies SET state=?
WHERE case_key=? AND (state IS NOT ? OR state_ts < ?), so replaying the ledger converges and re-
running the collector changes nothing.

**In the app** — A case detail pane showing the full action history as a timeline (who, what,
when, under which content_rev), the current state chip in the queue row, and a Settings toggle for
whether notes are included in an evidence bundle.

**Source** — new table in ~/.vole/vole.db; actor from the existing ORIGIN stamp (db.ts:19-35,
os.userInfo().username + os.hostname(), 'shiva'/'Marys-MacBook-Pro.local' on this machine)

**Limit** — actor proves an OS account on this laptop, not a person - there is no SSO identity
locally, and a shared machine or CI runner makes it worthless (the principal_conflict guard
applies here too).

*Corrects the earlier entry "Finding lifecycle and acknowledgement".*

### 9. Bulk disposition over an explicit id set, stamped label_mode

`Desktop` · `Platform` · **S** · exact · unscored

A bulk action takes the currently visible case ids as an explicit list, never the filter
predicate, so a disposition can never absorb findings that have not yet been seen - the single
most common way a triage tool turns into permanent blindness. The preview shows the exact case
list and per-rule counts before it commits, the write emits one finding_actions row per case
sharing a batch_id, and each row carries label_mode='bulk' against label_mode='single' for
individually opened cases. That column travels into the per-rule detection-quality table, so a
hundred cases swept in one keystroke cannot present themselves as a hundred reviews.

**In the app** — A selection bar above the queue ('46 cases selected - dispose as...') with a
confirm sheet listing the rules and counts, and a Batches list in the case detail pane where every
action row shows its batch_id and label_mode badge.

**Source** — v_triage case ids from the live query result; writes finding_actions rows through the
action spool

**Limit** — The product can distinguish reviewed-individually from swept, but it cannot
distinguish swept-carefully from swept-blindly; label_mode is a provenance flag, not a quality
judgement.

### 10. vole support-bundle: a redacted diagnostic that passes verify --content before it is written

`Platform` · `Platform` · **M** · exact · unscored

When an admin says a laptop is reporting wrong, the only artifact that can leave the machine today
is a screenshot. The bundle carries the shape of the store and never its rows: schema_migrations,
PRAGMA user_version, the sqlite_schema SHA-256, store_budget rows, store_prunes counts,
collector_runs and per-tool freshness, the three file sizes, freelist_count/page_count, PRAGMA
quick_check (9 ms measured here), the content-pack inventory, and versions (Vole, Node 26.7.0,
SQLite 3.53.4, macOS).

**In the app** — Settings → Support → Create support bundle: the exact field list previewed before
anything is written, then the redacted archive path with Reveal in Finder; the same output as
`vole support-bundle --out`.

**Source** — ~/.vole/vole.db PRAGMAs, collector_state (648 rows), collector_runs,
schema_migrations, store_budget, content_packs, process.versions, sw_vers

**Limit** — A bundle carrying no rows cannot explain a wrong row — it proves which schema, which
collectors ran and which bytes exist, and when the complaint is 'this number is wrong' the honest
next step is a named, consented evidence bundle for that one incident, not a wider diagnostic. It
also cannot prove the store was not edited before the bundle was made;

### 11. Device-scoped dedupe: (device_id, event_key) as the sync key

`Export` · `CISO` · **M** · partial · 5/5

v1's headless-CI item asserts that event_keys are globally unique per tool so merging runner
exports is safe, and the fleet-sync item keys the relay on event_key and anomaly_key; both are
false against this code. codex.ts keys on `codex:<sessionId>:<line index>` and sub-agent rollouts
replay the parent session_meta, so keys already collide inside one machine, and antigravity.ts
embeds a rounded mtime.

**In the app** — Settings → 'What leaves this machine' shows the device id used as the sync key,
the last cursor, and any imported-thread pairs it labelled; the app itself needs no change because
it reads the local store where event_key alone is still unique.

**Source** — packages/core/src/collectors/codex.ts event_key construction;
collectors/antigravity.ts rounded-mtime key;

**Limit** — Device-scoped dedupe cannot recognise the same human on two laptops, so cross-device
per-person totals need the identity binding, not the key.

*Corrects the earlier entry "Opt-in fleet sync of normalised rows (org relay / Vole Fleet)".*

### 12. Fleet and osquery table pack: be the source, not the console

`Platform` · `Platform` · **M** · partial · 3/5

Buyers say plainly they do not want another console, so publish Vole's read models as tables
someone else's agent can schedule: a documented public column set per table (agents, surfaces,
incidents, posture, coverage) exposed through `vole query --table=<name> --json`, plus a
Fleet/osquery query pack and an ATP-style extension table spec so an existing endpoint-governance
deployment can run Vole's tables beside its own. The column set is versioned as a public schema
independent of types.ts, which churns per collector, and every row keeps NULL and confidence
semantics unchanged: an unpriced call exports cost as JSON null, never 0, with the unpriced
counter shipped beside the aggregate.

**In the app** — Settings → Integrations lists each exposed table with its column list, its schema
version and a copy-to-clipboard sample row; deliberately no new screen, because the point of the
feature is that the screen belongs to someone else's tool.

**Source** — packages/core/src/queries.ts read models over usage_events, anomalies and the
posture/surface tables; Fleet's documented query-pack format;

**Limit** — Read-only and last-poll: there is no live query API and no push, so a scheduled
osquery run returns whatever the last collector pass stored, stamped with its time. Public columns
cannot track internal type churn, so a new internal field does not appear until the export schema
is bumped.

### 13. Human-confirmed handoff of one incident to the enforcement tool, payload shown before it leaves

`Control` · `CISO` · **M** · network · 3/5

v1's webhook fires automatically on every new anomaly behind the notify freshness gate. Add the
human-initiated form for the case that matters: a 'Send to…' button on the incident drill-down
that renders the exact bytes first — generic JSON, Slack Block Kit or PagerDuty Events v2 with
dedup_key = anomaly_key — and posts only after the human confirms, satisfying principle 5's 'no
silent network calls' with a literal preview rather than a policy claim. The payload is built from
the anomalies row's observed/baseline/threshold columns (schema.ts:42-64), which today no reader
selects at all (queries.ts:230, DB.swift:227), so this needs those three columns added to the read
model first.

**In the app** — 'Send to…' on the incident drill-down opening a sheet with the endpoint picker
and the verbatim payload; a per-incident badge showing sent / failed / never sent with the
endpoint and timestamp;

**Source** — anomalies rows including the observed/baseline/threshold columns (schema.ts:42-64)
that queries.ts:230 and DB.swift:227 currently drop; user-configured endpoint URLs and HMAC
secret;

**Limit** — This is outbound network: off by default, opt-in per URL, and it must honour the same
no-egress preference as UpdateChecker.

*Extends the earlier entry "Incident webhook and escalation (Slack, PagerDuty Events v2, generic
HMAC JSON)".*

### 14. store_epoch: proving the database is the one you were given

`Governance` · `CISO` · **S** · exact · unscored

One row, written once when the table is empty: store_epoch(epoch_id, created_at, device_id,
first_event_ts, collector_version, prev_epoch_id, prev_epoch_last_seq), with device_id from the
already-stable IOPlatformUUID identity and first_event_ts from MIN(usage_events.ts). prev_epoch_id
is NULL on a genuinely first install, and that is the whole mechanism: a sink already holding rows
stamped epoch A from device D that now receives epoch B with prev_epoch_id NULL has proof the
store was deleted and recreated, with first_event_ts showing exactly how much history came back.
The correction this carries: epoch must NOT enter the sync dedupe key.

**In the app** — Settings > Evidence shows Store epoch: created date, device, first event, and
either 'exported to <sink> since <date>' or 'never exported — this store has no off-box witness',
rendered as a plain neutral line rather than a scare banner.

**Source** — new store_epoch table under ~/.vole; IOPlatformUUID (existing stable machine
identity);

**Limit** — An epoch row is exactly as deletable as everything around it and proves nothing on-
device; it becomes evidence only at a sink that already holds an earlier epoch, so a device that
never exported can be reset with no trace whatsoever.

*Extends the earlier entry "Tamper-evident audit log (hash chain + signed checkpoints)".*

### 15. The answer sheet: the sentence the security team sends back, with its denominator attached

`Desktop` · `CISO` · **M** · exact · unscored

A hunt's output is not a table, it is a paragraph somebody has to send to a regulator, a customer
or a board. One page per `hunt_runs` row: the pack's name, signature and trust class; the four
verdict counters;

**In the app** — This is the surface: a Hunt page reachable from Triage, from a vole:// deep link
and from the command palette, with the answer paragraph as a copy button and the whole page
exportable as an incident evidence bundle carrying the custody sentence.

**Source** — hunt_runs, indicators, answerable_from, detection_epochs, the export field registry
and the device-scoped dedupe key; content_packs for pack identity and signature

**Limit** — The paragraph is true only as of the horizon it names: re-running the same pack later
can flip a not_seen to unanswerable as evidence ages out, so each run is versioned and never
overwritten, and the sheet shows the diff against the previous run rather than a corrected answer.

### 16. Durable export outbox with backpressure and audited drops

`Export` · `Platform` · **M** · exact · 4/5

Collection runs every 5 s and must never block on a network sink, and a laptop is offline most of
the day, so add export_outbox(seq, sink, doc_id, payload_hash, bytes, attempts, next_attempt_at,
status) written in the same transaction as the rows it covers. A separate drain step reads it with
exponential backoff, advances export_state only after a 2xx, and never holds the collector's write
connection. The outbox has a byte cap from policy;

**In the app** — Settings → Export status line reading 'queued 1,284 events, oldest 3 h 12 m, last
success 09:41' with a Retry now button; the drop anomaly appears in the normal Incidents feed with
its exact counts rather than in a log nobody reads.

**Source** — packages/core/src/cli/collect.ts results loop (the natural outbox write point,
immediately before commit()); packages/core/src/db.ts insertEvents/insertAnomalies single write
path.

**Limit** — The outbox is a plain table in a user-writable SQLite file: a developer can delete it
and the loss is invisible to the SIEM until the heartbeat rule fires. It also cannot preserve rows
whose source artifact was pruned by retention, so a long outage plus a prune is a permanent gap
that the drop anomaly can only bound, not recover.

### 17. Evidence bundle export with a pre-export field preview and re-identification scan

`Governance` · `Procurement` · **L** · exact · 5/5

One command (Cmd-E) from any incident, session, person or finding writes a .zip containing exactly
the row(s), the anomaly's observed/baseline/threshold and effective rule config, the usage_events
rows inside the window, the collector run record and tool versions, PRAGMA user_version, the
pricing table version and a manifest.json naming every column included and every transform
applied. Before writing, a sheet renders the payload field by field so nothing leaves the machine
unseen, and a re-identification scanner runs over every string field looking for the local OS
username, the short hostname, the directory-service RealName (dscl .

**In the app** — Cmd-E anywhere plus a context-menu item on incident, session and finding rows; a
preview sheet with a per-column table, pass/fail and sample hit counts, finishing on Copy path /
Reveal in Finder;

**Source** — anomalies (all 18 columns), usage_events window rows, collector_state/sources,
packages/core/src/sync/manifest.ts column allowlist, PRAGMA user_version, pricing.json version;
os.userInfo().username, os.hostname(), dscl RealName, ~/.claude.json oauthAccount.emailAddress;

**Limit** — It is evidence about rows in one SQLite file at export time, not a tamper-proof chain
— until the hash chain and signed checkpoints land, integrity rests on the file's own checksum.

*Extends the earlier entry "Compliance evidence pack export".*

### 18. Accessibility pass and an exact-numbers toggle

`Desktop` · `Procurement` · **M** · exact · 3/5

A grep across apps/mac finds zero accessibility modifiers and two keyboardShortcut calls. Three
concrete gaps: severity and confidence are conveyed by colour plus a glyph set VoiceOver never
names (Pal.severity, ConfidenceBadge in MenuPanel.swift:33); every headline figure passes through
Fmt.compact so '1.2M' has no exact value anywhere in the UI;

**In the app** — Everywhere: menu-bar label, MenuPanel hero and tool bars, KPI tiles, incident and
breakdown rows, the timeline; plus a 'Show exact numbers' switch in Settings.

**Source** — Theme.swift Fmt.compact/money/pct and Pal.severity/severityIcon; MenuPanel.swift
ConfidenceBadge and Sparkline;

**Limit** — An audio-graph descriptor works per series, so the stacked seven-agent timeline gets
one descriptor for the total plus per-agent series and will read poorly at 30-day ranges; Dynamic
Type at the largest sizes forces the 324pt menu-bar panel to scroll rather than reflow.

### 19. Structured incident detail: template key plus parameters

`Export` · `CISO` · **M** · exact · 4/5

anomalies.detail is NOT NULL free text today and it is the column most likely to leave the
machine: rows here read 'Burned 36,751 tokens in 10 min (3,675/min) across 2 calls — 3.0x this
model's typical 12,149-token window. Session 019e5765.' A forwarder or evidence pack either ships
the session id and paths embedded in prose or regex-scrubs free text, and both are bad. Add
detail_key plus a detail_params JSON object, render the sentence in util/format.ts and in
DB.swift, and let the exporter drop or hash individual parameters per the field registry while the
app still shows the full sentence locally.

**In the app** — No visible change on the Incidents feed — the same sentence, rendered client-side
from the key and params — while the Privacy Center's export preview gains a per-incident-type list
of which parameters are dropped or hashed on the way out.

**Source** — anomalies.detail (NOT NULL free text in schema.ts); the five detect rules that
compose it;

**Limit** — It only fixes prose written from now on: existing rows keep their rendered string and
can only be regex-scrubbed or excluded from export, and the tokens-only-grow upsert gives no path
to rewrite them. Localisation is not the goal and the renderer is not a translation layer;

### 20. Command palette, section shortcuts and a persistent filter bar

`Desktop` · `CISO` · **M** · exact · 2/5

Twelve screens with drill-downs need navigation that is not a mouse; the app today has exactly two
keyboardShortcut calls, both in MenuPanel. Add Cmd-1..9 for sections, Cmd-K for a palette over
sessions, people, agents, repos, rules and incident ids, Cmd-F for a per-section filter bar
(person, agent, repo, severity, time range) whose state persists per section as removable chips,
and J/K plus Space/Escape for row traversal and expansion.

**In the app** — A palette sheet over the window; a filter bar under the toolbar in every list
section showing active filters as removable chips;

**Source** — Existing indexed columns in usage_events and anomalies; the vole.section AppStorage
key already shared between MenuPanel and DashboardView.

**Limit** — The palette searches ids, names and paths and never content, so a query like 'find the
session that leaked the AWS key' resolves only through a finding's fingerprint, not through text.

### 21. Label carry-over across a pack bump, and the re-review queue

`Governance` · `CISO` · **M** · exact · unscored

Every finding_actions row records the content_rev in force when the human labelled it. When a pack
bump re-scores a case, the human state is kept verbatim - a machine transition never overwrites a
human label, which is what actor_kind exists to prove - and the case gains a recheck_reason only
when the re-score crossed a boundary that would plausibly have changed the verdict: severity
changed class, observed moved to the other side of threshold, or the rule's dimensions changed and
so minted a new case_key. Those and only those appear in a filtered re-review view rendering the
old figures beside the new with both content_revs named.

**In the app** — A 'Re-review (7)' filter chip in the Incidents queue, and in each affected case a
before/after figures block showing observed, baseline, threshold and severity under each
content_rev with the label the human gave and the date they gave it.

**Source** — finding_actions.content_rev;
anomalies.observed/baseline/threshold/severity/content_rev;

**Limit** — Re-scoring can only run over evidence still retained, so a case whose evidence aged
out gets recheck_unavailable and keeps its old label with the gap named on the row - the product
cannot tell whether the human would have labelled it differently, only that the figures moved and
it could not re-check.

*Extends the earlier entry "content_rev on incidents: re-score without duplicating, retire without
lying".*

### 22. Incidents as OTLP logs carrying the figures that fired

`Export` · `CISO` · **M** · exact · 5/5

The anomalies table already stores observed, baseline, threshold, detected_at and anomaly_key, and
no reader selects them — queries.ts getAnomalies projects
id/rule/severity/tool/session/model/window/title/detail/confidence/source and DB.swift:223 the
same — so a forwarder built on the existing IncidentRow would ship incidents stripped of their
evidence and break principle 3 across the wire.

**In the app** — The Incidents feed gains the three figures inline (observed vs baseline vs
threshold) — exactly the values the SIEM receives — plus a 'copy as SIEM event' action, so the
analyst and the alert cannot disagree about what fired.

**Source** — packages/core/src/schema.ts
anomalies.{observed,baseline,threshold,anomaly_key,detected_at}; packages/core/src/detect/*.ts
thresholds;

**Limit** — INSERT OR IGNORE on anomaly_key freezes the first verdict, so an incident that later
worsens is never re-emitted and the SIEM keeps the lower severity; this export is only correct
once anomalies move to an explicit upsert-on-greater-observed with a re-notify path, and
anomaly_key must stay deterministic and free of now() while that changes.

*Corrects the earlier entry "OTLP export: sessions as traces, rows as metrics, incidents as
logs".*

### 23. vole:// deep links and addressable notifications

`Desktop` · `CISO` · **S** · exact · 2/5

Register a vole:// URL scheme in apps/mac/Info.plist, which today declares no CFBundleURLTypes at
all, so a filter state, an incident or a session becomes addressable: opening a link raises the
window, sets the section, applies the filter and selects the row. Notifications then open the
exact drill-down instead of the Incidents list, and an investigator can paste a link into the
incident channel for a colleague on the same machine or fleet.

**In the app** — Deep links from UNNotification actions, from Copy-link actions on incident,
session and finding rows, and from the CLI (`vole open <anomaly_key>`); an unresolvable link opens
a clear 'this incident is not in your local database' state naming the key it looked for.

**Source** — apps/mac/Info.plist (no CFBundleURLTypes today); anomalies.anomaly_key as the stable
cross-machine identifier;

**Limit** — Row ids are per-store autoincrements, so a link must key on anomaly_key or session_id
and even then is only meaningful on a machine whose database holds that row — on any other Mac it
must say so rather than showing an empty screen.

### 24. The custody sentence: what an evidence bundle is allowed to claim

`Governance` · `DPO` · **S** · partial · unscored

One derived read model, v_custody(window_start, window_end), joining the outputs of the five
mechanisms above to a bundle's own window: run-covered milliseconds over window milliseconds, gap
count and total gap minutes, gaps-with-activity, sources whose prefix digest broke, clock_suspect
row count, whether a checkpoint covering the window was acknowledged by a sink and when, and
orphan sessions overlapping. Every export, evidence bundle, DSAR answer and control-framework
mapping renders it as one sentence carrying the actual figures.

**In the app** — A persistent Evidence Integrity header on the Privacy Center and on every export
and bundle preview: 'Monitored 96.2% of 2026-08-08 to 2026-09-07. 3 unmonitored intervals (61 min
total, 1 with agent activity).

**Source** — v_evidence_gaps; collector_state integrity columns;

**Limit** — The sentence describes Vole's own observation, not the truth: a fully covered period
can still be one in which the subject worked on another machine, in a browser, or under an account
Vole never sees. It is a coverage statement, not an innocence statement, and the screen must say
that in those words.

*Extends the earlier entry "Compliance evidence pack export".*

### 25. OTLP wire contract: pinned semconv snapshot and deterministic ids

`Export` · `Platform` · **M** · exact · 4/5

Two contracts the OTLP exporter needs before anyone can trust it. First, pin the conventions:
vendor packages/core/src/export/semconv/genai-<version>.json — the attribute registry extracted
from a named upstream commit — emit its schema_url on every OTLP resource, and add a test
asserting that every attribute name the serializer can produce exists in the snapshot with the
same type; `vole export --semconv=<version>` selects among vendored snapshots and can dual-emit
old and new names during a migration window.

**In the app** — Settings → Export gains a 'Semantic conventions' row (pinned version, upstream
commit, snapshot date, dual-emit toggle showing the exact extra attribute names it would add) and
a copyable traceparent for the most recent event, so an analyst can paste it into their trace UI
and confirm the join.

**Source** — vendored OpenTelemetry GenAI semantic-conventions registry (market.md §6: still
Development, no tagged release); packages/core/src/export/fields.ts;

**Limit** — Pinning does not make the attributes stable upstream — a customer's collector
processor may already expect a newer spelling and Vole cannot know which — and attributes with no
semconv home (cost, confidence, the cache-write 5m/1h split, subagent roll-up) live under a vole.*
prefix and are non-portable by definition.

*Extends the earlier entry "OTLP export: sessions as traces, rows as metrics, incidents as logs".*

### 26. gen_ai.provider.name normalisation with an explicit unknown bucket

`Export` · `CISO` · **S** · partial · 4/5

Semconv wants a provider from a closed enum (anthropic, openai, aws.bedrock, gcp.vertex_ai,
azure.ai.inference, x_ai) while Vole stores raw model ids of at least five shapes: claude-
opus-4-5, anthropic/claude-* (OpenCode composite), gpt-5.5, grok-composer-2.5-fast, and — seen in
a real Codex rollout on this machine — claude-opus-4.6 served through litellm behind a GitHub
Copilot exception.

**In the app** — The Breakdown pane gains a provider column above the model rows, with an 'unknown
provider' row that is clickable through to the raw model ids behind it, so the gap is a thing you
can open rather than a rounding error.

**Source** — usage_events.model; packages/core/src/pricing.ts rateFor/contextWindow prefix
handling;

**Limit** — The provider is the one declared locally, not the one that served the request: a
gateway or an ANTHROPIC_BASE_URL override can route an anthropic-shaped id to anything and the
transcript records no evidence of the hop.

*Related to the earlier entry "Provider, service-tier and gateway attribution columns".*

### 27. Span model: real execute_tool durations, honestly zero-length chat spans

`Export` · `Platform` · **L** · exact · 4/5

Roadmap-v1 says Claude spans have no duration and should be demoted to span events; that is right
for the model call and wrong for tool calls. Verified on this machine: an assistant line's
timestamp plus the matching user line's tool_result timestamp (joined on content[].tool_use.id and
confirmed by sourceToolAssistantUUID) gives true intervals — 127 ms for a Read, 1178 ms for a Bash
— and system/subtype=turn_duration carries a real durationMs (621321 ms observed) as does
stop_hook_summary.hookInfos[].durationMs.

**In the app** — Incidents and session detail gain a 'timing' column reading exact / tool-only /
none per tool, matching the vole.duration_source badge carried in the exported trace, so what the
app shows and what the trace UI shows cannot diverge.

**Source** — ~/.claude/projects/**/*.jsonl assistant timestamp + message.content[].tool_use.id,
user tool_result.tool_use_id + timestamp, system/turn_duration.durationMs,
stop_hook_summary.hookInfos[].durationMs; opencode.db message.data.time.completed;

**Limit** — turn_duration is rare — 10 of 591 transcripts here have one — so most invoke_agent
spans stay zero-length too. Tool durations are wall-clock between two transcript writes, so they
include the agent's own serialisation and any human approval wait;

*Corrects the earlier entry "OTLP export: sessions as traces, rows as metrics, incidents as
logs".*

### 28. Sink capability matrix and truthful delivery semantics

`Export` · `Platform` · **S** · exact · 3/5

Roadmap-v1 claims 'idempotent re-sends via event_key document ids' for Splunk HEC, Elastic bulk
and Datadog Logs alike — only Elastic supports that. Encode the truth as a per-sink descriptor in
packages/core/src/export/sinks/*.ts: Elastic _bulk with {"index":{"_id": event_key}} is exactly-
once by id; OTLP with deterministic span ids is deduped only if the backend dedupes at all;

**In the app** — Settings → Export sink cards each show a one-line guarantee next to the endpoint
— 'exactly-once by _id' or 'at-least-once, duplicates possible' — taken from the descriptor and
not editable by the user.

**Source** — packages/core/src/export/sinks/* descriptors; usage_events.event_key and
anomalies.anomaly_key as document ids;

**Limit** — Even on Elastic the guarantee is only as good as the id, and Codex's event_key is
`codex:<session>:<line index>` which collides across parent and sub-agent rollout files, so Codex
rows can overwrite each other in the index until that key is fixed.

*Corrects the earlier entry "SIEM forwarder (Splunk HEC / Elastic bulk / Datadog Logs)".*

### 29. Heartbeat export and the log-source-stopped dead-man's switch

`Export` · `CISO` · **S** · exact · 4/5

The first thing an attacker or an annoyed developer does is stop the collector, and a SIEM only
notices if the source was emitting a heartbeat. Every drain writes one vole.heartbeat record per
host carrying up=1, collector version, poll interval, per-tool last-seen timestamps and rows-
since-last-beat, keyed idempotently on (machine, interval bucket); the matching dead-man's-switch
detection ships in the Sigma pack, alerting when no heartbeat arrives from an enrolled host for
two intervals.

**In the app** — Settings → Export shows the last heartbeat time and the per-tool freshness table
it contained; the existing StaleBanner reads from the same source so the app and the SIEM never
disagree about whether collection is running.

**Source** — collector_state.last_scanned_at; packages/core/src/cli/collect.ts per-pass results
(filesScanned, notes);

**Limit** — collector_state is written only by the Claude Code collector — every row on this
machine is claude_code — so per-tool freshness is genuinely unknown for the other six until the
heartbeat is written from the results loop; until then those cells must read 'no run record',
never zero.

*Extends the earlier entry "Collector self-health: collector_runs, vole doctor, coverage matrix,
freshness attestation".*

### 30. Incident evidence bundle with byte-offset provenance and the figures that fired

`Export` · `CISO` · **L** · partial · 5/5

`vole evidence <incident_id>` writes one JSON and one markdown file holding the anomaly row
including observed, baseline and threshold — columns that exist in schema.ts but that no reader
selects today (queries.ts getAnomalies and DB.swift:223 both project title/detail/confidence
only), which breaks principle 3 in the one place it matters most — plus the autonomy_interval and
its granted_by, every tool_call in the window with its authority state and path classes, the
bounding human-origin entries, and for each fact a raw_ref of <transcript path>#<byte offset> so
an auditor can re-read the original line.

**In the app** — An 'Export evidence' button on the incident detail that writes the bundle and
reveals it in Finder, with the three figures (observed vs baseline vs threshold) shown inline and
a preview of the hash chain in the detail pane, so the reviewer sees exactly what would leave
before anything leaves.

**Source** — anomalies.{observed,baseline,threshold,anomaly_key,detected_at}; tool_calls;

**Limit** — Claude Code deletes transcripts after cleanupPeriodDays — unset on this machine, so
the tool default applies — and a byte offset is re-readable only inside that horizon; the bundle
records the horizon and marks each raw_ref verifiable or expired at export time.

*Extends the earlier entry "Compliance evidence pack export".*

### 31. Source-prefix integrity: a chained digest beside every byte offset

`Export` · `CISO` · **M** · exact · unscored

readNewLines already holds exactly the bytes it consumed, so chain a digest over them instead of
throwing them away: prefix_sha256 = sha256(prev_digest || newly_consumed_bytes), cost O(new bytes)
and never a re-read. Add prefix_sha256, head_sha256 (first 4 KiB, the O(1) per-poll probe), inode
and birthtime_ms to collector_state, all of which fs.statSync already returns and Vole discards.

**In the app** — Each source row in the Coverage strip gets a shield state (verified / rewritten /
no offset). A source_rewritten incident card shows path, offset, digest before and after, and the
ingested row count now in question.

**Source** — collector_state {source_path, last_offset, last_mtime} (641 rows here); fs.statSync
{ino, dev, birthtimeMs, ctimeMs, nlink} already returned by util/jsonl.ts's statSync call;

**Limit** — Only incrementally-read files have offsets, and today that is claude_code alone — all
641 collector_state rows. Codex, Grok, OpenCode, Cursor and Devin re-read in full every poll, so
there is no prefix to chain until they get offsets.

### 32. Per-rule detection quality with a labelled-fraction floor

`Export` · `Platform` · **S** · exact · unscored

Add v_rule_quality: per rule and per content_rev, findings, cases, labelled cases split by state
(false_positive, expected, accepted_risk, resolved), unlabelled cases, and the label_mode split
between individually opened and bulk-swept. The precision ratio is printed only when labelled
cases clear a floor (default 20 cases and 20% of the rule's cases); below it the cell renders an
em dash and the literal denominator, '9 of 21 cases labelled'.

**In the app** — A Detection Quality table in the Policy screen, one row per rule with fired /
cases / labelled / false-positive / unlabelled / precision-or-em-dash, and the same table appended
to the weekly digest markdown.

**Source** — finding_actions.state and label_mode joined to anomalies.rule/case_key/content_rev in
~/.vole/vole.db

**Limit** — Precision is knowable only over labelled cases and labellers choose the interesting
ones, so the figure is biased upward or downward in a direction the product cannot measure - the
view says so in the column header rather than in a footnote. Recall is never shown at all, because
Vole cannot count the findings it failed to produce.

*Extends the earlier entry "Rule dry-run and weekly tuning facts".*

### 33. Noise budget per host per week, and the rules that blew it

`Export` · `CISO` · **S** · exact · unscored

Add v_noise_budget grouping anomalies by (machine, rule, ISO week) on detected_at, against a
budget shipped as a content pack (~/.vole/policy/noise.json, admin-overridable in managed mode)
giving findings-per-host-per-week per rule and overall. A noise_budget_exceeded info incident
fires with anomaly_key noise_budget:<machine_hash>:<rule>:<iso_week> - anchored on the week, so it
fires once per rule per week and cannot re-fire on every five-second poll - and the meta-rule is
excluded from its own count.

**In the app** — A budget strip at the top of the Incidents queue ('this week: 61 of 40 budgeted -
burn_rate_spike 38, loop_suspected 14') with the offending rules linking into Detection Quality,
and the same figures in the digest.

**Source** — anomalies.detected_at, machine, rule in ~/.vole/vole.db (250 live rows, 174 sharing
one backfill detected_at); new ~/.vole/policy/noise.json

**Limit** — The budget counts findings written, so a week when the collector was down looks quiet
- the view joins evidence_gaps and prints the unmonitored hours beside the count rather than
letting silence read as calm.

### 34. MTTA and MTTR from Vole's own clocks, with unattended as a first-class state

`Export` · `CISO` · **S** · partial · unscored

Compute MTTA as the median of (first finding_actions.ts minus anomalies.detected_at) per rule over
cases that actually have an action, and MTTR as the same against the first terminal-state action -
both only from timestamps Vole itself wrote, never from a vendor clock and never from window_end.
Beside every median sits the complementary count of cases with no action at all, split by whether
a queue_opened record (from the action spool) ever landed during the case's open life: a case
nobody could have triaged because the app was never opened is reported as unattended, and a case
left alone while the queue was demonstrably open is unactioned.

**In the app** — A response panel in Detection Quality showing MTTA/MTTR per rule with the
unattended and unactioned counts as their own columns, plus a queue-header line naming the last
time the triage screen was opened.

**Source** — anomalies.detected_at joined to finding_actions.ts; queue_opened rows from
~/.vole/inbox/actions.jsonl

**Limit** — detected_at is Vole's discovery time, not the event time - 174 of the 250 live rows
here share a single detected_at because they were all found in the first pass - so
discovery='backfill' rows are excluded from MTTA entirely rather than handed a plausible-looking
number.

### 35. Versioned export shapes for the secret and tool-call ledgers

`Export` · `CISO` · **M** · partial · 4/5

One versioned row shape per new ledger, both bound by the field registry. vole.secret_sighting.v1
is {fingerprint, key_epoch, detector_id, pack_version, class, provider_key, host, transport,
direction, normalisation, tool, session_id, agent_id, path_hmac, dir_prefix, first_seen,
last_seen, occurrences, reached_model, status, user, machine} — no value, no path, and
deliberately no byte offset, because an offset is a pointer into a plaintext file still sitting on
the endpoint and shipping it hands the SIEM a map to the secret.

**In the app** — Settings → Export 'What leaves this machine' gains both column sets with a sample
record for each; the Behaviour panel shows the tool_calls manifest inline and the Privacy Center
renders the same list, so the field list a reviewer reads is the one the serializer uses.

**Source** — secret_sightings and dlp_egress tables; tool_calls and agent_edges tables;

**Limit** — path_hmac means the receiving SIEM cannot name the file — an admin who needs the path
must re-identify on the endpoint, which is intentional and documented rather than worked around.
Correlating sightings across machines requires a shared org key, which changes the threat model
and is a separate opt-in from the local key epoch.

*Extends the earlier entry "SIEM forwarder (Splunk HEC / Elastic bulk / Datadog Logs)".*

### 36. Asset labels in the export field registry: tier travels, names are opt-in, basis never

`Export` · `CISO` · **S** · exact · unscored

Asset fields enter the deny-by-default export field registry explicitly and split three ways,
because a crown-jewel list is itself intelligence: asset_tier and asset_match (the chain link) are
exportable by default so a SIEM can prioritise; asset_id and owner are opt-in per sink; basis and
the register's raw match strings (declared hosts, DSNs, path globs, salted literals) are never
exportable at any setting, enforced by an encoder test that fails if they appear in a serialized
payload.

**In the app** — The Privacy Center export-payload inspector shows every asset field with its
three-state marker (always / opt-in / never), and the field dictionary explains in one line why
basis cannot leave the device.

**Source** — the export field registry and NULL-omitting encoder; anomalies.asset_tier / asset_id;

**Limit** — Tier alone still leaks structure: a SIEM that sees 'tier 1' on 14 incidents learns the
org has tier-1 assets and roughly how many. The honest answer is the sink capability matrix
showing what each destination receives, not a claim of zero disclosure.

### 37. Vendor-join key ledger (event_links) for pivoting into vendor records

`Export` · `CISO` · **M** · partial · 4/5

A SIEM's value comes from joining Vole rows to the vendor's own records, which needs the ids the
vendors themselves use — all present on disk and all discarded today. Beyond v1's three
correlation columns, add an `event_links(event_key, kind, value)` table for the many-valued ids:
Claude message.content[].tool_use.id (toolu_…) and the bridge-session
ownerAccountUuid/ownerOrganizationUuid, and Codex token_usage_record.payload.{response_id,
turn_id, root_turn_id, thread_id} plus the line ordinal.

**In the app** — Session detail gains a copyable 'join keys' block per call (request id, response
id, tool call ids, thread id); the Incidents feed exposes the same block for the session that
fired.

**Source** — ~/.claude/projects/**/*.jsonl requestId/uuid/parentUuid/promptId and
content[].tool_use.id, type:'bridge-session' owner uuids; ~/.codex/sessions/**/rollout-*.jsonl
token_usage_record.payload.{response_id, turn_id, root_turn_id, thread_id} and the top-level
ordinal.

**Limit** — requestId appears only on assistant lines that reached the API, so cached, aborted and
local-only turns have none, and promptId lives on user lines, so linking it to an assistant row
needs a persisted uuid chain that incremental offset reads can lose. response_id exists only in
Codex's newer token_usage_record type, so older rollouts cannot be joined at all.

*Extends the earlier entry "Correlation ids: request_id, turn_id, entry_uuid columns".*

### 38. Clock sanity from boot-anchored uptime, with a clock_suspect tag that reorders nothing

`Export` · `Platform` · **S** · exact · unscored

Record both wall_ms and boot_epoch_s = floor(Date.now()/1000) - os.uptime() on every
collector_runs row; verified on this machine that pair equals sysctl kern.boottime to the second
(1788227235), so it needs no subprocess, no network and works inside the SEA. Within one boot the
derived boot epoch is constant, so a wall-clock change moves it: boot_epoch shifting while uptime
keeps increasing gives the exact shift in seconds, and wall_ms going backwards between consecutive
runs is a rollback.

**In the app** — A clock chip on the Coverage strip; affected timeline buckets and incident cards
carry a small clock marker reading the measured shift, e.g.

**Source** — node:os uptime() and Date.now() at each collector pass, written to collector_runs;
new nullable usage_events.clock_suspect column

**Limit** — A reboot resets uptime, so a clock change made while the machine was powered off is
invisible — only the post-boot NTP correction shows, and it is indistinguishable from a legitimate
first sync on a machine that was off for a week. Shifts smaller than the poll interval are lost.

*Extends the earlier entry "Collector self-health: collector_runs, vole doctor, coverage matrix,
freshness attestation".*

### 39. Two clocks on every row and measured observation lag per tool

`Export` · `Platform` · **M** · partial · 3/5

Vole reads files the agent wrote after the fact, so its true detection latency is flush time plus
poll interval, and its rows already mix two clocks — the agent's own timestamp from the transcript
and the moment Vole read it — which today collapse into one ts column and, worse, into Date.now()
when the source timestamp is missing (claude-code.ts and codex.ts both fall back). Stamp
observed_at at insert in db.ts and export both vole.event_time and vole.collected_at with
vole.time_source reading 'source' or 'collector', so a row whose timestamp was invented is
labelled rather than trusted;

**In the app** — Settings → Sources gains a lag column per tool (p50 / p95 over the range) with a
plain-language line, 'incidents for this tool are detected on average N seconds after the call';
Settings → Export shows 'clock offset vs <sink>: +1.4 s (measured 09:41)' or an em dash when no
sink has replied;

**Source** — usage_events.ts; packages/core/src/collectors/claude-code.ts and codex.ts Date.now()
fallbacks;

**Limit** — For the six collectors that re-read their whole source each pass, observed_at is the
poll that noticed the row, so the measured lag is an upper bound that folds Vole's own interval
together with the agent's flush delay and cannot separate them.

### 40. Witness-orphan sessions: the ones that left no row at all

`Export` · `CISO` · **M** · exact · unscored

Left-anti-join every session id seen by a survivor artifact against both the transcripts on disk
and usage_events.session_id, writing three distinct outcomes into orphan_sessions: pruned (no
transcript, last witness older than .last-cleanup and outside the retention period — the tool's
own housekeeping, not a finding), deleted (no transcript, but the witness timestamp is newer than
the last cleanup or inside the retention window), and never_ingested (no transcript and no
usage_events row, so Vole never saw it and no raw_ref can ever point at it). On this machine that
is 1 of 13 Claude history session ids with no transcript, and 0 of 55 Codex index ids missing.

**In the app** — A Sessions gap list under Coverage: id, which witness saw it, its timestamp, a
classification chip (pruned / deleted / never ingested), and the project. The People view's
attribution-coverage figure gains '+N sessions witnessed but not ingested' so the denominator
stops flattering itself.

**Source** — ~/.claude/history.jsonl {sessionId, timestamp, project}; ~/.claude.json
projects[].{lastSessionId, lastStartTime, lastCost};

**Limit** — The witnesses are ordinary user-writable files in the same home — deleting the
transcript and the history.jsonl line together leaves nothing, and ~/.claude.json keeps only the
last session per project, so a deleted middle session is unwitnessed.

*Corrects the earlier entry "History horizon and retention-loss disclosure".*

### 41. evidence_gaps: unmonitored intervals proved by the agents' own clocks

`Export` · `CISO` · **M** · partial · unscored

Derive gaps, never assert them: sort collector_runs by started_at within one store epoch and treat
any interval longer than 3x the effective poll interval as a candidate. Then count activity
timestamps that fall inside the interval from witnesses that need no Vole run at all —
usage_events.ts ingested later, ~/.claude/history.jsonl timestamps (18 lines here),
~/.claude/sessions/<pid>.json startedAt, ~/.codex/session_index.jsonl updated_at (55 ids),
~/.codex/logs_2.sqlite logs.ts (3,965 rows spanning 1788757180-1788758921, written independently
of the rollouts), and collector_state.last_mtime (641 rows).

**In the app** — Coverage strip gains a second figure — 'monitored 96.2% of the last 30 days; 3
gaps, 1 with activity' — clicking opens a Gaps list (interval, length, witness counts broken out
by artifact, and what was running).

**Source** — collector_runs (v1 Tier 1); ~/.claude/history.jsonl {timestamp, sessionId, project};

**Limit** — A gap with no witness stays silent and renders as 'unobserved, no activity witness' —
a closed laptop is not tampering and must never be scored as such. Before collector_runs has its
first row there is no run record at all, so the entire pre-install past is 'no run record', not
'monitored'.

*Extends the earlier entry "Collector self-health: collector_runs, vole doctor, coverage matrix,
freshness attestation".*

### 42. Pack inventory on the wire: the only signal that a rollout missed a laptop

`Export` · `Platform` · **S** · exact · unscored

Because Vole never fetches, telemetry is the sole way an admin learns that 200 machines missed a
pack, so the existing heartbeat export emits one record per content_pack — kind, version,
built_at, age_days, ring, load_state, trust, sha256 — and every exported finding, incident and
tool-call row carries its `content_rev`. Resource attributes `vole.content.<kind>.version` and
`vole.content.<kind>.age_days` ride every OTLP batch so a SIEM groups by version without a join,
and the field registry gains those keys explicitly (the export is deny-by-default).

**In the app** — No new screen: the Content table already lists exactly what is exported, and the
Privacy Center's live export-payload inspector shows the pack records verbatim as they leave,
which is where a DPO checks that a pack row carries no personal data.

**Source** — content_packs rows; the existing export outbox, heartbeat export and export_seq
cursor.

**Limit** — A laptop that is both stale and not exporting is invisible in both places — the dead-
man's switch detects absent heartbeats, not absent content. Ring membership is whatever the
admin's MDM wrote locally, so Vole can report which ring this machine claims but cannot verify
that the canary ring is the twenty machines the admin intended.

### 43. MCP inventory export in server.json shape

`Export` · `CISO` · **S** · exact · 4/5

Emit `vole export --mcp --format=server-json`, mapping posture_mcp_servers onto the MCP registry's
server.json object shape (name, description, version, packages[] with
registryType/identifier/version/runtimeHint, remotes[] with type/url) plus an x-vole extension
block carrying mcp_identity, first_seen, last_seen, observed_call_count, config_path and
instruction_block_sha256. One file per host, deterministic ordering, no timestamps in the body, so
two runs against an unchanged machine diff to nothing and an org can compare its real observed MCP
estate against a curated internal registry with plain `diff`. Writing the file is local;

**In the app** — Supply Chain → MCP toolbar gains an Export button that writes the file and
reveals it in Finder; Settings shows the last export path and row count.

**Source** — posture_mcp_servers joined to observed mcp__<server>__ call counts in tool_calls and
posture_injected_text hashes; ~/.claude.json mcpServers, .mcp.json, ~/.codex/config.toml.

**Limit** — server.json describes a package or registry entry, and Vole can fill only the fields a
local registration actually contains: description, publisher and canonical version are NULL for a
locally registered `npx -y <pkg>` entry, and the export omits NULL rather than inventing a
placeholder.

### 44. Fleet / osquery ATC table pack

`Export` · `Platform` · **S** · partial · 4/5

The cheapest enterprise distribution is not a second agent: osquery's Automatic Table Construction
reads SQLite files directly, so ship docs/fleet/vole-atc.conf declaring vole_usage_events,
vole_anomalies and vole_sources over ~/.vole/vole.db plus a query pack of saved queries (agents
seen per host, sessions in bypass mode, incidents in the last 24 h, tokens by model, unpriced call
share). Fleet then reports Vole's evidence on the schedule it already runs, with no new daemon, no
new port and no export path.

**In the app** — Settings → Export gains a 'Fleet / osquery' section with a Copy button for the
generated ATC config, the exact DB path it points at, and the column list it exposes.

**Source** — ~/.vole/vole.db (usage_events, anomalies, collector_state);
packages/core/src/sync/manifest.ts for the allowed column list;

**Limit** — ATC takes a fixed path and Vole's store lives under a user home, so a shared or multi-
account Mac needs one ATC entry per home or a world-readable derived copy under /Library, which is
a new artifact with its own privacy question.

*Related to the earlier entry "SIEM forwarder (Splunk HEC / Elastic bulk / Datadog Logs)".*

### 45. Export sink volume and cardinality measured from real serialized bytes

`Export` · `Platform` · **M** · partial · 3/5

Every SIEM and observability contract meters something — Splunk and Sentinel by GB, Datadog by
custom metric series and spans, Elastic by field count — so the question after 'can you export' is
always 'what will this cost me'. Before a sink is enabled, serialize the last seven days of real
rows through that sink's exact encoder in memory and report measured bytes/day, events/day,
spans/day and distinct metric series (the true cardinality of tool × model × confidence × project
present in the data), plus the same figures projected over 30 days and labelled as a projection
with its window.

**In the app** — Settings → Export: each sink card shows 'measured: 41 MB/day, 128k events/day,
312 series (7-day sample)' with a link to the exact range measured, rendered above the Enable
switch rather than after it.

**Source** — usage_events and anomalies for the selected range; the per-sink encoder in
packages/core/src/export/sinks/*.

**Limit** — A seven-day sample is a sample — a busy sprint or a new agent rollout changes the
figure, which is why it is labelled with its window rather than presented as a rate.

*Related to the earlier entry "vole export with versioned public schema (vole.event.v1)".*

### 46. Detection content pack: Sigma, SPL and EQL generated from the rule registry

`Export` · `CISO` · **M** · partial · 3/5

A new log source is worthless until someone writes detections over it, so ship them. Generate
docs/siem/sigma/*.yml plus Splunk SPL and Elastic EQL equivalents from the same rule registry the
detectors use, covering the exported fields: a session running in bypassPermissions, a
secret_finding row, a shadow account class, a burn-rate incident above threshold, a missing
heartbeat, and an unmanaged telemetry endpoint. Because field names come from
packages/core/src/export/fields.ts and rule ids from packages/core/src/detect/index.ts, a rename
in code regenerates the content and a test fails if a shipped rule references a field the exporter
cannot emit.

**In the app** — Settings → Export → 'Detection content' listing the generated rules with a Reveal
in Finder action and the rule ids they correspond to; no runtime behaviour is added to the app.

**Source** — packages/core/src/detect/index.ts rule list and per-rule thresholds (with the
RuleConfig DEFAULTS once they exist); packages/core/src/export/fields.ts wire names.

**Limit** — Sigma has no product/service taxonomy for AI agents, so the pack uses a custom
`product: vole` that no backend recognises out of the box and every customer must convert with
sigma-cli themselves.

### 47. RFC 5424 syslog and CEF sinks for the SIEMs that predate JSON

`Export` · `CISO` · **S** · network · 3/5

QRadar, ArcSight and most on-prem log estates still ingest syslog and cannot take OTLP, so add two
thin sinks over the same field registry: RFC 5424 with a structured-data element [vole@<PEN>
event_key="..." tool="..." confidence="..." observed="..."] over TCP+TLS, and ArcSight CEF
(CEF:0|Vole|vole|<version>|<rule>|<title>|<sev>| plus mapped extensions) for incidents only. Both
build their payload by iterating packages/core/src/export/fields.ts, so a column that cannot leave
over OTLP cannot leave over syslog either, and neither carries a free-text message body beyond the
rule name.

**In the app** — Settings → Export sink picker gains 'Syslog (RFC 5424)' and 'CEF' entries with
host, port and TLS fields plus a live one-line preview of the exact framed message that would be
sent.

**Source** — packages/core/src/export/fields.ts;
anomalies.{rule,severity,observed,baseline,threshold};

**Limit** — Syslog has no acknowledgement and no document id: over UDP messages are lost silently,
and over TCP a relay may still truncate at 1024 or 2048 bytes so long attribute sets are cut mid-
field.

### 48. Microsoft Sentinel connector generated from the field registry

`Export` · `CISO` · **L** · network · 4/5

Sentinel ingest for a custom source is a fixed shape: a Data Collection Endpoint, a Data
Collection Rule declaring a column schema, and a *_CL custom table. Generate docs/siem/sentinel/ —
the ARM template, the DCR transform KQL, and the VoleAgentEvents_CL and VoleIncidents_CL table
schemas — directly from packages/core/src/export/fields.ts, so adding a column regenerates the DCR
and schema drift between Vole and the table is structurally impossible. The sink posts to the Logs
Ingestion API using the same export_seq cursor and outbox as every other sink, with a client
credential held in the Keychain and never in the DB.

**In the app** — Settings → Export sink card 'Microsoft Sentinel' showing the DCE URI, DCR
immutable id and stream name, with a 'Download ARM template' action and the projected monthly GB
before the sink can be enabled.

**Source** — packages/core/src/export/fields.ts as the schema generator input; usage_events and
anomalies rows;

**Limit** — Purview is the request buyers actually voice and it is the one Vole should decline:
Purview DSPM for AI ingests from its own browser extension and device onboarding with no public
ingestion API for third-party AI events, so the only honest answer is Sentinel plus a note
explaining why Purview is not possible rather than a half-working connector.

*Related to the earlier entry "SIEM forwarder (Splunk HEC / Elastic bulk / Datadog Logs)".*

### 49. Loopback OTLP receiver with parser-fidelity reconciliation

`Export` · `CISO` · **L** · new instr. · 5/5

Claude Code's own opt-in telemetry emits things the JSONL never records:
claude_code.lines_of_code.count, claude_code.code_edit_tool.decision (accept/reject), and the
events tool_decision with its source (config / hook / user_permanent / user_temporary),
permission_mode_changed, mcp_server_connection, plugin_installed, hook_* and auth. Add `vole
collect --otel-listen` binding 127.0.0.1:4318 only and refusing any other bind, accepting
http/protobuf and http/json, writing to a separate agent_telemetry(id, tool, session_id,
event_name, ts, attrs_json, source) table — never into usage_events, because these numbers are
tool-reported rather than parsed and must keep a different provenance badge;

**In the app** — A new Monitor → 'Agent-reported' pane listing permission-mode changes, tool
decisions and MCP connections with a 'tool-reported' badge visibly distinct from the parsed rows
everywhere else in the app; the gap incident appears in the normal Incidents feed naming the
session, both figures and the delta;

**Source** — OTLP/HTTP on 127.0.0.1:4318 from Claude Code with CLAUDE_CODE_ENABLE_TELEMETRY=1;
[otel] in ~/.codex/config.toml (exporter none by default);

**Limit** — This only covers sessions where someone turned telemetry on, which is not the default,
so both the pane and the reconciliation are a spot check on a subset and must be shown as such
rather than as zero or as fleet-wide assurance.

*Extends the earlier entry "OTEL receiver collector for tools that only telemeter".*


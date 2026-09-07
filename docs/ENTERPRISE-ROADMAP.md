# Vole Enterprise Roadmap

**368 features in 8 tiers**, for turning Vole from a local usage monitor into a telemetry
security system a company deploys: which AI agents each employee actually uses (including the
ones nobody provisioned), under which account, what sensitive data reached a model, and what the
agents did with authority they were never granted.

How it was built: every line of this repository was read and mapped; 275 sourced market findings
and 62 competing products were surveyed; features were proposed across 12 lenses plus 18
completeness sweeps; and every feature was checked by an adversarial reviewer who opened the
named file and quoted the field before accepting it. Full per-feature detail — complete
description, the verification quote, the constraint analysis — is in
[`enterprise/features.json`](enterprise/features.json).

[ROADMAP.md](ROADMAP.md) stays the near-term engineering list. This is the product direction.
Market evidence and the competitive picture are in [MARKET.md](MARKET.md).

## Contents

- [Positioning](#positioning)
- [Blockers](#blockers--these-land-before-any-enterprise-feature)
- [The first 90 days](#the-first-90-days)
- [Product architecture](#product-architecture)
- [The tiers](#the-tiers)
- [Do not build](#do-not-build)
- [Open questions](#open-questions)

---

## Positioning

Vole is the out-of-path endpoint evidence layer for company AI use: it reads only what the agents
already wrote to the employee's own disk and answers, per employee and per laptop, which AI
surfaces are in use (including the ones IT never provisioned), which account and auth path paid
for them, what sensitive data reached which model, and what the agents did with tools and
authority they were never granted — without a proxy, a kernel extension, a browser extension, or a
single stored prompt. The wedge is the intersection nobody occupies: every competitor that covers
coding agents sits in the request path (gateway, hook, ES sensor, enterprise browser) and inspects
content; every vendor console is single-tool and blind to personal accounts, raw API keys,
Bedrock/Vertex, local gateways and competitors' agents. Vole is deliberately the opposite of all
of them — no request path, no content, no latency, no vendor account required — and it says out
loud what it cannot see. That last property is not a caveat but the product: a per-employee
monitoring system only clears a DPO, a works council and a security questionnaire if "we do not
store prompts" is provable by construction and every figure ships with its own denominator.
Commercially it is sold from the security budget ("AI usage control") as the coverage layer beside
CrowdStrike/Zscaler/LiteLLM — the coverage-delta report ("here are the agents, accounts and
gateways your gateway cannot see, computed on your own machine") is both the demo and the reason
to buy, and it is free for a developer to run before procurement ever hears the name.

---

## Blockers — these land before any enterprise feature

From the code audit: defects in shipped code that make a later feature impossible or untrue.

**B1. The packaged .app fatalErrors on launch: Bundle.module's generated accessor looks for Vole_Vole.bundle inside the .app root and then a hard-coded developer path, while bundle.sh copies it to Contents/Resources.**

`apps/mac/Sources/Vole/VoleApp.swift:51` — **fixed**, see `Res` in `Theme.swift`.

Every shipped bundle crashes at launch, so no design partner has ever run the product;
Theme.swift's ToolIcon takes the same path, and no amount of new features is observable until the
app opens.

**B2. Codex event_key is `codex:<sessionId ?? filePath>:<line index>`, and sub-agent rollout files replay the parent's session_meta, so parent and child rows collide on the same key.**

`packages/core/src/collectors/codex.ts:197`

It violates the idempotency contract that the whole store rests on: rows are silently lost or
overwritten, session-tree cost roll-up is wrong by construction, and any per-employee or per-
session attribution built on Codex inherits the corruption. Every ledger, cost and identity
feature keyed to a Codex session is wrong until this is fixed.

**B3. Detection runs every rule over the entire usage_events table every five seconds, and medianExcluding is O(W log W) called once per window, giving O(W² log W) per tool+model per poll — about 15.6 seconds at 20k windows.**

`packages/core/src/detect/util.ts:56`

The collector already burns a core on a single developer's history; adding tool_calls,
secret_sightings and posture rules multiplies the row count by an order of magnitude.

**B4. pnpm verify compares stored rows against source records and fails when a stored row has no matching log entry (claudeNotInLogs, and the claudeRowsTotal <= truth.size assertion).**

`packages/core/src/cli/verify.ts:528`

Principle 4 says verify must keep passing, and the app's Settings pane already claims 'every
stored row reconciled'. After a month of real use verify fails permanently on healthy data, so the
one artefact that proves the product does not invent numbers becomes noise — and it currently
PASSes on an empty database, which is the opposite failure.

**B5. Tool names are lost on roughly half of all tool_use turns (7,102 of 14,238 rows in the live store) because only the first content block copy is read, and the upsert's `WHERE excluded.total_tokens > usage_events.total_tokens` guard blocks a later, more complete copy from healing the row.**

`packages/core/src/collectors/claude-code.ts:150`

The tool_calls ledger, the authority model, the destructive-command classifier and every behaviour
rule read tool identity. Building them on a column that is NULL half the time produces a security
product whose central claim ('what did the agent run') is a coin flip, and the upsert guard means
the data cannot be repaired after the fact without a declared backfill step.

**B6. burn_rate_spike scores total_tokens, which includes cache-read tokens priced at 0.1×, so the median firing window here is 99% cache reads.**

`packages/core/src/detect/burn-rate.ts:29`

188 of 244 live incidents are this rule and 14.8% of all windows fire, which means the incident
feed is noise before a single enterprise rule is added. A triage queue, a SIEM export and a noise
budget are all meaningless while the loudest rule measures the cheapest thing in the system.

**B7. loop_suspected only fires when a bucket exceeds 3× the session's own leave-one-out median, so an agent that loops at a constant rate from its first turn never triggers.**

`packages/core/src/detect/loop.ts:34`

The runaway-agent case the rule exists to catch — a steady loop burning tokens or hammering a tool
from turn one — is undetectable by construction, so the product currently cannot detect the
failure mode it advertises. It also blocks the agent-scoped behaviour rules that reuse the same
rate machinery.

**B8. openDb never sets busy_timeout (SQLite default 0) while two writers are explicitly tolerated — the app spawns the embedded collector while a developer may run pnpm collect.**

`packages/core/src/db.ts:60`

A SQLITE_BUSY aborts a whole collection pass or the app's first read, which shows up as missing
data with no error a user can see. Every new table multiplies the writes per pass, so the
collision rate rises exactly as the enterprise features land.

**B9. apps/mac/Icon/build.mjs imports sharp, which appears nowhere in the lockfile, and bundle.sh invokes it whenever Vole.icns is missing — which is always on a fresh clone.**

`apps/mac/Icon/build.mjs:15`

pnpm app:bundle fails on any machine that is not the author's, so nobody else can produce a build
— including CI, including a design partner, including the release pipeline that has to sign and
notarise.

**B10. build-sea.mjs copies process.execPath as the SEA host binary, so the shipped collector is whatever Node the builder happened to run (here ~/.hermes/node v26.7;**

`packages/core/scripts/build-sea.mjs:49`

A binary that only runs on machines resembling the build host fails on the customer's laptop with
a dyld error, and an unpinned, unrecorded embedded runtime cannot pass a security questionnaire,
an SBOM requirement or notarisation review. The MDM-deployed pkg is the delivery mechanism for
everything in tiers 3 through 8.

---

## The first 90 days

1. Weeks 1-2 — Make it launchable. Fix the Bundle.module resource path, commit a prebuilt
   Vole.icns and delete the sharp dependency, pin the SEA Node by version and SHA instead of
   copying process.execPath, set busy_timeout and add a read-only open path for every reader CLI.
   Add a CI ship-gate that builds the bundle, runs the .app headless with --dump, and fails the
   job on a non-zero exit. Exit criterion: a signed, notarised DMG that someone other than the
   author can install and open.

2. Weeks 2-3 — Make the numbers true. Rewrite the Codex event_key on source-native identity with a
   shared-session-id fixture; union tool names across content-block copies and widen the upsert
   with an explicit NULL-only-widening clause plus a one-time declared backfill; replace
   burn_rate_spike with billable_burn_spike and loop_suspected with an absolute-rate
   repeat_call_loop; switch anomalies to an upsert with a separate escalation channel so warn can
   become critical; give verify a source-horizon (pruned sources reported, not failed), a FAIL on
   an empty store, and the missing Grok section. Exit criterion: verify passes on a month-old
   store and the live incident feed is no longer 77% cache-read noise.

3. Weeks 3-4 — Cut the seams. Add schema_migrations with PRAGMA user_version shared with DB.swift;
   widen CollectorResult with surfaces, findings, toolCalls and observations plus a structured
   CollectorNote; open the REGISTRY with register() and thread an onEntry(entry, ctx) hook through
   all six content-bearing collectors; add scan_state and a scanner cadence lane that never joins
   the 5s poll; replace the O(W log W) leave-one-out median with an O(W) baseline pass and gate
   detection on inserts within a bounded window; write collector_runs and a real per-collector
   heartbeat. Exit criterion: a no-op onEntry hook is called for every entry in every collector,
   detection costs milliseconds, and the app stops showing 'Setting up…' for non-Claude users.

4. Weeks 4-5 — Shadow AI census, part one (the local artefacts). Build ai_surfaces plus
   surface_activity: installed AI app census by bundle id and signing Team ID, the
   LaunchAgent/LaunchDaemon AI-gateway inventory (this machine has three), the AI CLI and package-
   manager inventory across PATH, npm global, pipx and Caskroom, local model runtimes with the
   exposed-bind check, ghost apps that ran and were deleted, and multi-root agent-home discovery
   including CLAUDE_CONFIG_DIR and CODEX_HOME redirects. Every row carries an evidence rank and a
   first_seen. Exit criterion: `vole surfaces` on a real laptop lists surfaces the owner did not
   know were there.

5. Weeks 5-6 — Shadow AI census, part two (the screen and the firewall). Add the rerouted-model
   detector straight from the model column with CCR hex decode, model-route rewrite evidence from
   rejected key labels and config backups, browser AI-host visit counts and extension reach, IDE
   extension census, the new_ai_surface rule, a surfaces.json sanctioned declaration with the
   unsanctioned-surface rule, and `verify --surfaces` as the firewall between inventory and usage.
   Ship the Shadow AI screen with an evidence-ladder card and a coverage strip. Exit criterion:
   the demo sentence 'this laptop runs N AI surfaces, M of which nobody provisioned, and here is
   the evidence for each' renders on a stranger's machine.

6. Weeks 6-7 — Identity at insert. Replace db.ts origin() with resolveOrigin(): identity.json plus
   IOPlatformUUID, principal_id and device_id as Keychain-HMAC computed at insert with epoch
   rotation; add the principals and devices tables and carry the new columns into every insert;
   add session_identity with a binding_evidence rank, the account-class classifier from the auth
   path, the console_invisible tag and the cloud-provider class from model-id shape; add
   v_events_principal as the read-time join and put principal into the detection partition and the
   anomaly key. Exit criterion: every row is attributable to a pseudonymous principal, no row
   anywhere contains an email or a real name, and `verify --identity` proves it.

7. Weeks 7-8 — The privacy floor, shipped in the same release. Deployment-mode resolver (personal
   vs managed), first-run scope gate with real consent in personal mode and a declared lawful
   basis in managed mode, the shipped read manifest with per-scanner switches, the egress
   inventory with a network_calls ledger and a VOLE_NO_EGRESS switch every caller honours
   (including the update check, which becomes opt-in), Privacy Center v1 with path receipts and a
   field dictionary, the per-person view gate with an access log and subject notice, and the NON-
   GOALS charter with its canary test. Ship v_people with attribution coverage on every figure.
   Exit criterion: a DPO can read one screen and see every path Vole reads, every field it stores,
   and every byte that could leave.

8. Weeks 8-9 — Data exposure, part one (the engine). Ship dlp_detectors as a versioned builtin
   pack with offline checksum validators, the out-of-path scan engine with dlp_scan_state cursors,
   a keyword prefilter and a hard byte budget, secret_sightings with a widening upsert and a
   Keychain-held fingerprint key, the pre-match normalisation layer with a provenance badge, and
   the content boundary as a branded type with `verify --content` as its runtime twin. Exit
   criterion: a planted test credential in a real transcript is found, fingerprinted and never
   stored in cleartext, and verify --content passes over the whole store.

9. Weeks 9-10 — Data exposure, part two (the sinks and the screen). Direction tagging normalised
   across all six content-bearing collectors; Claude's own at-rest sinks (spill files, file-
   history, shell snapshots, rotating config backups); Codex thread_history with an ordinal
   watermark; Cursor, Antigravity and Devin content sinks; the permission-allowlist inline-command
   scan; cross-sink fingerprint correlation with first-origin; finding lifecycle with fixture
   auto-classification and rotation state; evidence-expiry countdown with oldest-first backfill.
   Ship the Leak Ledger screen with the just-in-time evidence viewer and the unreadable-bytes
   denominator. Exit criterion: 'this key, this class, this employee, this direction, this sink,
   first seen here' renders for a real finding.

10. Weeks 10-11 — Enough behaviour to be a security product. tool_calls ledger phase one for
   Claude Code, OpenCode and Codex v2 with source-native keys and a two-phase NULL-only-widening
   bind; four-state authority on every call; signal provenance (status_source, duration_kind) with
   a per-tool coverage matrix; autonomy_intervals from permissionMode, Codex approval_policy and
   sandbox_policy; the unattended_full_access evidence chain and headless_bypass_launch; the
   destructive-command classifier with cwd-relative blast radius from a versioned pattern pack;
   anomaly_context on every behaviour incident. Exit criterion: an incident opens onto the exact
   calls that produced it, each labelled with the authority it ran under.

11. Weeks 11-12 — Make it a pilot, not a demo. Deny-by-default export field registry with the
   NULL-omitting encoder; NDJSON vole.event.v1 plus the incident evidence bundle with byte-offset
   provenance and the custody sentence; export_seq cursor, durable outbox and a heartbeat with a
   log-source-stopped dead-man's switch; the triage queue with case_key and finding_actions;
   incident figures (observed, baseline, threshold) reaching every reader including DB.swift; the
   honest coverage strip and readability matrix on every screen. Ship the MDM kit: PPPC profile
   generated from Vole's own signature, managed preferences, launchd plist, and the FDA-missing
   reduced-functionality state. Exit criterion: an IT team can deploy Vole to ten laptops and a
   security team can read its output without opening the app.

12. Week 12 — Design-partner pack and the honest scorecard. Design-partner pilot mode with a hard
   expiry; seed --story with an unmissable demo bar; `vole assess --wedge` producing the
   competitor-coverage annex computed on the buyer's own machine; the coverage-and-denominators
   report saying exactly what Vole did not read; a pre-filled DPIA with measured facts and works-
   council skeletons; a written design-partner agreement with a convert-or-leave date. Exit
   criterion: five to eight partners running the real binary on real laptops, each with a signed
   agreement and a dated decision point, and a list of which of the twelve open questions their
   deployment answered.

---

## Product architecture

The shape of the enterprise product is four new lanes bolted onto one existing write path, plus
one hook that is the only place content is ever allowed to exist.

NEW TABLES (all carry `source` so the seed/live partition and `purgeSeed` still hold; all
reachable only through a numbered `schema_migrations` ledger with `PRAGMA user_version` shared
with DB.swift, because `db.ts:41-53` migrate-by-column-probing cannot express a backfill and the
tokens-only-grow upsert at `db.ts:95-101` can never widen a row on its own). Inventory lane:
`ai_surfaces` (surface_id, kind, vendor, bundle_id/exec_path, Team ID, cdhash, first_seen,
last_seen, evidence_rank, sanctioned_state), `surface_activity`, `scan_state`,
`execution_contexts`, `work_roots`. Identity lane: `principals` (principal_id = HMAC only),
`devices` (IOPlatformUUID + hostname history), `session_identity` (session_id, tool,
account_class, auth_path, org_hash, account_hash, binding_evidence rank, console_visible).
Exposure lane: `dlp_sinks`, `dlp_scan_state` (per-sink byte cursors + budget), `secret_sightings`
(keyed fingerprint, class, detector_id, pack_version, sink_id, byte_offset, direction, first_seen,
last_seen, status), `payload_sightings`. Action lane: `tool_calls` (source-native call id, name,
authority_state, status_source, duration_kind, pattern_id + pack_version), `action_targets`,
`context_edges`, `autonomy_intervals`, `grants`. Posture lane: `posture_items` keyed on endpoint
identity plus content hash, `config_history`. Governance/ops lane: `content_packs`,
`finding_actions`, `access_log`, `network_calls`, `collector_runs`, `outbox` + `export_state`,
`store_epoch`.

THE COLLECTOR onEntry HOOK. `types.ts` `CollectorResult` grows `toolCalls`, `findings`,
`observations`, `surfaces` and a structured `CollectorNote {code, path, message}`;
`collectors/index.ts:21-29`'s closed REGISTRY becomes `register()` plus `run(db, { onEntry })`.
Every content-bearing parse loop calls `onEntry(entry, { tool, filePath, byteOffset, lineIndex,
sessionId })` — `claude-code.ts:91-99`, `codex.ts:118`, `opencode.ts:104` and the part query at
`L85`, `grok.ts:102`, `devin.ts:71`, `cursor.ts:55`. This is load-bearing for the constraint that
the database holds no content: DLP findings, tool-call rows and direction tags are produced inside
that one pass and never re-derived from `usage_events.tools`, and the hook returns only classes,
ids, offsets and keyed fingerprints. Enforce it in the type system with a branded `Content` type
that cannot be assigned to any insert parameter, and at runtime with `verify --content` running
the detector pack over vole.db and every export, failing on one hit.

THE IDENTITY SEAM at `db.ts:19-35`. Today `origin()` stamps `os.userInfo().username` +
`os.hostname()` onto every row and no query has ever read either column. Replace it with
`resolveOrigin()`: `~/.vole/policy/identity.json` (the declared corporate identity, MDM-settable)
plus IOPlatformUUID for a stable device id, emitting `principal_id` and `device_id` as HMAC-SHA256
under a Keychain-held key with epoch rotation. Pseudonymise at insert, not at sync — a stolen
vole.db then carries no email, and "email and name are never stored" becomes a testable claim
(`verify --identity`) instead of a promise. The ORIGIN spread at `db.ts:129`/`154` extends to
every new table. Session-level identity is stronger than device-level, so reading goes through
`v_events_principal`, a read-time join that prefers `session_identity` where a binding exists and
prints `binding_evidence` beside every figure. The detection partition at `detect/index.ts:45-57`
grows from `source` to `(source, principal_id, device_id)` and the anomaly key gains the principal
— still with no `now()` in it, per the existing test contract.

THE POLICY ENGINE is not a DSL; it is two trust classes with different anchors. Vendor-signed
content packs (secret detectors, command-shape patterns, pricing, advisory floors, processing
terms) load offline against a checksum with an unremovable builtin floor, carry `pack_version`
onto every row they produced, and support a bounded oldest-first re-scan when they bump. Admin-
authored policy (`~/.vole/policy/`: identity.json, surfaces.json sanctioned list, assets.json
criticality register, retention, purpose/roles) is customer-anchored and, in managed mode, MDM-
delivered with the local user override losing. `detect/index.ts:18-24`'s hard-coded rule list
becomes an injectable registry taking `(events, ctx)` where ctx carries the effective threshold
and its provenance, so "sanctioned vs detected" is just another rule and every incident can render
"threshold 3× (policy.json, scope repo=…)" truthfully. Vole stays detect-and-report; enforcement
is a human-confirmed handoff to the tool that already has the lever.

EXPORT. `insertEvents`/`insertAnomalies` are already the only write path, so a post-insert
callback carrying rows actually changed is the natural outbox source; `export_seq` gives a cursor
that replays without rewinding the live tail, and `(device_id, event_key)` is the sync dedupe key.
Nothing leaves except through a deny-by-default field registry — a declared table of column →
permitted transform — encoded by a NULL-omitting encoder so an absent cost is an omission, never
`0.00`. Shapes: NDJSON `vole.event.v1`, OTLP against a pinned semconv snapshot (incidents as log
records carrying observed/baseline/threshold), syslog/CEF for old SIEMs, and osquery ATC tables so
Vole is the source rather than a second console. Every egress — including today's undisclosed
`UpdateChecker.swift:27` GET — is recorded in `network_calls` and gated by a `VOLE_NO_EGRESS`
switch every caller honours.

DESKTOP SCREENS. Overview (tiles, no composite risk score), Shadow AI, People, Data Exposure (Leak
Ledger + just-in-time evidence viewer), Behaviour/Sessions, Blast Radius, Posture, Triage queue,
Costs, Privacy Center. Two rules bind all of them: a coverage strip stating what Vole did not
read, and a readability matrix under which no screen may render a bare zero — "not recorded before
v0.2", "source unreadable", "not monitored" and "genuinely zero" are four different states. The
structural tax is real and must be paid explicitly: every read model is written twice
(`queries.ts` plus a hand-port in `DB.swift`), so a generated read-model contract and a CI parity
check ship before the screen count triples, or the app permanently lags the core.

OSS CORE VS ENTERPRISE. MIT core keeps everything on the laptop: all collectors, the onEntry hook,
the schema, the rule engine and builtin pack floor, the Mac app, the CLIs, the MCP server, local
file/stdout export, Privacy Center, DSAR and erasure. `/ee` behind a licence key covers exactly
what crosses the network or spans devices: fleet relay and server, SSO/SCIM/RBAC, managed policy
distribution and signed pack delivery, remote export sinks, vendor reconciliation adapters,
retention/legal hold, org-key evidence bundles, and the MDM kit. Collection never depends on
licence state, and the endpoint stays permissive on purpose — it has to land on a developer's
laptop before procurement has heard of us.

---

## The tiers

| Tier | Title | Features |
|---:|---|---:|
| 1 | [Ship it, stop lying, and cut the four seams everything else hangs on](enterprise/tier-1.md) | 24 |
| 2 | [Shadow AI census: every AI surface on this machine, provisioned or not](enterprise/tier-2.md) | 52 |
| 3 | [Per-employee attribution, and the privacy floor that must ship in the same release](enterprise/tier-3.md) | 42 |
| 4 | [Data exposure: what sensitive data reached a model, and what is sitting on disk right now](enterprise/tier-4.md) | 25 |
| 5 | [Deep agent monitoring: the tool-call ledger, authority, autonomy and blast radius](enterprise/tier-5.md) | 52 |
| 6 | [Posture, supply chain and the pack plane: what granted the authority in the first place](enterprise/tier-6.md) | 80 |
| 7 | [Getting evidence off the laptop honestly: triage, export, and the SIEM contract](enterprise/tier-7.md) | 49 |
| 8 | [Fleet, reconciliation and compliance at scale: what an enterprise signs for](enterprise/tier-8.md) | 44 |

### Tier 1 — [Ship it, stop lying, and cut the four seams everything else hangs on](enterprise/tier-1.md)

Nothing in this roadmap is demonstrable while the packaged app fatalErrors on launch, the Codex
collector overwrites its own rows, detection burns fifteen seconds per poll at fleet scale, and
SECURITY.md's no-network claim is false. This tier is short by design — weeks, not a quarter — and
contains only two kinds of work.

- **Anomaly upsert with a separate escalation channel** — `Behaviour` · `CISO` · **M** · exact ·
  5/5
- **Union tool names across content-block copies and widen the upsert** — `Tool ledger` · `Eng
  mgr` · **S** · exact · 4/5
- **verify: report pruned sources, reconcile Grok, and FAIL on an empty store** — `Governance` ·
  `Procurement` · **M** · exact · 5/5
- **Incident figures reach every reader: observed, baseline, threshold** — `Desktop` · `CISO` ·
  **S** · exact · 5/5
- **Ship-blocker gate: a bundled .app that actually launches** — `Platform` · `Platform` · **S** ·
  exact · 5/5
- **Content boundary as a branded type, with verify --content as its runtime twin** — `Governance`
  · `DPO` · **M** · exact · 4/5
- **Detection budget: O(W) baselines and skip-empty polls** — `Behaviour` · `Platform` · **S** ·
  exact · 3/5
- **Read-model contract and capability-probed navigation shell** — `Desktop` · `Platform` · **L**
  · exact · 2/5
- **Two-writer safety and a read-only DB open path** — `Platform` · `Platform` · **S** · exact ·
  4/5
- **Codex collector v2 as a Tier 1 correctness fix: thread state, spawn edges and rollout byte
  offsets** — `Platform` · `Platform` · **M** · exact · 4/5
- **Annotated timeline: incident marks drawn, UTC buckets rendered in local time, sparkline zero-
  filled** — `Desktop` · `CISO` · **S** · exact · 4/5
- **Aggregate confidence label: replace MIN(confidence)** — `Desktop` · `DPO` · **S** · exact ·
  3/5
- **Collector process supervision: the orphan, the exit status, and launchd throttling** —
  `Platform` · `Platform` · **M** · exact · unscored
- **Ledger scan cursors and insert-gated, bounded-window detection** — `Platform` · `Platform` ·
  **M** · exact · 3/5
- **Open the rule and tool enums the app renders** — `Desktop` · `Developer` · **S** · partial ·
  3/5
- **Honest coverage: per-collector heartbeat, four source states and a coverage strip** —
  `Desktop` · `Platform` · **M** · new instr. · 5/5
- **Scanner cadence and scan_state, so discovery never joins the 5-second loop** — `Platform` ·
  `Platform` · **S** · exact · 3/5
- **schema_migrations: a numbered, ledgered, single-writer migration path** — `Platform` ·
  `Platform` · **M** · exact · unscored
- **The upgrade boundary on the Coverage strip: 'not recorded before v0.2', never zero** —
  `Desktop` · `Eng mgr` · **S** · exact · unscored
- **Readability matrix: no screen may render a bare zero** — `Desktop` · `CISO` · **M** · exact ·
  unscored
- **collector_runs: a measured footprint budget that names its metric** — `Platform` · `Platform`
  · **M** · exact · unscored
- **store_version_gate: an older binary opens a newer store read-only and says so** — `Platform` ·
  `Platform` · **S** · exact · unscored
- **Backfill as a declared step: the widening the tokens-only-grow upsert can never perform** —
  `Platform` · `Platform` · **M** · partial · unscored
- **Read-model parity check in CI** — `Platform` · `Eng mgr` · **S** · exact · 2/5

### Tier 2 — [Shadow AI census: every AI surface on this machine, provisioned or not](enterprise/tier-2.md)

This is the reason the product exists and it comes second only because it needs a launchable
binary and a scanner lane, not because it needs any of the existing pipeline. Surface discovery is
structurally independent of usage_events, of identity and of the tool ledger: it is a bounded
filesystem, launchd, bundle and config scan into `ai_surfaces`, and it produces the single demo
that closes a first meeting — open Vole on a real developer's laptop and see the AI surfaces
nobody provisioned.

- **ai_surfaces registry (the shadow-AI spine)** — `Shadow AI` · `CISO` · **L** · exact · 5/5
- **Unsanctioned-agent rule against an admin allowlist** — `Governance` · `CISO` · **M** · exact ·
  5/5
- **Shadow AI screen** — `Desktop` · `CISO` · **L** · new instr. · 5/5
- **model_routes: resolving the local gateway's alias map, and the two rules it exposes** — `Data
  exposure` · `CISO` · **M** · exact · unscored
- **languageModelStats: exact tokens per extension per model, counted by the editor itself** —
  `FinOps` · `FinOps` · **M** · exact · unscored
- **Per-workspace activation: which repositories each IDE agent actually opened in** — `Behaviour`
  · `CISO` · **M** · exact · unscored
- **agent_home_roots: editor roots and profiles as a resolved dimension, by marker not by name
  list** — `Platform` · `CISO` · **M** · exact · unscored
- **os_intelligence: the AI wired into macOS, and the MDM key that was supposed to stop it** —
  `Posture` · `Platform` · **S** · exact · unscored
- **AI gateway persistence inventory (LaunchAgents and LaunchDaemons)** — `Shadow AI` · `CISO` ·
  **S** · exact · 5/5
- **vole assess --wedge: competitor-coverage annex computed on the buyer's own machine** —
  `Governance` · `CISO` · **M** · new instr. · 3/5
- **Full Disk Access canary and the launch-context record** — `Platform` · `CISO` · **S** · exact
  · unscored
- **Evidence-ladder card: a surface with no telemetry that can never be misread as spend** —
  `Desktop` · `CISO` · **S** · exact · unscored
- **site_capabilities: what a chat site was allowed to touch on this machine** — `Data exposure` ·
  `CISO` · **M** · exact · unscored
- **Rerouted-model detector straight from the model column, with CCR hex decode** — `Shadow AI` ·
  `CISO` · **S** · exact · 5/5
- **Overview: security-first tile grid with no risk score** — `Desktop` · `CISO` · **M** · partial
  · 4/5
- **scan_access: the attempted read is the only honest observable** — `Platform` · `Platform` ·
  **M** · exact · unscored
- **Installed AI app census by bundle id and signing Team ID** — `Shadow AI` · `CISO` · **M** ·
  exact · 5/5
- **Menu bar as the security surface: six honest states and two security counts** — `Desktop` ·
  `CISO` · **L** · new instr. · 4/5
- **pnpm verify --surfaces: the firewall between inventory and usage** — `Platform` · `Platform` ·
  **S** · exact · unscored
- **AI CLI and package-manager inventory (PATH, npm global, pipx, Caskroom)** — `Shadow AI` ·
  `CISO` · **S** · exact · 4/5
- **Notification coalescing, auditable per-rule mute and quiet hours** — `Desktop` · `Developer` ·
  **M** · partial · 3/5
- **coverage_degraded: a root that was readable and stopped being** — `Platform` · `CISO` · **S**
  · exact · unscored
- **Ghost-app detector: AI tools that ran here and were then deleted** — `Shadow AI` · `CISO` ·
  **S** · exact · 4/5
- **Deleted agent sessions, proved by the stores that outlived them** — `Platform` · `CISO` ·
  **S** · exact · unscored
- **Model-route rewrite evidence: rejected key labels, config backups, env names** — `Shadow AI` ·
  `CISO` · **S** · exact · 4/5
- **Permission preflight in the app, and proof the grant reached the collector** — `Platform` ·
  `Developer` · **M** · partial · unscored
- **Copilot CLI collector: exact tokens from session.shutdown modelMetrics** — `Platform` · `Eng
  mgr` · **M** · new instr. · 5/5
- **foreign_root_transcript: a cwd this filesystem cannot have** — `Shadow AI` · `CISO` · **S** ·
  exact · unscored
- **Gemini CLI collector with prompts-logged-to-disk posture** — `Platform` · `CISO` · **M** · new
  instr. · 4/5
- **Agent-home redirect, re-detected every pass (CLAUDE_CONFIG_DIR, CODEX_HOME)** — `Shadow AI` ·
  `CISO` · **M** · exact · unscored
- **Multi-root agent-home census (paths.ts resolves exactly one home)** — `Shadow AI` · `Platform`
  · **M** · partial · 4/5
- **BYOK agent collectors: Goose, Amp and Continue** — `Platform` · `Platform` · **L** · new
  instr. · 3/5
- **Second-tier store prober: one module, ten tools** — `Shadow AI` · `CISO` · **M** · exact · 4/5
- **Local model runtime census and the exposed-bind rule** — `Shadow AI` · `CISO` · **M** ·
  partial · 4/5
- **Ollama activity rows from the runtime's own server log** — `Shadow AI` · `CISO` · **M** ·
  partial · 3/5
- **execution_contexts: where the work actually ran, and the count Vole could not read** — `Shadow
  AI` · `CISO` · **M** · exact · unscored
- **ai_extensions census: three readers, because extensions.json is the smallest one** — `Shadow
  AI` · `CISO` · **L** · exact · unscored
- **Ghost AI extensions: assistants that are gone from disk but not from the editor's memory** —
  `Shadow AI` · `CISO` · **M** · exact · unscored
- **Contribution-point classifier: what makes an extension an AI surface, with no name list** —
  `Shadow AI` · `CISO` · **M** · partial · unscored
- **Model routes chosen inside the sanctioned editor** — `Shadow AI` · `CISO` · **M** · exact ·
  unscored
- **browser_extensions: the reach ledger read from Secure Preferences, not the Extensions folder**
  — `Shadow AI` · `CISO` · **M** · exact · unscored
- **browser_assistant: the browser vendor's own AI, with a real last-invoked date** — `Shadow AI`
  · `CISO` · **S** · exact · unscored
- **Browser AI-host visit census (hostname counts only, no extension, no proxy)** — `Shadow AI` ·
  `CISO` · **M** · partial · 4/5
- **Repo-only agents: Aider's footprint and Continue's repo-side dev_data** — `Shadow AI` · `CISO`
  · **M** · exact · unscored
- **VS Code chat request rows: fixing the 'Copilot collector' into an editor chat-store
  collector** — `Shadow AI` · `Eng mgr` · **L** · exact · unscored
- **Cline / Roo / Kilo task collector: one exact row per task from the vendor's own running
  totals** — `Shadow AI` · `CISO` · **M** · partial · unscored
- **ai_dependencies: the installed SDK tree, not the declared manifest** — `Shadow AI` · `CISO` ·
  **M** · exact · unscored
- **launchd-declared log tail: surface_activity for daemons that were never instrumented** —
  `Shadow AI` · `Platform` · **M** · exact · unscored
- **First-seen AI surface rule (new_ai_surface)** — `Shadow AI` · `CISO` · **M** · exact · 4/5
- **Sanctioned-vs-detected policy join and unsanctioned_surface_first_seen** — `Shadow AI` ·
  `CISO` · **M** · partial · 4/5
- **Provider key-name census and the provider_key_without_sanctioned_surface rule** — `Shadow AI`
  · `CISO` · **M** · exact · unscored
- **Console and gateway coverage ledger — what nobody else can see** — `Shadow AI` · `CISO` ·
  **M** · partial · 4/5

### Tier 3 — [Per-employee attribution, and the privacy floor that must ship in the same release](enterprise/tier-3.md)

Turning a per-device inventory into a per-employee one is the moment Vole becomes an enterprise
product and simultaneously the moment it becomes an employee-monitoring system under GDPR Art. 88,
BetrVG § 87(1) Nr. 6 and potentially AI Act Annex III 4(b).

- **console_invisible auth-path tag (Bedrock, Vertex, base-URL, router)** — `Shadow AI` · `FinOps`
  · **M** · exact · 4/5
- **Stable machine identity (IOPlatformUUID) and a hostname history** — `Identity` · `Platform` ·
  **S** · exact · 4/5
- **Seat inventory and seat-value reconciliation from vendor-observed plan fields** — `FinOps` ·
  `FinOps` · **M** · partial · 3/5
- **Email and name never stored: domain plus HMAC, enforced by verify --identity** — `Governance`
  · `DPO` · **M** · exact · 5/5
- **Privacy Center with live export-payload inspector** — `Desktop` · `Procurement` · **M** ·
  partial · 4/5
- **Deployment mode resolver: personal vs managed** — `Platform` · `Procurement` · **S** · partial
  · 4/5
- **Principal resolution chain and the v_events_principal read-time join** — `Identity` ·
  `Platform` · **M** · partial · 5/5
- **Egress inventory, network_calls ledger and a VOLE_NO_EGRESS switch every caller honours** —
  `Governance` · `DPO` · **M** · exact · 5/5
- **Your-own-rows inspector** — `Desktop` · `Developer` · **M** · exact · 3/5
- **Release gate: privacy machinery ships with the MDM kit, not after fleet sync** — `Platform` ·
  `Platform` · **S** · exact · 3/5
- **Pseudonymise at insert, not at sync** — `Identity` · `DPO` · **L** · exact · 4/5
- **Shipped read manifest and per-scanner switches** — `Governance` · `DPO` · **M** · exact · 4/5
- **People view** — `Desktop` · `Eng mgr` · **M** · partial · 3/5
- **PPPC payload generated from Vole's own signature, and the ad-hoc cdhash trap** — `Platform` ·
  `Platform` · **M** · exact · unscored
- **Scoped, logged local MCP server** — `Governance` · `DPO` · **M** · exact · 5/5
- **execution_context_id on every row, and the origin quarantine for rows this machine did not
  produce** — `Identity` · `DPO` · **M** · exact · unscored
- **session_identity ledger with a binding_evidence rank** — `Identity` · `CISO` · **L** · partial
  · 5/5
- **First-run scope gate: real consent in personal mode, declared lawful basis in managed mode** —
  `Governance` · `DPO` · **L** · partial · 5/5
- **Account-class classifier from the auth path** — `Identity` · `CISO` · **M** · partial · 5/5
- **Per-person view governance: default gate, access log, subject notices, no productivity axis**
  — `Governance` · `DPO` · **L** · partial · 5/5
- **Codex per-session plan from the rollout, not from auth.json** — `Identity` · `CISO` · **S** ·
  exact · 4/5
- **Privacy Center: path receipts, field dictionary, egress and self-DSAR** — `Governance` ·
  `Developer` · **L** · partial · 5/5
- **Credential-shape probe that never reads a credential** — `Identity` · `DPO` · **M** · exact ·
  4/5
- **NON-GOALS charter with the canary proof behind it** — `Governance` · `DPO` · **M** · exact ·
  4/5
- **Cloud-provider class from model-id shape and the settings env snapshot** — `Identity` ·
  `FinOps` · **S** · partial · 3/5
- **Scope-change ledger with an employee-visible field-level diff** — `Governance` · `DPO` · **S**
  · exact · 4/5
- **~/.vole/policy/identity.json — the corporate declaration with a propose step** — `Identity` ·
  `Procurement` · **S** · exact · 4/5
- **Inalienable exclusion floor for personal work on a corporate device** — `Governance` ·
  `Developer` · **L** · partial · 4/5
- **Identity in the detection partition and the anomaly key** — `Identity` · `CISO` · **S** ·
  exact · 4/5
- **AI-dictionary-gated shell-history scanner with its own consent tier and a byte receipt** —
  `Governance` · `DPO` · **M** · partial · unscored
- **Principal and account-class dimensions in every read model** — `Identity` · `CISO` · **M** ·
  partial · 5/5
- **Design-partner pilot mode with a hard expiry** — `Governance` · `DPO` · **M** · partial · 2/5
- **People view (v_people) with attribution coverage on every figure** — `Identity` · `CISO` ·
  **L** · exact · 5/5
- **Device tenancy band and the pre-tenancy quarantine** — `Identity` · `DPO` · **M** · exact ·
  unscored
- **shadow_account_on_corporate_repo, with 'corporate' defined in policy** — `Identity` · `CISO` ·
  **M** · partial · 4/5
- **account_switched incident** — `Identity` · `CISO` · **S** · partial · 3/5
- **principal_conflict guard (shared laptops, CI runners, sudo)** — `Identity` · `Platform` ·
  **S** · exact · 3/5
- **Account class on shadow surfaces that have no collector** — `Identity` · `DPO` · **M** ·
  partial · 3/5
- **surface_principal: attributing a surface that has no session, and saying how weakly** —
  `Identity` · `DPO` · **S** · partial · unscored
- **browser_identity: the account the browser is signed into, and whether AI threads sync out of
  it** — `Identity` · `DPO` · **M** · exact · unscored
- **What per-employee attribution cannot establish, regenerated from the store** — `Identity` ·
  `Procurement` · **M** · exact · 4/5
- **vole whoami and the vole_identity MCP tool** — `Identity` · `Platform` · **S** · exact · 2/5

### Tier 4 — [Data exposure: what sensitive data reached a model, and what is sitting on disk right now](enterprise/tier-4.md)

The third leg of the stated vision, and the first tier that consumes the `onEntry` hook cut in
Tier 1. It answers the question a CISO actually asks — is my source code, are my customer records,
are my live credentials going into a model — with an answer that is defensible precisely because
Vole stores none of them.

- **dlp_detectors: versioned detector pack with offline checksum validators** — `Data exposure` ·
  `CISO` · **M** · exact · 4/5
- **Leak Ledger screen** — `Desktop` · `CISO` · **L** · new instr. · 5/5
- **key_residency: naming where else this key lives, so a spend gap stops being a mystery** —
  `FinOps` · `FinOps` · **S** · exact · unscored
- **Exclusion enforced at open(), with a counted skip receipt** — `Governance` · `DPO` · **M** ·
  exact · unscored
- **answerable_from: the horizon that makes "not seen" an answer instead of a shrug** — `Platform`
  · `CISO` · **M** · exact · unscored
- **Out-of-path scan engine: dlp_scan_state cursors, keyword prefilter and byte budget** — `Data
  exposure` · `Platform` · **L** · exact · 5/5
- **Coverage and denominators: what Vole did not read** — `Governance` · `CISO` · **L** · partial
  · 5/5
- **'Where it landed' chain panel: six hops, each badged with its evidence rank** — `Desktop` ·
  `DPO` · **M** · partial · unscored
- **secret_sightings ledger with a widening upsert, and the Data Exposure screen** — `Data
  exposure` · `CISO` · **XL** · exact · 5/5
- **Keychain-held fingerprint key with epoch rotation** — `Data exposure` · `DPO` · **M** ·
  partial · 3/5
- **Pre-match normalisation layer with a provenance badge** — `Data exposure` · `CISO` · **S** ·
  exact · 4/5
- **Direction tagging normalised across all six content-bearing collectors** — `Data exposure` ·
  `CISO` · **M** · exact · 5/5
- **Claude's own at-rest sinks: spill files, file-history, shell snapshots and config backups** —
  `Data exposure` · `CISO` · **M** · exact · 5/5
- **Codex thread_history content sink with an ordinal watermark** — `Data exposure` · `CISO` ·
  **S** · exact · 3/5
- **Cross-sink fingerprint correlation and first-origin** — `Data exposure` · `CISO` · **S** ·
  exact · 4/5
- **Evidence-expiry countdown and oldest-first backfill order** — `Data exposure` · `CISO` · **S**
  · exact · 3/5
- **Copilot's own session store: a free file-to-tool ledger, and 227 prompts sitting on disk** —
  `Data exposure` · `DPO` · **L** · exact · unscored
- **context_imports: one vendor's entire session handed to another, proved by a receipt that
  outlived the file** — `Data exposure` · `CISO` · **S** · exact · unscored
- **payload_sightings: the opaque-payload ledger, with on-disk and at-wire bytes kept apart** —
  `Data exposure` · `CISO` · **L** · exact · unscored
- **The unreadable denominator: no exposure figure renders without the bytes Vole could not read**
  — `Data exposure` · `DPO` · **M** · exact · unscored
- **Finding lifecycle: fixture auto-classification, rotation, and at-rest vs live reappearance** —
  `Data exposure` · `Developer` · **M** · partial · 4/5
- **Cursor, Antigravity and Devin content sinks** — `Data exposure` · `CISO` · **M** · partial ·
  4/5
- **Non-Claude prompt-sink and credential-store registry** — `Data exposure` · `CISO` · **L** ·
  partial · 4/5
- **Permission-allowlist inline-command secret scan with git-tracked escalation** — `Data
  exposure` · `CISO` · **S** · partial · 3/5
- **Just-in-time evidence viewer** — `Data exposure` · `CISO` · **M** · new instr. · 4/5

### Tier 5 — [Deep agent monitoring: the tool-call ledger, authority, autonomy and blast radius](enterprise/tier-5.md)

'Are agents using tools and reading data from the user's system without permission' is a question
that cannot be answered from `usage_events.tools`, a comma-joined string that is NULL on half the
turns.

- **dlp_egress: which class of data reached which provider endpoint** — `Data exposure` · `CISO` ·
  **M** · partial · 5/5
- **autonomy_intervals: posture as a timeline, not a session column** — `Authority` · `CISO` ·
  **L** · exact · 5/5
- **billable_burn_spike replaces burn_rate_spike (cost-scored, session-attributed)** — `Behaviour`
  · `FinOps` · **M** · exact · 5/5
- **Session behaviour surface: live board and ledger-native drill-down card** — `Desktop` ·
  `Platform` · **XL** · exact · 4/5
- **tool_calls ledger with source-native keys and a two-phase, NULL-only-widening bind** — `Tool
  ledger` · `CISO` · **XL** · exact · 5/5
- **Session-tree cost roll-up, and the two event_key bugs that make it wrong today** — `FinOps` ·
  `Eng mgr` · **XL** · partial · 4/5
- **repo_state_uploads: the whole-repo tarball, and the vendor server that decided to send it** —
  `Posture` · `Platform` · **S** · exact · unscored
- **authorization_basis per tool call, ungated-call KPI and default_policy_delta** — `Authority` ·
  `CISO` · **L** · partial · 5/5
- **anomaly_context: blast radius attached to every behaviour incident** — `Behaviour` · `CISO` ·
  **M** · exact · 5/5
- **Four-state authority on every tool call (denied / pre-authorised / posture-waived / no
  record)** — `Tool ledger` · `CISO` · **M** · exact · 5/5
- **Behaviour panel with incident-to-ledger jump** — `Desktop` · `CISO` · **L** · new instr. · 4/5
- **agent_pushed_data_off_device: scp, rsync and cp into an unmonitored context** — `Data
  exposure` · `CISO` · **M** · exact · unscored
- **agent_self_authorised: the agent changed its own permission surface** — `Authority` · `CISO` ·
  **L** · exact · 5/5
- **agent_edges: the subagent tree from what the metadata actually carries** — `Behaviour` ·
  `CISO` · **M** · exact · 4/5
- **Command-shape skeleton and versioned pattern pack (pattern_id + pack_version, not just a
  hash)** — `Tool ledger` · `CISO` · **M** · exact · 5/5
- **Secret-store retrieval ledger: the credential the agent pulled from a remote vault** — `Data
  exposure` · `CISO` · **M** · exact · unscored
- **Blast Radius screen: every system outside this laptop that agents touched** — `Desktop` ·
  `CISO` · **M** · exact · unscored
- **unattended_full_access and the 'no human was present' evidence chain** — `Authority` · `CISO`
  · **M** · exact · 4/5
- **repeat_call_loop replaces loop_suspected (ledger-native, absolute-rate path, agent-scoped)** —
  `Behaviour` · `Eng mgr` · **M** · exact · 4/5
- **Signal provenance on every ledger row: status_source, duration_kind and the per-tool coverage
  matrix** — `Tool ledger` · `DPO` · **M** · exact · 4/5
- **payload_origin: a screenshot of somebody's screen versus a PNG that was already in git** —
  `Data exposure` · `CISO` · **M** · exact · unscored
- **What the agent left behind: the envelope receipt and its review packet** — `Desktop` · `Eng
  mgr` · **M** · exact · unscored
- **MCP server dimension on the ledger and tool_first_seen** — `Tool ledger` · `CISO` · **M** ·
  exact · 4/5
- **headless_bypass_launch rule (the Nx s1ngularity shape)** — `Authority` · `CISO` · **S** ·
  exact · 4/5
- **scope_drift: sessions that move to a second repository** — `Behaviour` · `CISO` · **M** ·
  exact · 4/5
- **Acting-now panel and live-autonomy tint** — `Desktop` · `Developer` · **M** · new instr. · 3/5
- **denied_then_achieved and denial_then_reshape: the guardrail-bypass matcher** — `Authority` ·
  `CISO` · **M** · exact · 4/5
- **Human-interrupt ledger from the interruption marker** — `Behaviour` · `Eng mgr` · **S** ·
  exact · 3/5
- **Bash redirect, heredoc and copy write-targets in the file ledger** — `Tool ledger` · `CISO` ·
  **M** · exact · 4/5
- **Destructive-command classifier with cwd-relative blast radius** — `Authority` · `Platform` ·
  **M** · exact · 4/5
- **pnpm verify --behaviour: ledger reconciliation and collector shape-drift counter** — `Tool
  ledger` · `Procurement` · **L** · exact · 4/5
- **fetch_ingress: untrusted web bytes entering a session, with a size and a status code** —
  `Behaviour` · `CISO` · **S** · exact · unscored
- **sensitive_read_unasked: sensitive-path access joined to authority and posture** — `Authority`
  · `CISO` · **M** · partial · 4/5
- **tool_failure_storm, and error_storm narrowed to API errors** — `Behaviour` · `Platform` ·
  **M** · exact · 3/5
- **Read completeness on the tool ledger, and the paged_bulk_read rule the per-call view can never
  see** — `Tool ledger` · `CISO` · **M** · exact · unscored
- **posture_escalated and policy_downgraded within a session** — `Authority` · `CISO` · **M** ·
  partial · 4/5
- **stuck_tool_call and the per-session concurrency ceiling** — `Behaviour` · `Platform` · **S** ·
  exact · 3/5
- **action_targets: the target-system resolver with an explicit resolution chain** — `Tool ledger`
  · `CISO` · **M** · exact · unscored
- **Autonomy clock: unattended_run rule and the daily exposure rollup** — `Behaviour` · `CISO` ·
  **XL** · partial · 5/5
- **Remote-database action ledger and the remote_database_write / destructive_schema_change
  rules** — `Authority` · `CISO` · **M** · exact · unscored
- **context_edges: every command that left this machine, by transport and destination** — `Tool
  ledger` · `CISO` · **M** · exact · unscored
- **subagent_inherited_bypass: autonomy propagation down the agent tree** — `Behaviour` · `CISO` ·
  **XL** · partial · 5/5
- **Remote-execution hop ledger (ssh, docker, kubectl exec) and remote_privileged_exec** —
  `Authority` · `Platform` · **M** · exact · unscored
- **Asset resolution chain: stamped at insert, widened only into NULLs** — `Tool ledger` ·
  `Platform` · **L** · exact · unscored
- **install_after_ingress: bounding the ingress-then-action rule so it can actually fire** —
  `Behaviour` · `CISO` · **S** · partial · unscored
- **VCS action ledger from the agent's own gitOperation record** — `Authority` · `Eng mgr` · **M**
  · exact · unscored
- **Kiro ACP ledger: tool calls carrying the vendor's own policy verdict and the human's answer**
  — `Tool ledger` · `CISO` · **M** · exact · unscored
- **Posture-weighted severity across every rule** — `Behaviour` · `CISO` · **L** · partial · 4/5
- **agent_wrote_persistence and the PATH-precedence fact** — `Authority` · `CISO` · **M** · exact
  · unscored
- **Grant deposits: the credential the agent handed to something else** — `Authority` · `CISO` ·
  **M** · partial · unscored
- **sandbox_claim_violated and network_claim_violated (Codex declared vs observed)** — `Authority`
  · `CISO` · **L** · partial · 3/5
- **cross_scope_read_then_publish rule** — `Authority` · `CISO` · **M** · partial · 3/5

### Tier 6 — [Posture, supply chain and the pack plane: what granted the authority in the first place](enterprise/tier-6.md)

Every incident in Tier 5 has an upstream cause sitting in a config file: an MCP server registered
at a new endpoint, a hook whose command changed, a plugin from an unverified marketplace, a
wildcard allowlist entry that authorised a shell class forever, a workspace-trust transition, an
instruction file with hidden Unicode, an `ANTHROPIC_BASE_URL` planted by a dependency.

- **Shadow MCP: servers called but present in no local config** — `Shadow AI` · `CISO` · **M** ·
  exact · 4/5
- **Offered-tool-surface ledger (what the model was actually handed)** — `Tool ledger` ·
  `Platform` · **M** · exact · 4/5
- **MCP registration sweep keyed on endpoint identity, not server name** — `Posture` · `CISO` ·
  **M** · exact · 5/5
- **Vendor lever cards: each tool's own permission config, observed value beside the hardened
  one** — `Control` · `CISO` · **M** · exact · 4/5
- **content_packs registry: verified offline load with an unremovable builtin floor** — `Platform`
  · `Platform` · **M** · new instr. · unscored
- **Suppression register: turn a detector off centrally, keep counting what it hid** —
  `Governance` · `DPO` · **M** · exact · unscored
- **Pricing as a pack kind, and the user override that must lose in managed mode** — `FinOps` ·
  `FinOps` · **M** · exact · unscored
- **Repos band on Posture: four readability states and a printed denominator** — `Desktop` ·
  `CISO` · **M** · exact · unscored
- **Crown-jewel-scoped rule variants: same detection, escalated only on a tiered target** — `Data
  exposure` · `CISO` · **M** · exact · unscored
- **Grant widening by one click: the always-accept that wrote a wildcard shell rule** —
  `Authority` · `CISO` · **S** · exact · unscored
- **security_envelope_changed: posture- and authority-weighted, not count-weighted** — `Behaviour`
  · `CISO` · **M** · exact · unscored
- **Cross-agent credential and base-URL injection** — `Posture` · `CISO` · **S** · exact · 5/5
- **Plugin always-on context tax, priced per model per session** — `FinOps` · `FinOps` · **S** ·
  partial · 2/5
- **Rule provenance and control-framework mapping on every incident** — `Governance` ·
  `Procurement` · **S** · exact · 4/5
- **repo_carried_grant: the permission allowlist that travels with the clone** — `Authority` ·
  `CISO` · **S** · exact · unscored
- **Data-class entries: what 'customer data' means here, as validators and salted hashes** — `Data
  exposure` · `DPO` · **M** · exact · unscored
- **Register coverage on every asset-scoped figure, and the unresolved worklist** — `Desktop` ·
  `CISO` · **S** · exact · unscored
- **vole packs --preflight assets.json: score a candidate register before the fleet gets it** —
  `Platform` · `Platform` · **M** · exact · unscored
- **change_risk_class: the envelope classifier on the file-write ledger** — `Tool ledger` · `CISO`
  · **M** · exact · unscored
- **envelope_change_escaped: did the widening leave the laptop** — `Behaviour` · `Eng mgr` · **S**
  · exact · unscored
- **Hook execution ledger with first-seen command hashes** — `Posture` · `CISO` · **M** · exact ·
  5/5
- **Pack-bump re-scan of retained evidence, oldest-first and bounded, with the unscannable backlog
  counted** — `Data exposure` · `CISO` · **M** · exact · unscored
- **assets.json: the admin-authored register, and the two entry kinds it refuses to load** —
  `Governance` · `CISO` · **M** · exact · unscored
- **Criticality as the second severity input — and why asset_tier must stay out of anomaly_key** —
  `Authority` · `CISO` · **M** · exact · unscored
- **Blast Radius sorted by asset tier, with a counted untiered bucket** — `Desktop` · `CISO` ·
  **M** · exact · unscored
- **write_then_hide: the change the agent made unreviewable** — `Behaviour` · `CISO` · **S** ·
  exact · unscored
- **Window hunt: what entered this machine's agent surface between two timestamps** — `Tool
  ledger` · `Platform` · **S** · exact · unscored
- **Managed-policy coverage and precedence chain per agent** — `Posture` · `Platform` · **M** ·
  partial · 5/5
- **content_rev on incidents: re-score without duplicating, retire without lying** — `Behaviour` ·
  `CISO` · **M** · exact · unscored
- **recipient resolution: the model name is not the recipient** — `Governance` · `Platform` ·
  **M** · exact · unscored
- **Hunt-time fingerprinting: the pack carries the burned value, the store never does** — `Data
  exposure` · `CISO` · **M** · exact · unscored
- **Successor window: the "and what happened next" half of the question** — `Authority` · `CISO` ·
  **M** · exact · unscored
- **Xcode bundled Claude Code posture: skip-permissions by default** — `Behaviour` · `CISO` ·
  **M** · partial · 4/5
- **Native-telemetry and prompt-logging posture per agent** — `Posture` · `CISO` · **S** · partial
  · 5/5
- **os_grants: which AI app can read the screen and the keystrokes** — `Authority` · `CISO` ·
  **M** · partial · unscored
- **terms_basis: the contract tier that selects the terms, measured per surface** — `Governance` ·
  `DPO` · **M** · exact · unscored
- **Grant and override ledger: which file granted this authority, and what weakens the
  guardrails** — `Posture` · `CISO` · **L** · partial · 5/5
- **detection_epochs: rules have a birthday, and an empty history has to say which kind of empty
  it is** — `Governance` · `DPO` · **S** · exact · unscored
- **Workspace-trust transitions and untrusted-execution rule** — `Posture` · `CISO` · **M** ·
  exact · 4/5
- **Policy screen: effective rule thresholds with provenance, read-only by design** — `Governance`
  · `Platform` · **M** · partial · 3/5
- **MCP server-instruction rug-pull detector** — `Posture` · `CISO` · **M** · exact · 4/5
- **processing_terms pack with an as-of-the-evidence lookup, not an as-of-today one** —
  `Governance` · `DPO` · **L** · partial · unscored
- **Instruction-file hidden-Unicode scan and include graph** — `Posture` · `CISO` · **M** · exact
  · 4/5
- **declared_dpa_scope_mismatch: the agreement you rely on does not cover the account that ran** —
  `Governance` · `Procurement` · **M** · partial · unscored
- **Plugin declared-capability tier from the marketplace catalog** — `Posture` · `CISO` · **S** ·
  exact · 4/5
- **residency_evidence with a ranked chain, and an inference_geo that is honestly empty** —
  `Governance` · `DPO` · **M** · partial · unscored
- **Plugin and marketplace provenance with cross-agent blast radius** — `Posture` · `CISO` · **M**
  · partial · 4/5
- **Vendor retention clock: is the vendor's copy still inside its own stated window** —
  `Governance` · `DPO` · **S** · partial · unscored
- **Package execution ledger: installs, fetch-and-run, and registry provenance** — `Posture` ·
  `CISO` · **M** · exact · unscored
- **work_roots: the root registry, with git as an attribute and not the identity** — `Posture` ·
  `Platform` · **M** · exact · unscored
- **Bounded repo sweep: a declared manifest, a per-pass byte budget, and a receipt** — `Posture` ·
  `Platform` · **M** · exact · unscored
- **tracked_state from .git/index, not from git ls-files or .gitignore** — `Posture` · `CISO` ·
  **S** · exact · unscored
- **agent_config_with_dependency: the Keyv-worm shape, joined to the install ledger** — `Posture`
  · `CISO` · **M** · exact · unscored
- **Root tombstones: the clone that is gone and the hash that can never be re-verified** —
  `Posture` · `CISO` · **S** · exact · unscored
- **MCP registered-vs-observed call and spend join** — `Posture` · `CISO` · **S** · partial · 4/5
- **Agent and AI-app binary signing ledger (TeamID, CDHash, ad-hoc)** — `Posture` · `CISO` · **L**
  · partial · 4/5
- **Shipped offline advisory floor table (version-vs-CVE, no network)** — `Posture` · `Platform` ·
  **M** · exact · 3/5
- **Version residency: the exposure interval an advisory's affected range actually intersects** —
  `Posture` · `CISO` · **M** · exact · unscored
- **Agent reach: the key, the host policy and the forwarded agent that got it out** — `Posture` ·
  `Platform` · **S** · exact · unscored
- **Retroactive config history replayed from the agents' own rotating backups** — `Posture` ·
  `CISO` · **M** · exact · 3/5
- **Blanket-approval inventory: what each wildcard grant actually authorised** — `Posture` ·
  `CISO` · **L** · partial · 3/5
- **Dependency key-set delta from the pre- and post-image the transcript already holds** —
  `Posture` · `Platform` · **M** · partial · unscored
- **install_hook_added: the lifecycle script the agent planted** — `Posture` · `CISO` · **S** ·
  exact · unscored
- **Devcontainer and compose manifest reader: the agent the image installs, the home it mounts,
  the bypass it declares** — `Posture` · `Platform` · **M** · partial · unscored
- **IDE agent posture as a dated interval, from the editor's settings backups** — `Posture` ·
  `CISO` · **M** · exact · unscored
- **Retroactive extension-version history from the editor's own Settings Sync backups** —
  `Posture` · `CISO` · **M** · exact · unscored
- **extension_version_history: the permission that arrived in an auto-update** — `Posture` ·
  `Platform` · **M** · exact · unscored
- **extension_store_state: Chrome's own store verdict, read from disk with zero network** —
  `Posture` · `CISO` · **S** · exact · unscored
- **Fork drift: the same extension at two versions, and the fork the patch cycle forgot** —
  `Posture` · `CISO` · **S** · exact · unscored
- **Editor-synced agent plugins and skills: instruction packs that arrive over the wire with no
  install event** — `Posture` · `CISO` · **M** · exact · unscored
- **Admin control resolved vs behaviour observed: autonomousAgentsDisabled while Autopilot ran** —
  `Posture` · `CISO` · **M** · exact · unscored
- **Measured collection posture: the vendor turned uploads on remotely, and here are the
  receipts** — `Posture` · `CISO` · **M** · exact · unscored
- **Plugin install-vs-use reconciliation (ghost and orphan plugins)** — `Posture` · `Platform` ·
  **S** · exact · 2/5
- **Comparability gate: not_comparable is the verdict the third verdict was hiding** — `Posture` ·
  `CISO` · **M** · exact · unscored
- **Pre-Vole residue hunt: the filesystem remembers days the store never saw** — `Posture` ·
  `Platform` · **M** · partial · unscored
- **Posture screen with three-state controls and an evidence coverage ratio** — `Posture` ·
  `Platform` · **L** · partial · 5/5
- **Two trust classes: vendor-signed content vs admin-authored policy, and the customer trust
  anchor** — `Posture` · `CISO` · **M** · new instr. · unscored
- **content_stale, per kind, with a rule key that ages in steps instead of firing daily** —
  `Posture` · `CISO` · **S** · exact · unscored
- **vole packs --preflight: score a candidate pack against this machine's evidence before the
  fleet gets it** — `Posture` · `Platform` · **M** · exact · unscored
- **Approved-baseline snapshot and one-key drift diff** — `Posture` · `Platform` · **M** · new
  instr. · 4/5

### Tier 7 — [Getting evidence off the laptop honestly: triage, export, and the SIEM contract](enterprise/tier-7.md)

A security team does not adopt a tool that only speaks through one Mac app, and the market
research is unambiguous that buyers want SIEM-native events, not another console.

- **Deny-by-default export field registry with a NULL-omitting encoder** — `Export` ·
  `Procurement` · **M** · exact · 5/5
- **case_key: the case identity beneath the time bucket** — `Governance` · `CISO` · **M** · exact
  · unscored
- **Triage queue: the incidents screen the app has never had** — `Desktop` · `CISO` · **L** ·
  exact · unscored
- **Timed mute: mandatory expiry, hidden-count and renewal accounting** — `Control` · `Platform` ·
  **M** · exact · unscored
- **Triage writes take the collector path: the ~/.vole/inbox spool** — `Platform` · `Platform` ·
  **M** · new instr. · unscored
- **export_seq change cursor and replay that cannot rewind the live tail** — `Export` · `Platform`
  · **M** · exact · 5/5
- **control_intents ledger: notification actions that record a request, gated on an exact PID
  mapping** — `Control` · `Platform` · **L** · new instr. · 3/5
- **finding_actions: the append-only disposition ledger** — `Governance` · `DPO` · **M** · exact ·
  unscored
- **Bulk disposition over an explicit id set, stamped label_mode** — `Desktop` · `Platform` ·
  **S** · exact · unscored
- **vole support-bundle: a redacted diagnostic that passes verify --content before it is written**
  — `Platform` · `Platform` · **M** · exact · unscored
- **Device-scoped dedupe: (device_id, event_key) as the sync key** — `Export` · `CISO` · **M** ·
  partial · 5/5
- **Fleet and osquery table pack: be the source, not the console** — `Platform` · `Platform` ·
  **M** · partial · 3/5
- **Human-confirmed handoff of one incident to the enforcement tool, payload shown before it
  leaves** — `Control` · `CISO` · **M** · network · 3/5
- **store_epoch: proving the database is the one you were given** — `Governance` · `CISO` · **S**
  · exact · unscored
- **The answer sheet: the sentence the security team sends back, with its denominator attached** —
  `Desktop` · `CISO` · **M** · exact · unscored
- **Durable export outbox with backpressure and audited drops** — `Export` · `Platform` · **M** ·
  exact · 4/5
- **Evidence bundle export with a pre-export field preview and re-identification scan** —
  `Governance` · `Procurement` · **L** · exact · 5/5
- **Accessibility pass and an exact-numbers toggle** — `Desktop` · `Procurement` · **M** · exact ·
  3/5
- **Structured incident detail: template key plus parameters** — `Export` · `CISO` · **M** · exact
  · 4/5
- **Command palette, section shortcuts and a persistent filter bar** — `Desktop` · `CISO` · **M**
  · exact · 2/5
- **Label carry-over across a pack bump, and the re-review queue** — `Governance` · `CISO` · **M**
  · exact · unscored
- **Incidents as OTLP logs carrying the figures that fired** — `Export` · `CISO` · **M** · exact ·
  5/5
- **vole:// deep links and addressable notifications** — `Desktop` · `CISO` · **S** · exact · 2/5
- **The custody sentence: what an evidence bundle is allowed to claim** — `Governance` · `DPO` ·
  **S** · partial · unscored
- **OTLP wire contract: pinned semconv snapshot and deterministic ids** — `Export` · `Platform` ·
  **M** · exact · 4/5
- **gen_ai.provider.name normalisation with an explicit unknown bucket** — `Export` · `CISO` ·
  **S** · partial · 4/5
- **Span model: real execute_tool durations, honestly zero-length chat spans** — `Export` ·
  `Platform` · **L** · exact · 4/5
- **Sink capability matrix and truthful delivery semantics** — `Export` · `Platform` · **S** ·
  exact · 3/5
- **Heartbeat export and the log-source-stopped dead-man's switch** — `Export` · `CISO` · **S** ·
  exact · 4/5
- **Incident evidence bundle with byte-offset provenance and the figures that fired** — `Export` ·
  `CISO` · **L** · partial · 5/5
- **Source-prefix integrity: a chained digest beside every byte offset** — `Export` · `CISO` ·
  **M** · exact · unscored
- **Per-rule detection quality with a labelled-fraction floor** — `Export` · `Platform` · **S** ·
  exact · unscored
- **Noise budget per host per week, and the rules that blew it** — `Export` · `CISO` · **S** ·
  exact · unscored
- **MTTA and MTTR from Vole's own clocks, with unattended as a first-class state** — `Export` ·
  `CISO` · **S** · partial · unscored
- **Versioned export shapes for the secret and tool-call ledgers** — `Export` · `CISO` · **M** ·
  partial · 4/5
- **Asset labels in the export field registry: tier travels, names are opt-in, basis never** —
  `Export` · `CISO` · **S** · exact · unscored
- **Vendor-join key ledger (event_links) for pivoting into vendor records** — `Export` · `CISO` ·
  **M** · partial · 4/5
- **Clock sanity from boot-anchored uptime, with a clock_suspect tag that reorders nothing** —
  `Export` · `Platform` · **S** · exact · unscored
- **Two clocks on every row and measured observation lag per tool** — `Export` · `Platform` ·
  **M** · partial · 3/5
- **Witness-orphan sessions: the ones that left no row at all** — `Export` · `CISO` · **M** ·
  exact · unscored
- **evidence_gaps: unmonitored intervals proved by the agents' own clocks** — `Export` · `CISO` ·
  **M** · partial · unscored
- **Pack inventory on the wire: the only signal that a rollout missed a laptop** — `Export` ·
  `Platform` · **S** · exact · unscored
- **MCP inventory export in server.json shape** — `Export` · `CISO` · **S** · exact · 4/5
- **Fleet / osquery ATC table pack** — `Export` · `Platform` · **S** · partial · 4/5
- **Export sink volume and cardinality measured from real serialized bytes** — `Export` ·
  `Platform` · **M** · partial · 3/5
- **Detection content pack: Sigma, SPL and EQL generated from the rule registry** — `Export` ·
  `CISO` · **M** · partial · 3/5
- **RFC 5424 syslog and CEF sinks for the SIEMs that predate JSON** — `Export` · `CISO` · **S** ·
  network · 3/5
- **Microsoft Sentinel connector generated from the field registry** — `Export` · `CISO` · **L** ·
  network · 4/5
- **Loopback OTLP receiver with parser-fidelity reconciliation** — `Export` · `CISO` · **L** · new
  instr. · 5/5

### Tier 8 — [Fleet, reconciliation and compliance at scale: what an enterprise signs for](enterprise/tier-8.md)

Everything that crosses a device boundary is last, opt-in and normalised-rows-only, because the
local-first principle is the thing that got Vole through the questionnaire and the works council
in the first place. This tier is the enterprise deal: fleet sync of redacted rows with
SSO/SCIM/RBAC, k-anonymity with complementary suppression for aggregate mode, purpose-bound
queries with a closed purpose union, retention split by data class showing the AI Act six-month
floor against the minimisation ceiling, erasure that survives the next poll with an Art.

- **Console-blind spend and the shadow_account_spend rule** — `Shadow AI` · `FinOps` · **L** ·
  network · 5/5
- **cost_basis stamped at insert, with unpriced counters in every aggregate** — `FinOps` ·
  `FinOps` · **M** · exact · 5/5
- **DSAR export that answers Art. 15(1)(h): the logic, not just the rows** — `Governance` · `DPO`
  · **M** · exact · 5/5
- **Enterprise demo story: seed --story, an unmissable demo bar and a guided tour** — `Desktop` ·
  `Eng mgr` · **M** · exact · 3/5
- **Per-active-agent-host meter, computed and auditable offline** — `Platform` · `Procurement` ·
  **S** · exact · 3/5
- **principal_lifecycle: a declared state, never an inferred one** — `Identity` · `CISO` · **S** ·
  exact · unscored
- **Departure evidence pack: one principal, one window, a denominator on every figure** — `Export`
  · `CISO` · **L** · exact · unscored
- **Credential residency and liveness sweep: the rotation worklist at exit** — `Posture` · `CISO`
  · **M** · partial · unscored
- **Departure delta against the principal's own baseline, purpose-gated** — `Data exposure` ·
  `CISO` · **M** · exact · unscored
- **Costs screen and `vole showback` with the coverage fraction attached to every total** —
  `FinOps` · `FinOps` · **L** · exact · 4/5
- **Erasure that survives the next poll, plus an Art. 19 propagation report** — `Governance` ·
  `DPO` · **L** · partial · 5/5
- **Reconciliation screen with a state chip on every cell** — `Desktop` · `FinOps` · **L** ·
  network · 2/5
- **store_budget: measured bytes per table and index, and the indexes no read model plans
  through** — `Platform` · `Platform` · **M** · exact · unscored
- **Evidence freeze on notice: hash the sources before they age out** — `Export` · `CISO` · **M**
  · exact · unscored
- **activity_after_departure: the credential that outlived the person** — `Identity` · `CISO` ·
  **S** · exact · unscored
- **Scope-change diff for movers, with a residual-reach column** — `Posture` · `CISO` · **M** ·
  exact · unscored
- **vendor_identities: mapping a local session to a console row** — `Identity` · `DPO` · **M** ·
  partial · 3/5
- **Cache economics with the 5m-versus-1h split, and the burn-rate rule that ignores multipliers**
  — `FinOps` · `FinOps` · **M** · exact · 4/5
- **Retention split by data class, with the AI Act floor shown against the minimisation ceiling**
  — `Governance` · `DPO` · **S** · exact · 4/5
- **Measured reclaim: VACUUM INTO a scratch copy is the measurement, the in-place VACUUM is the
  decision** — `Platform` · `Platform` · **S** · exact · unscored
- **Art. 30 record and the Art. 15(1)(c) recipients answer, both with an unknown denominator** —
  `Export` · `DPO` · **M** · partial · unscored
- **Quota ledger: the real cachedUsageUtilization shape, a scoped rule key, and the percent-to-
  money bridge** — `FinOps` · `FinOps` · **M** · exact · 4/5
- **vole import --context and the devcontainer feature: rows from a container arrive as rows,
  never as estimates** — `Platform` · `Platform` · **L** · new instr. · unscored
- **Retention with a receipt, gated on what can still be rebuilt** — `Governance` · `DPO` · **M**
  · exact · unscored
- **Uncosted rows: local and free-tier providers render an em dash, never $0.00** — `FinOps` ·
  `FinOps` · **S** · exact · 3/5
- **Purpose-bound query layer with a closed purpose union** — `Governance` · `DPO` · **L** · exact
  · 3/5
- **billing_units: a declared bridge for credits, seats and premium requests, or an em dash** —
  `FinOps` · `FinOps` · **S** · exact · 3/5
- **AI literacy and tool-usage record per subject** — `Governance` · `Procurement` · **S** · exact
  · 3/5
- **Budget burn-down scoped by cost_basis, with a budget_indeterminate verdict** — `FinOps` ·
  `FinOps` · **M** · exact · 3/5
- **Device decommission: seal, attest, erase — and the hold that names its declarer** —
  `Governance` · `DPO` · **L** · exact · unscored
- **k-anonymity with complementary suppression for aggregate mode** — `Governance` · `DPO` · **M**
  · partial · 3/5
- **Vendor rate cards read from disk, in the vendor's own unit, with the real context ceiling** —
  `FinOps` · `FinOps` · **M** · exact · unscored
- **Server-tool billing line (web_search_requests, web_fetch_requests)** — `FinOps` · `FinOps` ·
  **S** · exact · 2/5
- **Checkpoint chain over exported rows, witnessed by the sink the buyer already configured** —
  `Governance` · `Procurement` · **M** · partial · unscored
- **Reconciliation coverage report: what share of spend is even checkable** — `FinOps` · `CISO` ·
  **M** · partial · 5/5
- **Works-council pack: DPIA pre-filled with measured facts, plus BV and CSE skeletons** —
  `Governance` · `DPO` · **M** · partial · 3/5
- **vendor_ledger: the vendor's own billing figures, read from disk with zero network** — `FinOps`
  · `FinOps` · **L** · partial · 4/5
- **Reconciliation delta view with a not_comparable state that refuses to invent a gap** —
  `FinOps` · `FinOps` · **M** · partial · 4/5
- **`pnpm verify --reconcile`: cost arithmetic checked against the vendor's own local figure** —
  `FinOps` · `FinOps` · **M** · partial · 2/5
- **`vole reconcile`: the single opt-in, egress-declared network command** — `FinOps` · `Platform`
  · **L** · network · 3/5
- **Anthropic Admin API adapter (usage_report/messages, usage_report/claude_code, cost_report)** —
  `FinOps` · `FinOps` · **L** · network · 3/5
- **OpenAI Admin API adapter, and the ChatGPT-seat hole it names instead of filling** — `FinOps` ·
  `FinOps` · **L** · network · 3/5
- **Cursor and Copilot adapters: reconciliation where the units can never match** — `FinOps` ·
  `FinOps` · **L** · partial · 4/5
- **reconcile_gap rule, and the three explainability columns nobody has ever selected** — `FinOps`
  · `CISO` · **L** · network · 4/5

---

## Do not build

- Anything in the request path: no proxy, no MCP gateway, no base-URL rewrite, no TLS
  interception, no NetworkExtension DNS attribution, no enterprise browser, no browser extension.
  It is the one architectural promise that differentiates Vole from all 27 competing vendors, and
  DoH already defeats DNS attribution anyway.
- No kernel or EndpointSecurity system extension. The ES entitlement is a multi-month Apple
  process, is unnecessary for reading files, and breaks on macOS point releases — this is exactly
  where CrowdStrike, Jamf and SentinelOne have distribution Vole cannot match. Coexist via export.
- No inline blocking or automated remediation. Vole detects and reports; the only actions are a
  human-confirmed handoff to the tool that already owns the lever, with the payload shown before
  it leaves. Autonomous kill/quarantine is the fastest route to being uninstalled by developers.
- No prompt, tool-argument, tool-output or file content stored anywhere — not encrypted, not
  'temporarily for evidence', not in a support bundle. The content boundary is the product's legal
  and commercial position; the moment there is one exception the questionnaire answer becomes 'it
  depends'.
- No prompt-injection or jailbreak classifier, no LLM-based scoring of incidents, no model in the
  detection path. It is Lakera/Check Point territory, it makes detections unexplainable against
  principle 3, and it plausibly makes Vole itself an AI system under AI Act Annex III.
- No composite risk score, no per-person productivity or acceptance-rate axis, no leaderboards. A
  single unexplainable number destroys the works-council position and contradicts the
  explainability principle; a productivity ranking makes the product unlawful to deploy in several
  target markets.
- No third confidence value. 'estimated' does not exist in the type system and must not be added —
  activity-only tools render an em dash, never a modelled token count, and free or local providers
  render an em dash, never $0.00.
- No MCP config scanner as a headline feature and no CVE database of our own. Snyk agent-scan and
  Cisco ship free MCP scanners; ship an offline advisory floor table joined to observed versions
  instead of competing.
- No live credential verification by default (TruffleHog-style network checks against the
  provider). It is egress, it can lock accounts, and it turns a local tool into an outbound
  scanner. Keep it opt-in and explicitly declared, if at all.
- No scraping of vendor consoles, no headless-browser billing extraction, no undocumented API use.
  Reconciliation happens against documented admin APIs under an explicit opt-in command, or it
  does not happen.
- No cloud console as an early deliverable, and no SaaS ingest before the endpoint is right. The
  free local app on a developer's laptop is the distribution strategy; a server built first
  inverts it and forfeits the open-source questionnaire advantage.
- No Windows or Linux port before macOS is signed, notarised, MDM-deployable and running at a
  design partner. 63% of engineers run these agents on macOS; a half-working three-platform
  product beats nobody.
- No new bespoke telemetry schema competing with OTel gen_ai.*, and no claim that the semconv is
  stable. Pin a snapshot, map onto it, and say which fields are ours.
- No screen capture, keystroke logging, screenshot OCR, or clipboard monitoring — including as an
  optional module. Being obviously not-that is worth more than any coverage it would add.
- No hook-based collection as the primary mechanism. Hooks are fragile, developer-visible and
  bypassable; they are an optional add-on for real-time cases, never the substrate.

---

## Open questions

Decisions, not research tasks. Each one changes the order of the tiers above.

- Will design partners accept an on-device SQLite store as compliance evidence, or do they demand
  server-side retention from day one? The answer decides whether Tier 7 export and Tier 8 fleet
  sync move ahead of Tier 5 and Tier 6, and whether the pilot needs the relay before it needs the
  tool ledger.
- Does pseudonymise-at-insert plus a no-performance-axis guarantee actually clear a German works
  council and a French CSE consultation, or does the EU default have to be aggregate-only with an
  incident-scoped unseal? This changes what the People view is allowed to render by default, not
  just what it logs.
- How much of the account-class classifier is provable rather than inferred, per vendor? Claude
  Code writes oauthAccount with organizationUuid and billingType to ~/.claude.json, but that is a
  current-account snapshot, not a per-session binding; what Codex rollouts, Cursor, and OpenCode's
  account tables actually record per session is unverified and determines whether shadow_account
  is an incident or a hint.
- Can the DLP scan hit a useful throughput in TypeScript on Apple Silicon inside a byte budget
  that keeps the collector under ~1% CPU? Regex throughput here is unbenchmarked, and the obvious
  fixes (a native module, a worker thread) collide with the zero-runtime-dependency SEA
  constraint.
- Agents delete their own transcripts at roughly thirty days. Does 'evidence freeze on notice'
  copy anything, and if it must not copy content, what exactly does a frozen finding retain that
  survives the source disappearing — offsets and hashes that can never be re-verified, or nothing
  at all?
- Will the design partner's MDM actually push a PPPC SystemPolicyAllFiles profile before the pilot
  starts, and what does the product do in the reduced-functionality state? Reporting 'unknown'
  rather than zero is the honest answer, but it may be an unsellable first impression.
- Is the buyer the CISO (shadow AI and leak detection) or the platform engineering lead (posture
  and FinOps)? The tier order assumes the CISO; if the first three deals come from platform teams,
  posture and reconciliation should trade places with data exposure.
- Do we sell alongside CrowdStrike, Zscaler and LiteLLM with the coverage-delta report as the
  wedge, or against them? If alongside, export is the product and belongs earlier than Tier 7; if
  against, the desktop evidence experience is the product and export can wait.
- MIT core plus a licensed /ee, or FSL on the server only? This decides whether design partners
  can legally run the relay during a pilot and whether a hosted clone is a real risk worth the
  licence friction.
- Does the SwiftUI app keep hand-porting every read model into DB.swift? At ten screens the
  double-write becomes the dominant cost and the app will silently lag the core; a generated read-
  model contract is either cheap insurance now or a rewrite later.
- Is per-active-agent-host pricing legible when the same human runs agents in containers,
  devcontainers and CI runners? execution_contexts makes the count honest but may make the invoice
  surprising.
- Whose key signs the content packs, and what happens when a customer wants to author their own
  detectors? The two-trust-class model needs a customer trust anchor from the start or the first
  enterprise request breaks it.


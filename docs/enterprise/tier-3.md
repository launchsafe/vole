# Tier 3 — Per-employee attribution, and the privacy floor that must ship in the same release

[← Enterprise roadmap index](../ENTERPRISE-ROADMAP.md) · 42 features

Turning a per-device inventory into a per-employee one is the moment Vole becomes an enterprise
product and simultaneously the moment it becomes an employee-monitoring system under GDPR Art. 88,
BetrVG § 87(1) Nr. 6 and potentially AI Act Annex III 4(b). Those two facts arrive together and
must ship together, so this tier is one unit: the identity seam at `db.ts` ORIGIN replaced with a
declared identity plus a Keychain-HMAC principal computed at insert (not at sync), a stable device
id from IOPlatformUUID, the `session_identity` ledger with a `binding_evidence` rank, the account-
class classifier that reads the auth path — org OAuth, personal OAuth, raw API key,
Bedrock/Vertex, local base-URL router — and the `console_invisible` tag that names, exactly, the
spend no vendor console can ever show. Shadow AI becomes 'which employee',
shadow_account_on_corporate_repo becomes possible, and `v_people` renders per-person figures with
attribution coverage attached to each one. The floor shipping alongside is not optional
decoration: pseudonymisation at insert, email and name never stored (enforced by `verify
--identity`), a first-run scope gate with real consent in personal mode and a declared lawful
basis in managed mode, a deployment-mode resolver, the shipped read manifest with per-scanner
switches, the egress inventory and `network_calls` ledger with a `VOLE_NO_EGRESS` switch, a per-
person view gate with an access log and subject notice, and an explicit no-productivity-axis rule.
Ordering it any later means the first per-person screen is built without the machinery that makes
it lawful, and every works council conversation starts from a retrofit.

Legend: `category` · `buyer` · effort **S**/**M**/**L**/**XL** · feasibility (*exact* =
readable from local data today, *partial*, *new instr.* = needs something written that does
not exist, *network* = crosses the network line) · value 1–5, 5 meaning a security lead blocks
the rollout without it. `unscored` came from a completeness sweep and skipped the verifier.

---

### 1. console_invisible auth-path tag (Bedrock, Vertex, base-URL, router)

`Shadow AI` · `FinOps` · **M** · exact · 4/5

Claude Code under Bedrock or Vertex is excluded from both the Analytics API and the Compliance
API, and a base-URL override or a local router removes the traffic from Anthropic's billing
relationship entirely — all three are detectable on disk with no network. Classify each session's
`auth_path` from the settings-layer `env.{ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX}` and `apiKeyHelper`, from Codex
`session_meta.payload.model_provider` and `turn_context`, from OpenCode `providerID`, and from
model-id shape.

**In the app** — Reconciliation coverage strip: 'K% of observed value used an auth path no vendor
console reports (router: 461 calls, Bedrock: 0, base-URL override: 0)'; the same tag appears as a
chip on affected sessions in the session list.

**Source** — ~/.claude/settings.json and settings.local.json `env`/`apiKeyHelper`; ~/.claude-code-
router/{config.sqlite, gateway-proxy-preload.cjs, global-profile-takeover.json} (all present
here);

**Limit** — A settings file records intent at read time, not what a process actually used: an
environment variable exported in a shell leaves no trace on disk, so the classification is a lower
bound and must be labelled configuration evidence.

*Extends the earlier entry "Model-route integrity and allowlist (model_provider_rerouted,
model_switch, model_not_allowed)".*

### 2. Stable machine identity (IOPlatformUUID) and a hostname history

`Identity` · `Platform` · **S** · exact · 4/5

usage_events.machine is os.hostname() (db.ts:19-35) — 'Marys-MacBook-Pro.local' on all 29,293
live rows here. That string contains an employee's first name and changes when DHCP or the network
changes, so a fleet keyed on it both leaks a name and splits one laptop's history into several.

**In the app** — Settings → Identity shows 'This Mac' with the truncated stable id, the current
hostname and any earlier hostnames as a small history list, plus a note that neither the hostname
nor the label ever leaves the machine.

**Source** — ioreg IOPlatformExpertDevice → IOPlatformUUID; scutil --get ComputerName ("Shiva's
MacBook Pro" here);

**Limit** — Requires one child-process spawn from the SEA collector, which is otherwise spawn-
free; on Linux and CI there is no IOPlatformUUID and machine_uuid stays NULL with the hostname as
the only key.

*Corrects the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 3. Seat inventory and seat-value reconciliation from vendor-observed plan fields

`FinOps` · `FinOps` · **M** · partial · 3/5

A per-principal, per-tool inventory of the plan actually observed — Claude
`organizationType:'claude_max'` with `organizationRateLimitTier:'default_claude_max_20x'`,
`billingType:'stripe_subscription'`, `seatTier`; Codex `chatgpt_plan_type:'team'`; Grok
subscription_tier — rendered against a plain `seats_purchased` block in the policy file, producing
three named buckets: seats paid for with no usage observed, usage observed on a plan the company
never bought (shadow spend), and matches.

**In the app** — A 'Seats' card in the People view listing each tool with observed plan, purchased
seats and the three buckets, and a Reconciliation header card with one row per detected plan
showing consumed list value, declared seat price, the labelled ratio and the current weekly-limit
percent;

**Source** — ~/.claude.json oauthAccount.{organizationType, organizationRateLimitTier,
billingType, seatTier, userRateLimitTier} (all present here); ~/.codex/auth.json id_token
chatgpt_plan_type;

**Limit** — Absence of usage is not proof a seat is unused — it may mean Vole was never installed
on that person's Mac, which is why the bucket is labelled 'no usage observed by Vole', never
'unused'. The plan string is what the client was told at runtime, not the billing record.

*Extends the earlier entry "Contract rate cards, rate_source labelling and seat-price
comparison".*

### 4. Email and name never stored: domain plus HMAC, enforced by verify --identity

`Governance` · `DPO` · **M** · exact · 5/5

~/.claude.json oauthAccount carries emailAddress, fullName and displayName in cleartext, and they
are the most tempting fields in the product. The rule: store HMAC-SHA256(lowercased email) under a
per-install key kept in ~/.vole/identity.json (mode 0600) plus the bare domain string, and nothing
else — no local part, no name, in any column, export or incident detail. 'pnpm verify --identity'
scans every identity column and every export row for an '@'-shaped token or a value matching the
local oauthAccount name fields and fails the run on a hit;

**In the app** — Settings → Privacy lists identity fields read beside identity fields stored —
'emailAddress → domain only, address hashed; fullName → read, never stored' — with the last verify
--identity result and date beneath.

**Source** — ~/.claude.json oauthAccount.{emailAddress, fullName, displayName}; the new identity
columns;

**Limit** — A domain alone cannot separate an employee from a contractor, or from a personal
account on a custom domain. The HMAC is reversible by anyone holding both the key and a candidate
address, so it is pseudonymisation, not anonymisation, and must be described that way to a works
council.

*Extends the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 5. Privacy Center with live export-payload inspector

`Desktop` · `Procurement` · **M** · partial · 4/5

A sidebar section under Manage rendering four columns generated from the running build rather than
from prose. Read: each of the 11 paths in paths.ts resolved against this home with existence,
last-scanned time and the env override in force. Stored: every column of usage_events, anomalies,
collector_state and any new table, each with its non-NULL rate and one real example value from the
viewer's own database via PRAGMA table_info.

**In the app** — New 'Privacy' section with a lock icon beside Settings, four tabs; the Shared tab
carries the sink selector, the rendered payload in a monospaced scroll view with a Copy action,
and the dropped-columns list;

**Source** — paths.ts accessors; schema.ts DDL plus PRAGMA table_info against the viewer's own
~/.vole/vole.db;

**Limit** — 'Never stored' is a claim about Vole's code, backed by `verify --content` over the
actual DB — it says nothing about the vendor logs on the same disk, which hold full prompts and,
per a self-audit of 59 Claude Code transcripts, live credentials, so the panel must link that out
rather than imply the machine is clean.

*Extends the earlier entry "'What leaves this machine' panel, vole transparency and the notice-
acknowledgement gate".*

### 6. Deployment mode resolver: personal vs managed

`Platform` · `Procurement` · **S** · partial · 4/5

One function resolves the install's posture from the presence and completeness of /Library/Managed
Preferences/com.launchsafe.vole.plist (only an MDM-installed configuration profile writes there)
into install(mode, org_label, profile_hash, resolved_at), and every product default reads it.
Personal mode: identity columns NULL, no notices, no audit log, no purpose binding, every content-
reading scanner on, retention unlimited, all per-person views available, MCP unrestricted. Managed
mode inverts each of those and is the only mode in which identity attribution, per-person views,
the access-audit log, purpose binding and pseudonymisation-at-sync activate.

**In the app** — A small pill beside the range selector in MenuPanel and in the DashboardView
title bar reading 'Personal' or 'Managed · <org_label>', opening a new Privacy section; Settings
gains a read-only Deployment row showing the declared mode and profile hash.

**Source** — /Library/Managed Preferences/com.launchsafe.vole.plist (MDM-only write path);
UserDefaults domain com.launchsafe.vole (existing
vole.theme/menubar/refresh/loginItem/range/section keys);

**Limit** — A local admin can hand-write a plist in /Library/Managed Preferences and macOS offers
no API to prove a profile was MDM-delivered rather than placed by root, so the UI says 'declared',
never 'attested'. A developer on a company laptop stays in personal mode until a profile actually
arrives — Vole cannot tell whose laptop it is.

*Related to the earlier entry "packages/enterprise (ELv2) edge-gated in the same binary, vole
licence CLI and entitlement surfacing".*

### 7. Principal resolution chain and the v_events_principal read-time join

`Identity` · `Platform` · **M** · partial · 5/5

Resolve who a row belongs to in a fixed precedence — managed preference (/Library/Managed
Preferences, which exists on this Mac) > $VOLE_USER > ~/.vole/identity.json >
os.userInfo().username — and record principal_source alongside, so a report can say 'MDM-asserted'
rather than 'OS username, unverified'. Because the upsert can never rewrite usage_events.user
(db.ts:87-101 excludes it from the SET list), the resolution is a read-time join and not a
backfill: a `principals(user, machine_uuid, principal_id, principal_source, valid_from, valid_to)`
table plus a `v_events_principal` view that every new per-person query selects from.

**In the app** — Settings → Identity shows the resolved principal and, in plain words, which of
the four sources won; a warning row appears when the winning source is the bare OS username.

**Source** — usage_events.user ('shiva' on all 29,293 live rows) and .machine; new
~/.vole/identity.json;

**Limit** — Nothing local can prove a principal: every source in the chain is an assertion by
whoever controls the laptop, and MDM raises the bar but a local admin can still set VOLE_USER. The
view also cannot split rows collected before a laptop was reassigned unless valid_from/valid_to
were recorded at the time.

*Corrects the earlier entry "Fleet view with SSO and RBAC".*

### 8. Egress inventory, network_calls ledger and a VOLE_NO_EGRESS switch every caller honours

`Governance` · `DPO` · **M** · exact · 5/5

Vole ships one undisclosed network call today — UpdateChecker.swift:27 GETs
api.github.com/repos/launchsafe/vole/releases on every launch from init(), with no opt-out, while
README:22, SECURITY.md:13 and the Settings footer all say nothing leaves the machine — and any
reconcile or sync adapter would be the second.

**In the app** — Settings → Network: the generated inventory table (two rows today), a master off
switch, and a log of the last N calls with host, status and bytes; the About footer's 'Nothing
leaves your machine' line is replaced by the live inventory, or by 'No egress' when the switch is
on.

**Source** — apps/mac/Sources/Vole/UpdateChecker.swift:20-27; any future reconcile or sync
adapter;

**Limit** — The inventory covers calls Vole's own code makes; it says nothing about the agents
Vole watches, which talk to model APIs constantly, nor about a corporate proxy intercepting
either.

*Extends the earlier entry "Opt-in update check and CI-enforced self-egress allowlist".*

### 9. Your-own-rows inspector

`Desktop` · `Developer` · **M** · exact · 3/5

A tab inside the Privacy Center showing a paginated table of the literal rows keyed to this
subject — usage_events, anomalies and any findings — with every column raw, a filter by tool and
date, and 'Copy as JSON' / 'Save as JSON' actions. No aggregation, no chart, no interpretation:
the persuasive fact in a works-council meeting is not a policy document but a developer scrolling
their own record and finding it is model names, token counts and paths. It doubles as the
interactive half of the DSAR export, reading the same rows `vole dsar export` writes.

**In the app** — Privacy section → 'Your record' tab: a plain Table whose column headers match the
schema exactly, a row count, and the date of the oldest row held.

**Source** — usage_events and anomalies filtered on the subject's user/machine columns (or all
rows in personal mode), read through the existing DB.swift sqlite3 C API port.

**Limit** — It shows what Vole holds now — not what an admin exported yesterday, and not rows
already removed by retention or prune. On a shared machine it can only show rows whose origin
matches this subject, and rows collected before identity stamping keep NULL user/machine and are
shown in a separate 'origin unknown' bucket rather than being attributed by guesswork.

*Extends the earlier entry "Data-subject access and erasure: vole dsar export and vole forget".*

### 10. Release gate: privacy machinery ships with the MDM kit, not after fleet sync

`Platform` · `Platform` · **S** · exact · 3/5

A structural correction to v1's shipping order rather than a new screen. v1 puts every privacy
control in Tier 7 gated on the network line, while the MDM pkg and managed preferences land in
Tier 5 — so the published order has companies deploying to employee laptops two tiers before the
basis record, the Privacy Center and the per-person-view gate exist. Under GDPR the processing
that triggers Art.

**In the app** — No new screen; the gate's effect is that a managed build without those three
cannot be produced.

**Source** — apps/mac/bundle.sh (VERSION default and the ad-hoc vs --release signing path);
.github/workflows/ci.yml (today: install, typecheck, test, collect:once on ubuntu;

**Limit** — This is a gate on Vole's own release pipeline only. Nothing stops an organisation
building from source with the checks removed and the licence does not prevent it, so the gate
makes the shipped artifact defensible, not the codebase tamper-proof.

*Corrects the earlier entry "MDM / Jamf deployment: signed .pkg and managed preferences".*

### 11. Pseudonymise at insert, not at sync

`Identity` · `DPO` · **L** · exact · 4/5

db.ts:19-35 origin() stamps os.userInfo().username and os.hostname() onto every row: all 29,293
live rows here read 'shiva' / 'Marys-MacBook-Pro.local', a person's login and first name. In
managed mode replace that stamp with a random 128-bit subject_id generated once and held in the
macOS Keychain (never in vole.db) plus a device_id from IOPlatformUUID, so the on-device store is
already pseudonymous before anything is exported.

**In the app** — Privacy section → 'Identity' card: subject_id prefix, device_id, the sentence
'your macOS username is not stored', and a 'Migrate existing rows' button showing the count of
rows still carrying cleartext (29,293 today).

**Source** — db.ts:19-35 origin() and the ORIGIN spread at db.ts:129 and :154;
usage_events.user/machine;

**Limit** — Pseudonymising identity does not de-identify the rows: usage_events.project is an
absolute cwd and the overwhelming majority here begin <redacted-local-path>, raw_ref embeds -Users-shiva,
and every collector_state primary key is a path under the user's home — those three channels re-
identify the subject on their own and need their own treatment.

*Corrects the earlier entry "Identity pseudonymisation modes at sync (cleartext / HMAC-org-key /
aggregate-only k)".*

### 12. Shipped read manifest and per-scanner switches

`Governance` · `DPO` · **M** · exact · 4/5

The newer scanners read outside the seven agent stores — browser history, launchd plists, shell rc
files, the whole /Applications tree — and a works council or DPO objects to exactly those. Ship
packages/core/src/data/scanners.json (beside the existing pricing.json) listing every scanner with
the paths it reads, the fields it extracts, the fields it deliberately does not read and a default
enabled state; render it verbatim in the app;

**In the app** — A 'What Vole reads' screen listing each scanner as a row — name, paths, fields
stored, fields never read, and a toggle locked with a lock glyph when the managed policy pins it;
every AI Surfaces and Leak Ledger panel names the scanners that contributed to it.

**Source** — packages/core/src/data/scanners.json (shipped); ~/.vole/scanners.json and
/Library/Application Support/Vole/policy.json for state, following the pricing.json override
precedence.

**Limit** — The manifest is a promise the code must keep, so it is only a control with a test that
wraps fs reads and fails the build when a scanner touches a path the manifest does not declare —
without that test it is documentation. A managed policy can force a scanner on, which is the point
for fleet deployment but must be visible to the employee rather than silent.

*Extends the earlier entry "Redaction manifest and verify --content (prove the DB and exports hold
no content)".*

### 13. People view

`Desktop` · `Eng mgr` · **M** · partial · 3/5

A sidebar section beside Overview and Incidents with one row per principal: tokens, cost,
sessions, incident count, per-tool account_class badges, a binding_evidence badge and the
bound/ambient/unbound triple. It requires getByPrincipal(range, includeSeed) in queries.ts and a
hand-written DB.swift port, since the app opens SQLite through the C API and mirrors only summary,
timeseries, anomalies, breakdown and collectorLastSeen today. Row order is fixed by token volume
with no ranking language, no percentiles and no per-person deltas over time;

**In the app** — 'People' item in the Monitor sidebar group; a table of principal rows with
badges;

**Source** — v_events_principal (a view over usage_events.user/machine, unread by any query today)
joined to session_identity and anomalies; queries.ts plus DB.swift port.

**Limit** — On a single-employee laptop this is exactly one row and adds nothing — it is
meaningful only once fleet sync exists, and until then it is a self-view that must be labelled as
one. Rows collected before identity stamping carry NULL user/machine and appear in a separate
'origin unknown' bucket, never merged into a named principal;

*Extends the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 14. PPPC payload generated from Vole's own signature, and the ad-hoc cdhash trap

`Platform` · `Platform` · **M** · exact · unscored

`codesign -d -r- apps/mac/build/Vole.app` on this repo prints `designated => cdhash
H"89b9c3c12129e12d83d9478271c004ebcbe1addc"` with `TeamIdentifier=not set`, because bundle.sh's
non-`--release` path ad-hoc signs. A TCC grant is keyed on the bundle identifier **plus** the
designated requirement, so under a cdhash DR every rebuild is a different application to TCC:
every grant evaporates with no error, no prompt and no log line, and the whole fleet renders
zeros. Add `vole pppc` and a Settings button that read the running app's own requirement via
`SecCodeCopySelf` → `SecCodeCopyDesignatedRequirement` → `SecRequirementCopyString`
(Security.framework, no dependency;

**In the app** — Settings > Deployment: the generated requirement string in a selectable copy
field, a "Save .mobileconfig…" button, and a red inline note on ad-hoc builds — "this build's
permission grants die on the next rebuild; ship a Developer ID build before enrolling any device".

**Source** — The running bundle's own code signature (SecCodeCopyDesignatedRequirement);
apps/mac/Info.plist CFBundleIdentifier com.launchsafe.vole.

**Limit** — Vole can print the requirement its own binary satisfies; it cannot verify that an MDM
delivered the profile, cannot read back which TCC services a profile granted, and cannot detect a
profile that was pushed then removed.

*Extends the earlier entry "MDM / Jamf deployment: signed .pkg and managed preferences".*

### 15. Scoped, logged local MCP server

`Governance` · `DPO` · **M** · exact · 5/5

cli/mcp.ts exposes seven unscoped tools with no caller identity, so any agent that can spawn the
binary enumerates every session of every tool on the machine — absolute project paths, branch
names, session ids, and via vole_session any session id it can guess. For a product whose pitch is
that it never stores prompts, that is the exact leak it detects, and on this machine an agent
reading that inventory would carry it to whichever model the claude-code-router route points at.

**In the app** — Settings → 'Local MCP access': recent queries by tool, caller cwd and row count,
a master off switch and an 'MCP: restricted (managed)' status line beside the existing DB path
row, linked from the About footer;

**Source** — packages/core/src/cli/mcp.ts:19-94 TOOLS array (vole_summary, vole_live_sessions,
vole_session, vole_incidents, vole_breakdown, vole_whatif, vole_digest), serverInfo.version hard-
coded '0.1.0' at mcp.ts:94; queries.ts:396-400 getSessionDetail.

**Limit** — stdio MCP carries no authenticated caller identity — parent pid and cwd are the
strongest evidence available and both are trivially spoofable by the same agent, so the log is a
record, not a control.

*Corrects the earlier entry "Self-protecting store and MCP self-hygiene".*

### 16. execution_context_id on every row, and the origin quarantine for rows this machine did not produce

`Identity` · `DPO` · **M** · exact · unscored

Today `db.ts:19-35` stamps `os.userInfo().username` and `os.hostname()` on every row at insert,
which silently asserts that whoever runs the collector is whoever ran the agent. For a bind-
mounted or synced agent home that assertion is false, and the People view presents another
machine's work as this employee's. Add a nullable `execution_context_id` column to `usage_events`,
`anomalies`, the tool-call ledger and the secret ledger via the existing add-nullable-column
migrate() probe, plus a `PRAGMA user_version` stamp so DB.swift and queries.ts agree on the shape.

**In the app** — People view rows split into 'this machine' and 'other contexts' bands, with the
unknown-origin band shown even when empty so its absence is a measurement. Your-own-rows inspector
gains an origin column so a subject can see exactly which of their rows Vole claims were produced
here.

**Source** — packages/core/src/db.ts origin()/ORIGIN and the insert spreads; schema.ts add-column
migration;

**Limit** — A context id is only as good as the evidence that produced it, and there are exactly
two kinds of evidence — a foreign root and a declared import — so everything else is `local` by
default and that default is itself an assumption stated on the card.

*Corrects the earlier entry "Principal resolution chain and the v_events_principal read-time
join".*

### 17. session_identity ledger with a binding_evidence rank

`Identity` · `CISO` · **L** · partial · 5/5

Adds one append-only table `session_identity(tool, session_id, principal_id, account_id, org_id,
account_class, class_evidence, plan, seat_role, surface, binding_evidence, first_seen, last_seen,
source)` UNIQUE on (tool, session_id), written by the same collector pass that writes usage_events
but through its own insert seam beside db.ts:insertEvents. Identity deliberately does not become
columns on usage_events: db.ts:87-101 rewrites a stored row only when excluded.total_tokens is
STRICTLY greater and its SET list excludes user/machine/model/session_id, so an identity value set
wrong on the first insert could never be corrected.

**In the app** — Not a screen of its own: it is the join every People row, account chip and
identity incident drills into.

**Source** — Fields already in hand inside each collector loop: claude-code.ts line stream
(type:'bridge-session' ownerAccountUuid/ownerOrganizationUuid), codex.ts rollout payloads
(token_count.rate_limits), grok.ts ctx objects, opencode.ts session rows; table lives in
~/.vole/vole.db beside usage_events.

**Limit** — A session with no identity-bearing line gets account_class NULL and
binding_evidence='none' — never a guess — and on this machine that is the majority: 18 Claude
transcript files carry a bridge-session line, 12 of 66 Codex rollouts carry plan_type, and
OpenCode's account, account_state and control_account tables are all empty (0 rows), so every one
of the 10,885 OpenCode rows is unbindable.

### 18. First-run scope gate: real consent in personal mode, declared lawful basis in managed mode

`Governance` · `DPO` · **L** · partial · 5/5

A four-step first-launch sheet — (1) every path Vole will read, listed from the paths.ts accessors
with a live found/not-found probe beside each; (2) every column it stores, generated from the
redaction manifest, beside the never-stored list (prompts, tool arguments, tool output, file
contents, credentials); (3) where data goes — local only, sync off, update check off;

**In the app** — A modal first-run sheet over the dashboard window, replacing today's straight-to-
dashboard behaviour in VoleApp.swift:19-26;

**Source** — paths.ts accessors probed with FileManager; the redaction manifest column list;

**Limit** — Vole cannot verify that a works agreement or a DPIA exists — it renders strings the
profile declares and must label them 'declared by <org>, not verified'. A local consent record is
documentation, not a lawful basis: a German works council still needs a §87(1) Nr.

*Corrects the earlier entry "vole init and first-run wizard with ~/.vole/consent.json".*

### 19. Account-class classifier from the auth path

`Identity` · `CISO` · **M** · partial · 5/5

A pure function mapping observed fields to exactly one of org_oauth | personal_oauth | api_key |
cloud_provider | team_seat | unknown, writing account_class plus the literal deciding field and
value into session_identity.class_evidence so an incident can quote it. Rules verified here:
~/.claude.json oauthAccount.{organizationType:'claude_max', billingType:'stripe_subscription',
seatTier:null, organizationRole:'admin', organizationRateLimitTier:'default_claude_max_20x'} →
personal_oauth (a personal Max subscription, not a company seat); ~/.codex/auth.json auth_mode
('chatgpt', 7 chars) with OPENAI_API_KEY===null → OAuth not raw key;

**In the app** — New Dashboard section 'Accounts': per tool a stacked bar of calls by
account_class over the range with an explicit 'unproven (current-account snapshot)' band;
account_class becomes a group-by in Breakdown beside model and project;

**Source** — ~/.claude.json oauthAccount.{organizationType, organizationRole, workspaceRole,
billingType, seatTier, organizationRateLimitTier, profileFetchedAt} and machineID/userID (64-hex,
opaque); ~/.codex/auth.json {auth_mode, OPENAI_API_KEY presence, tokens.account_id presence};

**Limit** — oauthAccount is a snapshot of the account signed in when Vole last collected — dated
by profileFetchedAt (1788735002155 here), not by the session — so for Claude Code a class binds
per session only where a bridge-session line recorded ownerAccountUuid/ownerOrganizationUuid (18
files here);

*Extends the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 20. Per-person view governance: default gate, access log, subject notices, no productivity axis

`Governance` · `DPO` · **L** · partial · 5/5

Three switches over one view, so a works council has a single named artifact instead of scattered
defaults. The People view ships collapsed to a 'This is you' card whenever the store holds one
principal and refuses to render a multi-person table unless a people_view: {enabled, granted_to,
reason} block exists in the policy file — its absence is a hard off, not a warning.
productivity_views defaults on in personal mode and off in managed mode;

**In the app** — People view renders as one card by default; with the policy block present it
shows a 'per-person view enabled by policy <hash>' strip and a mandatory reason field.

**Source** — ~/.vole/policy/identity.json people_view and productivity_views blocks; new
access_log table in ~/.vole/vole.db written by the purpose-bound query builder and cli/mcp.ts;

**Limit** — A local admin holding the SQLite file bypasses every gate — this is the product's
default behaviour plus an audit trail, not a security boundary against the machine's owner, and
FileVault is the only real control there.

*Corrects the earlier entry "No per-person leaderboards by default; per-person views need role,
reason and notify the subject".*

### 21. Codex per-session plan from the rollout, not from auth.json

`Identity` · `CISO` · **S** · exact · 4/5

roadmap-v1 proposes reading a Codex account_id from ~/.codex/auth.json, while its own warning says
never to open that file for identity — and rightly: it holds tokens.id_token (1820 chars),
access_token (1765) and refresh_token (196). The rollout already answers the question in the
session's own file with its own timestamp: token_count.payload.rate_limits carries plan_type,
limit_id, individual_limit and spend_control_reached, and codex.ts:126-134 already parses that
exact object for rate_limit_pressure and throws plan_type away. Store plan_type, limit_id and
individual_limit on session_identity with binding_evidence='session_proved';

**In the app** — Codex rows in the People view show the plan (team / free / plus) with a 'from
this session' evidence dot; Breakdown gains a per-plan split under the Codex tool section.

**Source** — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, line type token_count,
payload.rate_limits.{plan_type, limit_id, individual_limit, spend_control_reached} — the object
codex.ts:56-58 already types.

**Limit** — 62 of 66 rollouts here carry a rate_limits object but only 12 carry plan_type (47
lines in total: 'team' 43, 'free' 4), so most Codex sessions have plan NULL and must render as
'—', not as a default. plan_type is what the server told the client at that moment, not a billing
record, and a short session that never hit a meter has no such line at all.

*Corrects the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 22. Privacy Center: path receipts, field dictionary, egress and self-DSAR

`Governance` · `Developer` · **L** · partial · 5/5

One permanent screen answering 'what does this thing know about me', built from live rows rather
than from documentation: per-path read receipts from sources/collector_runs (path, last read,
bytes scanned, rows produced); a column data dictionary generated from the redaction manifest
(column, type, example shape, why); the resolved principal with which source won, the machine-id
and hostname history, per-tool account_class with the literal deciding field, and the identity
fields read but discarded (emailAddress, fullName, displayName, key prefixes, tokens);

**In the app** — Privacy Center in the sidebar with sections Paths read (table with Reveal in
Finder), Fields stored, Identity, Network and Who looked at your data — reachable in one click
from the People card, every row citing its source path — plus Export my data and Delete my data
buttons at the foot.

**Source** — paths.ts accessors; sources/collector_runs rows;

**Limit** — It describes what this build stores and cannot prove that a modified or future build
behaves the same, which is why the manifest, verify --content and verify --identity must ship with
it.

*Extends the earlier entry "'What leaves this machine' panel, vole transparency and the notice-
acknowledgement gate".*

### 23. Credential-shape probe that never reads a credential

`Identity` · `DPO` · **M** · exact · 4/5

For sessions the transcripts cannot classify, a shape-only reader records whether a credential
file exists and what kind it is, under a hard rule that no retained string exceeds 16 characters.
On ~/.codex/auth.json it records auth_mode, OPENAI_API_KEY===null (so: ChatGPT OAuth, not a raw
key), presence of tokens.account_id and last_refresh — never the three token strings in the same
object. On ~/.grok/auth.json it records the issuer host from the object key
(https://auth.x.ai::<uuid>), auth_mode 'oidc' and the presence of team_id and principal_id — never
.key (786 chars), .refresh_token, .email or .first_name, which sit in that same object.

**In the app** — Settings → Identity lists each tool as 'signed in via OAuth' / 'raw API key
configured' / 'org-bound OIDC' / 'not configured' with the path it was read from and the
observation time; no value is ever displayed, and a 'what this reads' disclosure names each key by
name.

**Source** — ~/.codex/auth.json (auth_mode, OPENAI_API_KEY, tokens.account_id presence,
last_refresh); ~/.grok/auth.json (object key, auth_mode, principal_type, team_id/principal_id
presence);

**Limit** — This is a snapshot of the credential configured now, not of any past session, and it
is the one code path in the whole lens that opens a secrets file — it must be consent-gated, off
by default, and it is the first thing a hostile security reviewer will read.

### 24. NON-GOALS charter with the canary proof behind it

`Governance` · `DPO` · **M** · exact · 4/5

Write down what Vole will never build and make each line executable rather than a memo: no proxy,
MITM or base-URL rewrite; no browser extension; no prompt, tool-argument or tool-output storage;

**In the app** — Settings → 'Scope and limits': the charter rendered as a list, each line green-
checked with the name of its check and its last CI status, plus the last verify --content result
and date replacing today's hard-coded 'Verification: Every stored row reconciled' string at
DashboardView.swift:703;

**Source** — scripts/check-egress.mjs; packages/core/src/cli/verify.ts (top-level await today and
not importable — this needs it refactored to a callable);

**Limit** — A CI check proves a property of the shipped source, not of a modified build — anyone
can fork Vole and delete the test, so the charter is evidence about the release the user installed
and says so. The canary proves only the paths the test enumerates and can say nothing about the
freed pages of a database VACUUMed by an external tool.

*Extends the earlier entry "Redaction manifest and verify --content (prove the DB and exports hold
no content)".*

### 25. Cloud-provider class from model-id shape and the settings env snapshot

`Identity` · `FinOps` · **S** · partial · 3/5

The cloud_provider class is the one arm the classifier cannot demonstrate on this machine, so it
is built as an explicit shape rule with a no-data state rather than a silent zero. A session is
classified cloud_provider when usage_events.model matches a provider-routed id shape
(us.anthropic.*, anthropic.claude-* for Bedrock; publishers/anthropic/models/* for Vertex;

**In the app** — Account badge reads 'Bedrock' / 'Vertex' / 'Foundry' with the matched model-id
shape on hover; Settings → Identity lists the env key names observed (names only) and, when none
exist, the line 'no cloud-provider routing observed on this Mac' rather than a zero.

**Source** — usage_events.model; ~/.claude/settings.json env block — which on this install is
absent entirely (keys present: permissions, enabledPlugins, extraKnownMarketplaces, effortLevel,
remoteControlAtStartup, agentPushNotifEnabled, skipDangerousModePermissionPrompt).

**Limit** — Zero rows on this machine demonstrate the class, and the settings file carries no env
block at all, so the rule ships unverified against live data. A model-id shape is forgeable by any
proxy, and the settings snapshot describes now and must never be stamped onto historical rows.

### 26. Scope-change ledger with an employee-visible field-level diff

`Governance` · `DPO` · **S** · exact · 4/5

§ 87(1) Nr. 6 BetrVG co-determination attaches to changes in a monitoring system, not only to its
introduction, and Dutch WOR Art. 27 consent is scoped to what was agreed.

**In the app** — Privacy Center → 'Scope history' timeline, newest first, each entry expandable to
the added and removed field list; a one-time dismissible banner on the Dashboard when a change is
first observed.

**Source** — packages/core/src/sync/manifest.ts column list, ~/.vole/policy.json,
collectors/index.ts:21-29 REGISTRY, schema.ts column inventory, hashed with node:crypto at
collector startup.

**Limit** — Changes are detected only while the collector runs, so a scope changed while the app
was off surfaces with the date it was first observed and must be labelled 'first seen', never
'changed on'. The ledger records Vole's own configuration and cannot see an admin editing the
managed profile and reverting it before the next start.

*Extends the earlier entry "'What leaves this machine' panel, vole transparency and the notice-
acknowledgement gate".*

### 27. ~/.vole/policy/identity.json — the corporate declaration with a propose step

`Identity` · `Procurement` · **S** · exact · 4/5

The one policy input every identity rule needs: {corporate_org_uuids[], corporate_email_domains[],
corporate_repo_owners[], sanctioned_account_classes[]}, hash-stamped so every incident can name
the policy version that judged it. Vole never guesses the contents: 'vole identity propose' reads
~/.claude.json githubRepoPaths and the org UUIDs it has actually observed in session_identity rows
and prints a candidate file to stdout for a human to edit and commit, writing nothing. Absent the
file, every identity rule (shadow_account included) is inert and the People view shows account
classes with no verdict.

**In the app** — Settings → Identity shows the policy file path, its sha256, and 'no policy loaded
— identity incidents are disabled' when absent, with copy-to-clipboard of the proposed file.

**Source** — New file under ~/.vole/policy/; the propose step reads ~/.claude.json githubRepoPaths
and observed session_identity.org_id values.

**Limit** — A declaration is only as good as whoever wrote it — a contractor on a corporate-
looking domain, or a personal repo under a company org, is classified wrong and Vole has no way to
know. The propose step can only suggest what it has already seen, so a repo no agent ever touched
never appears.

*Extends the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 28. Inalienable exclusion floor for personal work on a corporate device

`Governance` · `Developer` · **L** · partial · 4/5

v1's monitoring-scope feature lets the org set exclusions.never_excludable with no floor, so an
employer can forbid all exclusions and the personal-project carve-out that almost every works
agreement contains becomes unenforceable in the tool. Add a floor the org cannot override: any
path outside the profile's declared workRoots is always excludable by the employee, and for an
excluded session the org receives a count only — never the project path, branch, model or token
totals.

**In the app** — Privacy Center → 'Excluded paths': the employee's list with an add/remove
control, the declared work roots shown read-only above it, and a count of sessions excluded this
month — the same count the org can see.

**Source** — usage_events.project (absolute cwd; 26,977 of 28,948 rows under <redacted-local-path>, 1,962
empty), the transcript first-line cwd, workRoots from the managed profile, ~/.vole/exclude.json.

**Limit** — Excluding by cwd cannot catch personal work done inside a work repository, and the
1,962 rows here with no project at all cannot be classified either way — those stay unknown and
are released only as aggregates. The floor is enforced by Vole's code;

*Corrects the earlier entry "Monitoring scope policy and personal-project exclusion".*

### 29. Identity in the detection partition and the anomaly key

`Identity` · `CISO` · **S** · exact · 4/5

detectBySource (detect/index.ts:45-57) partitions on source only and prefixes keys with the
source, and no rule's anomaly_key contains user or machine — burn-rate.ts:52 is
burn_rate_spike:<tool>:<model>:<bucket>. The moment a second identity's rows share one store — a
shared Mac, a VOLE_DB on a network volume, or v1's Tier 7 relay running the same schema and rules
— two employees' windows merge into one baseline and collapse into a single UNIQUE anomaly row, so
per-employee incident counts are wrong in a way no reader can detect.

**In the app** — Dashboard → Incidents gains a per-person filter once a second identity exists;
today the pane is identical, which is the point — it is a zero-diff migration now and a data-loss
migration later.

**Source** — packages/core/src/detect/index.ts:45-57; the anomaly_key construction in detect/*.ts;

**Limit** — os.hostname() is an mDNS/DHCP name that changes on network moves, so until the
IOPlatformUUID-based id exists the widened partition can split one laptop's history in two — which
understates baselines rather than merging people, the safer of the two failure modes but still
wrong.

*Corrects the earlier entry "Opt-in fleet sync of normalised rows (org relay / Vole Fleet)".*

### 30. AI-dictionary-gated shell-history scanner with its own consent tier and a byte receipt

`Governance` · `DPO` · **M** · partial · unscored

Shell history is the most privacy-charged read in the product, so it gets a mechanism rather than
a checkbox. One named scanner, shell_history, appears in the shipped read manifest, defaults to
OFF in both personal and managed mode, and is enabled only by an explicit toggle that writes who
enabled it and when into the scope-change ledger. Its reader is two-pass: a byte-window prefilter
tests each window against the shipped AI dictionary (provider hostnames, *_API_KEY name shapes,
known CLI names) and non-matching windows are discarded without ever being decoded to a string;

**In the app** — Privacy Center gains a dedicated 'Shell history' card: the toggle, the last
receipt (bytes read / windows matched / rows stored), a worked example of what a stored row looks
like, and a one-click erase that also drops every derived row.

**Source** — ~/.zsh_history, ~/.bash_history, ~/.local/share/fish/fish_history - read through the
prefilter, and only when the scanner is explicitly enabled

**Limit** — History is a lossy, editable record of one shell, not of the machine: HISTCONTROL and
hist_ignore_space hide commands, a line proves a command was typed rather than that it ran or
succeeded, and timestamps exist only where extended history is enabled. Nothing here is
attributable beyond the account that owns the file.

### 31. Principal and account-class dimensions in every read model

`Identity` · `CISO` · **M** · partial · 5/5

Extend the read surfaces that exist rather than inventing a second one: getBreakdown gains
by='principal' and by='account_class' beside the existing model/project/branch groupings,
getSummary returns principal_id, machine_uuid and the bound/ambient/unbound triple, and the same
three appear in vole_summary/vole_breakdown and as named NDJSON export columns. Values come from
the principals and session_identity rows, so this is a read-model widening — one new GROUP BY
branch in queries.ts, the matching hand-port in DB.swift, two extra TOOLS entries in cli/mcp.ts —
and adds no collection.

**In the app** — Breakdown panel gains 'By person' and 'By account type' groupings beside the
existing per-tool and per-model rows, each row showing both the confidence badge and the binding
evidence; the unbound bucket renders as its own visible row rather than being dropped or folded
into a named person.

**Source** — packages/core/src/queries.ts getSummary/getBreakdown; apps/mac/Sources/Vole/DB.swift
ports;

**Limit** — The dimension is only as good as the binding: a principal resolved from a current-
account snapshot (oauthAccount) rather than a per-session stamp is ambient and must stay in its
own bucket, never merged into a named person's total.

*Extends the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 32. Design-partner pilot mode with a hard expiry

`Governance` · `DPO` · **M** · partial · 2/5

Make the design-partner motion a product state rather than an email thread: 'vole pilot start
--until=<date> --partner=<name>' writes an append-only record into ~/.vole/basis.json (start, end,
the exact feature set enabled for the pilot, the policy hash, who set it) and the app renders a
persistent pilot banner naming the end date. On expiry every pilot-only path — content-reading
scanners, any sync, any webhook — reverts to off automatically and the banner switches to 'pilot
ended, local-only'.

**In the app** — A per-session-dismissible banner across the top of the Dashboard for the pilot's
duration showing days remaining and what is enabled; Settings → Pilot lists the record verbatim
and the bundle history.

**Source** — ~/.vole/basis.json; the assess aggregates;

**Limit** — An expiry enforced by the same binary a determined admin can replace is a control on
the honest case, not a guarantee against the seat owner — the banner and the append-only record
are the evidence and the docs say exactly that.

*Extends the earlier entry "Assessment merge (vole.assessment.v1) and pilot report
(docs/PILOT.md)".*

### 33. People view (v_people) with attribution coverage on every figure

`Identity` · `CISO` · **L** · exact · 5/5

db.ts:19-35 stamps user and machine on every row at insert and no query, view or CLI has ever read
them. Add a `v_people` view grouping usage_events and anomalies by resolved principal (through
v_events_principal, not the raw column) with agents used, sessions, tokens, cost, unpriced count,
incidents by severity, first and last seen, and the account_class joined from session_identity.
Principle 1 then applies to identity itself: every figure is returned beside a bound / ambient /
unbound triple — the count and token sum of rows by binding_evidence — as fields of the read model
rather than a footnote in the view, so the CLI, MCP, app and export all carry the denominator.

**In the app** — New People section: one row per resolved principal with an agent-logo strip,
tokens, cost, incident severity chips, account chip and last-seen; a coverage strip at the top
states the overall bound share;

**Source** — usage_events.user/machine and anomalies.user/machine stamped by db.ts ORIGIN;
session_identity.binding_evidence and account_class;

**Limit** — The honest row on this store reads session-proved for a handful of Claude and Codex
sessions, ambient for the rest of those two tools, and unbound for all 10,885 OpenCode rows,
because OpenCode's account, account_state and control_account tables are empty.

### 34. Device tenancy band and the pre-tenancy quarantine

`Identity` · `DPO` · **M** · exact · unscored

Corrects a real mis-attribution: db.ts:19-35 stamps os.userInfo().username on every row at insert,
six of seven collectors re-read their entire source every poll (codex.ts:72, opencode.ts:53,
grok.ts:75, devin.ts:30, cursor.ts:32, antigravity.ts:21), and the upsert SET list (db.ts:87-101)
never rewrites user — so on a reassigned laptop the new holder's first pass ingests the
predecessor's rollouts (this store holds Codex rows dated 2026-05-24) and brands them permanently.

**In the app** — People view and every departure pack print 'N rows predate this principal's
tenancy — excluded, holder unknown'; the coverage strip on the timeline gains a tenancy band with
the anchor that set it.

**Source** — ~/.claude.json firstStartTime/claudeCodeFirstTokenDate/machineID; stat ctime of $HOME
and /var/db/.AppleSetupDone;

**Limit** — macOS keeps no record of who held the device before, so pre-tenancy rows stay
unattributed unless an admin declares a predecessor. Home-dir ctime is reset by Migration
Assistant and a restore, so it is labelled basis='home_ctime' and treated as evidence, never
proof.

*Corrects the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 35. shadow_account_on_corporate_repo, with 'corporate' defined in policy

`Identity` · `CISO` · **M** · partial · 4/5

roadmap-v1 proposes a shadow_account rule and then concedes it 'needs a policy definition of
corporate', which leaves it unshippable; this defines it. policy.json `identity.corporate =
{org_uuids[], git_remote_hosts[], repo_globs[]}` (user ~/.vole/policy.json, or
/Library/Application Support/Vole/policy.json when managed), and the rule fires when a session
whose cwd resolves through <cwd>/.git/config remote origin (a file read, no git spawn) or
~/.claude.json githubRepoPaths to a listed remote ran under an account_class other than org_oauth,
or under an org id not in org_uuids.

**In the app** — Incident feed row naming the repo slug, the account class and the policy clause
quoted verbatim, with a 'Show the account evidence' drill-down; the Accounts section shows an
unresolved line 'N sessions could not be bound to an account (see why)';

**Source** — session_identity.account_class and class_evidence; <cwd>/.git/config remote origin;

**Limit** — The rule is inert without a populated policy block and says so in the rule list rather
than inferring 'corporate' from a path name. It must render NULL, not a pass, in three common
cases: the repo has no remote, the cwd no longer exists, or the class came only from the current-
account snapshot.

*Corrects the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 36. account_switched incident

`Identity` · `CISO` · **S** · partial · 3/5

Fires when the account_id, org_id or plan observed for one tool on one machine changes between
sessions — the same Codex binary here produced rollouts under plan_type 'team' (43 lines) and
'free' (4). The rule groups session_identity by (tool, machine_uuid) ordered by first_seen and
emits on each transition, with anomaly_key =
`identity:account_switch:<tool>:<machine_uuid>:<from>:<to>:<first_seen_bucket>` anchored on the
observed session's UTC bucket and never on detection time, so re-running collect cannot produce a
second incident; the detail quotes both literal values.

**In the app** — Incident feed entry 'Codex switched from team to free on this Mac'; the People
row for that principal shows both classes with their dates.

**Source** — session_identity rows built from rollout rate_limits.plan_type, Claude bridge-session
ownerAccountUuid/ownerOrganizationUuid, ~/.grok/auth.json principal_id and team_id.

**Limit** — For any tool classified from an ambient config snapshot rather than a session line,
the switch can only be dated to 'between two collection passes', and a switch that happened and
reverted between passes is invisible. It cannot distinguish a deliberate account change from a
token refresh that returned different plan metadata.

### 37. principal_conflict guard (shared laptops, CI runners, sudo)

`Identity` · `Platform` · **S** · exact · 3/5

An info-severity rule over the principals map: one machine_uuid observed under more than one OS
username, or one OS username observed under more than one machine_uuid, within the same range.
Both shapes break per-employee reporting silently today — a shared laptop attributes a second
person's spend to the first, and a CI runner or an sudo invocation creates a phantom principal.
anomaly_key = `identity:principal_conflict:<machine_uuid|user>:<sorted peers>:<utc_day>`;

**In the app** — A banner at the top of the People view — 'two OS accounts seen on this Mac; per-
person figures are held back' — listing the conflicting values, plus an info entry in the incident
feed.

**Source** — usage_events.user and .machine (a single pair here: shiva / Marys-MacBook-Pro.local
across all 29,293 live rows) joined to the machines and principals tables.

**Limit** — It cannot tell a genuinely shared laptop from one whose OS account was renamed, nor a
CI runner from a human, without the principal being declared. It sees only usernames Vole itself
ran under — an agent run by another OS user writes to a home directory Vole never reads, so that
person is absent rather than conflicting.

### 38. Account class on shadow surfaces that have no collector

`Identity` · `DPO` · **M** · partial · 3/5

Applies the same classifier to the surfaces in the discovery registry that Vole has no collector
for — the agents a company never provided — by adding account_class and class_evidence columns to
the ai_surfaces row, resolved from opaque identifiers only and defaulting to unknown rather than a
guess. ~/.copilot/config.json (present here) dates the surface via firstLaunchAt but carries no
plan; ~/.claude.json oauthAccount answers org-vs-personal for Claude-family surfaces without
touching emailAddress, fullName, displayName or organizationName.

**In the app** — An 'Account' column in the AI Surfaces grid showing the class chip (Org /
Personal / API key / Unknown); hovering names the file and field that decided it, never the
organisation name.

**Source** — ~/.claude.json oauthAccount.{organizationUuid, organizationType, seatTier,
billingType, organizationRole}; ~/.copilot/config.json firstLaunchAt;

**Limit** — Personal-vs-org for Copilot, Antigravity/Gemini and Kiro is not determinable from
local files at all and stays unknown rather than being guessed — ~/.copilot here holds only
config.json, ide/ and logs/, with no session-state directory, so the CLI has never run.

*Extends the earlier entry "Identity binding: user, org, seat and device (shadow_account)".*

### 39. surface_principal: attributing a surface that has no session, and saying how weakly

`Identity` · `DPO` · **S** · partial · unscored

Every artifact behind a homegrown surface has a filesystem owner and an mtime, and a repo has a
git identity - that is the only attribution available when there is no session to bind to. Each
inventory row records the owning uid, the file mtime as evidence_ts, and, for repo-scoped rows,
the repo .git/config user.email domain plus the HMAC of the address under the existing identity
rules, with the address itself never stored. This introduces one new binding_evidence rank,
'file_owner', placed deliberately below every session-derived rank in the existing
session_identity ladder, so a homegrown surface can never outrank a real session in the principal
resolution chain.

**In the app** — People view gains a 'surfaces with no session' count per principal, greyed and
footnoted with its binding rank.

**Source** — stat(2) uid and mtime on every cited manifest, plist, config and env file; repo
.git/config user.email (domain + HMAC only)

**Limit** — File ownership is not authorship: a cloned repo carries a teammate's committer
identity, CI and sudo write files as other uids, a shared laptop collapses everyone into one
account, and on a single-user Mac every row resolves to the same uid, which makes the signal
endpoint-level and nothing more.

### 40. browser_identity: the account the browser is signed into, and whether AI threads sync out of it

`Identity` · `DPO` · **M** · exact · unscored

The account-class classifier resolves an agent's auth path, but a browser has no auth path, so
every non-engineer seat currently resolves to nothing. Read Local State ->
profile.info_cache.<dir>.{hosted_domain, user_name, gaia_id, is_ephemeral} (verified hosted_domain
= "NO_HOSTED_DOMAIN", i.e. a consumer Google account, on a machine that also runs corporate
repos), signin.active_accounts_managed (false here) and management.platform.enterprise_mdm_mac (0
— the browser is not MDM-enrolled);

**In the app** — People view gains a browser row per seat showing account class, sync datatypes
selected and a coverage denominator; Privacy Center's path receipts list the three pref keys read
and show that only the domain and an HMAC were kept, with the raw address never entering the
store.

**Source** — ~/Library/Application Support/<Chromium root>/Local State ->
profile.info_cache.<dir>.{hosted_domain,user_name,gaia_id,is_ephemeral},
signin.active_accounts_managed, management.platform.enterprise_mdm_mac;

**Limit** — Chrome's account state is per-profile and stale between flushes. A signed-out profile
yields account_class 'unknown', never 'consumer'.

*Extends the earlier entry "Account-class classifier from the auth path".*

### 41. What per-employee attribution cannot establish, regenerated from the store

`Identity` · `Procurement` · **M** · exact · 4/5

A shipped, enumerated and falsifiable statement of the limits of local attribution, generated from
this machine's own counts rather than written as a disclaimer: there is no proof the OS user is
the human at the keyboard; no SSO principal exists anywhere on disk; a Bedrock/Vertex session's
IAM identity never appears in a transcript;

**In the app** — Settings → Privacy → 'What Vole cannot know', linked from the People view's
coverage strip and from every account-class badge tooltip.

**Source** — Counts computed from ~/.vole/vole.db (session_identity, usage_events) and the
artifact trees named; regenerated by a script wired into CI.

**Limit** — Correct only for the tools and versions Vole parses today — agent log formats are
explicitly internal and version-unstable, so without the regeneration step this becomes the
nineteenth stale claim. It is a statement about attribution, not about coverage;

### 42. vole whoami and the vole_identity MCP tool

`Identity` · `Platform` · **S** · exact · 2/5

The smallest surface that makes the whole lens testable: `vole whoami` prints the resolved
principal and its source, machine_uuid plus current hostname, and one line per tool giving
account_class, plan, truncated org id, binding_evidence and the artifact path that decided it. The
same read model is exposed as an eighth MCP tool `vole_identity` beside the existing seven in
cli/mcp.ts, so an analyst's own agent session can ask 'which account is this machine using for
Codex' without a console. Both honour the policy gate: on a multi-principal store they return only
the caller's own principal unless people_view is granted.

**In the app** — Not an app screen: it is the CLI and MCP mirror of Settings → Identity, and the
support path when the app shows an unexpected account badge.

**Source** — principals, machines and session_identity, served through queries.ts like every other
read model.

**Limit** — MCP exposure means an agent can read the identity table, so the tool must return
truncated ids and must never expose auth_shape rows; and like every MCP tool here it runs with
includeSeed=false and with no authentication beyond the stdio transport, so it inherits whatever
trust the client has.


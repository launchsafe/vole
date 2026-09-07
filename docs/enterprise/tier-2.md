# Tier 2 — Shadow AI census: every AI surface on this machine, provisioned or not

[← Enterprise roadmap index](../ENTERPRISE-ROADMAP.md) · 52 features

This is the reason the product exists and it comes second only because it needs a launchable
binary and a scanner lane, not because it needs any of the existing pipeline. Surface discovery is
structurally independent of usage_events, of identity and of the tool ledger: it is a bounded
filesystem, launchd, bundle and config scan into `ai_surfaces`, and it produces the single demo
that closes a first meeting — open Vole on a real developer's laptop and see the AI surfaces
nobody provisioned. On this machine that is not hypothetical: three LaunchAgents
(`com.local.gemini-gateway-for-claude`, `com.example.gemini-proxy-for-claude`, `com.example.litellm`)
are silently rerouting a sanctioned agent's traffic to unsanctioned models, and no gateway, EDR or
vendor console in the 62-vendor matrix would report it. The tier covers installed-app census by
bundle id and signing Team ID, ghost apps that ran and were deleted, AI CLI and package-manager
inventory, local model runtimes with the exposed-bind rule, browser extension reach and AI-host
visit counts, IDE extension census across three readers, MCP registrations, multi-root agent homes
and redirects, and the rerouted-model detector read straight from the model column. Two
disciplines make it credible rather than a wall of guesses: an evidence ladder so a surface with
inventory but no telemetry can never be misread as spend (`verify --surfaces` is the firewall
between inventory and usage), and a `surfaces.json` sanctioned declaration so `new_ai_surface` and
`unsanctioned_surface_first_seen` fire against an admin's list instead of our opinion. It is
device-scoped, so it ships before identity — 'this laptop runs three unprovisioned AI gateways' is
already a sellable sentence.

Legend: `category` · `buyer` · effort **S**/**M**/**L**/**XL** · feasibility (*exact* =
readable from local data today, *partial*, *new instr.* = needs something written that does
not exist, *network* = crosses the network line) · value 1–5, 5 meaning a security lead blocks
the rollout without it. `unscored` came from a completeness sweep and skipped the verifier.

---

### 1. ai_surfaces registry (the shadow-AI spine)

`Shadow AI` · `CISO` · **L** · exact · 5/5

One table `ai_surfaces(surface_key UNIQUE, kind, vendor, name, identifier, version, path,
evidence_kind, state, first_seen, last_seen, scanner, confidence, source)` that every scanner in
this category writes through, mirroring `db.ts:insertEvents`: `INSERT ... ON CONFLICT(surface_key)
DO UPDATE SET last_seen=max(...), version=coalesce(excluded.version, version)`. `kind` is
app|cli|extension|runtime|gateway|browser_host|config_dir|mcp_client|residue|store;

**In the app** — New Dashboard sidebar section 'AI Surfaces'. Header line: 'N surfaces found · M
produce exact rows · K activity-only · J present but unparsed', each number clicking through to
the filtered grid.

**Source** — Written by every scanner in this category; table lives in ~/.vole/vole.db beside
usage_events.

**Limit** — A surface row proves an artifact exists on disk, a socket was listening at a moment,
or a log line was written — never that a human used the tool, and never a token or a dollar.
first_seen is the first Vole scan that saw it, not the install date, and the column must be
labelled 'first seen by Vole'.

### 2. Unsanctioned-agent rule against an admin allowlist

`Governance` · `CISO` · **M** · exact · 5/5

A pure rule that fires warn when an ai_surfaces row's surface_key is absent from allowed_surfaces
(a list of globs) in the admin-owned policy file — /Library/Application Support/Vole/policy.json
merged over ~/.vole/policy.json, the same override precedence pricing.json already uses.
anomaly_key is 'unsanctioned:' + surface_key + ':' + policy_sha256, so re-evaluating after a
policy change produces a new, explainable incident instead of being swallowed by INSERT OR IGNORE.
observed = 1, threshold = 0, baseline NULL, and the detail quotes both the evidence path and the
literal policy clause that failed.

**In the app** — Incident feed row 'Unsanctioned agent: com.electron.ollama — not in
allowed_surfaces (policy 3f9a…)'; a sanctioned/unsanctioned chip on every row of the AI Surfaces
grid, replaced by a 'no policy loaded' strip when the file is absent.

**Source** — ai_surfaces rows; allowed_surfaces in /Library/Application Support/Vole/policy.json
and ~/.vole/policy.json.

**Limit** — With no policy file present the rule is inert and must stay inert — 'unsanctioned' is
a company decision, not a technical fact, and shipping a default allowlist would make Vole's
opinion look like evidence. It cannot prove the tool was used with company data, only that its
artifacts exist on this Mac.

*Extends the earlier entry "Policy-as-code file with local enforcement, drift report and
vole_policy check".*

### 3. Shadow AI screen

`Desktop` · `CISO` · **L** · new instr. · 5/5

One sidebar destination that makes the whole shadow-AI lens legible in ten seconds: a headline
count ('14 AI surfaces on this Mac — 9 sanctioned, 3 unsanctioned, 2 unknown'), the AI Surfaces
grid with kind and status chips, a 'New this week' strip driven by first_seen, the local-runtime
and gateway cards (the two that mean an admin should act today), the browser Web AI panel and the
coverage footer pinned beneath so an empty result can never be read as 'clean'. It needs
getAiSurfaces(range, includeSeed) in queries.ts and its DB.swift twin, since under the read-model
parity constraint an unported query cannot be shown at all.

**In the app** — A 'Shadow AI' section in the Monitor group of the sidebar; row click opens a
drill-down sheet with evidence_kind, the literal path, first and last seen, and any incidents
keyed to that surface;

**Source** — ai_surfaces rows via a new queries.ts getAiSurfaces plus a DB.swift port; anomalies
rows for new_ai_surface / unsanctioned_agent / ai_gateway_persistent / local_model_server_exposed
/ ai_binary_unsigned.

**Limit** — The status chips are only as good as the policy file behind them: with no policy every
surface is 'Unknown' and the headline must say so rather than defaulting to sanctioned or
unsanctioned. Counts are per-machine and the screen must not imply a fleet.

*Extends the earlier entry "Shadow agent surface: Claude Desktop scratch sessions and non-
engineering accounts".*

### 4. model_routes: resolving the local gateway's alias map, and the two rules it exposes

`Data exposure` · `CISO` · **M** · exact · unscored

Read the config file the gateway job's own ProgramArguments names (--config <path> for LiteLLM;
also ~/.config/litellm/*.yaml, Claude Code Router's config, ~/.continue/config.json,
~/.aider.conf.yml) and extract the routing map only: model_list[].model_name ->
litellm_params.model, the api_base host and scheme, and the presence (never the value) of api_key.

**In the app** — A 'Route' chip beside every model name in Breakdown, Sessions and Leak Ledger
whenever v_events_route resolves an alias - 'claude-sonnet-5 -> qwen3.8-27b-heretic @
89.169.113.254 (http)' - with a red transport badge on plaintext or bare-IP upstreams.

**Source** — ~/.config/litellm/*.yaml (model_list[].model_name, litellm_params.model, api_base,
api_key presence), Claude Code Router config, ~/.continue/config.json, ~/.aider.conf.yml; the
--config path taken from the launchd job's ProgramArguments

**Limit** — The map is what the config says, not what the proxy did: a running gateway may hold an
older config in memory, route by wildcard, or fall back per request, and Vole never sees a
request. It cannot confirm that a single prompt crossed that host, only that the local
configuration would have sent it there.

*Extends the earlier entry "Rerouted-model detector straight from the model column, with CCR hex
decode".*

### 5. languageModelStats: exact tokens per extension per model, counted by the editor itself

`FinOps` · `FinOps` · **M** · exact · unscored

The brief's stated honest limit — 'installed is not proof it ran' — is dissolved by a file VS Code
already writes. In the Settings Sync global-state blob, key languageModelStats.<model> carries
value {"extensions":[{"extensionId":"GitHub.copilot-
chat","requestCount":6,"tokenCount":66383,"participants":[]}]} and key languageModelAccess.<model>
carries the list of extension ids GRANTED that model. Both verified present here for
claude-3.5-sonnet.

**In the app** — Costs screen gains an 'IDE extensions' block listing (extension, model, requests,
tokens) with an em dash in the cost column and the unpriced-rows count beside the total; the
People view shows IDE-extension tokens as a separate, explicitly unpriced bar so it can never be
silently added to a dollar figure.

**Source** — ~/Library/Application Support/Code/User/sync/globalState/lastSyncglobalState.json and
its dated siblings — storage['languageModelStats.<model>'].value and
storage['languageModelAccess.<model>'].value;

**Limit** — tokenCount is a single undifferentiated total with no input/output/cache-read/cache-
write split, so cost is NOT computable — input_tokens, output_tokens and cost_usd are NULL and
computeCost is never called; every aggregate carries these rows in its unpriced count and the UI
renders an em dash, never $0.00.

### 6. Per-workspace activation: which repositories each IDE agent actually opened in

`Behaviour` · `CISO` · **M** · exact · unscored

This is the answer to 'installed, never observed running', and it comes with a repo list. Each
editor keeps <App Support>/<Editor>/User/workspaceStorage/<hash>/ with workspace.json naming the
folder URI and state.vscdb whose ItemTable holds the keys extensions wrote in THAT workspace.
Measured on this machine: 76 workspaces;

**In the app** — Selecting an extension on the Shadow AI screen opens a reach panel: the list of
repositories it activated in, each with the state.vscdb mtime as its 'not after' date,
corporate/personal classification from policy, and a jump into the Blast Radius screen;

**Source** — ~/Library/Application
Support/Code/User/workspaceStorage/<hash>/{workspace.json,state.vscdb} — workspace.json.folder
(e.g.

**Limit** — Workspace state proves a view container was materialized in that workspace — the
extension activated — not that a prompt was sent or a token spent; only the
terminalChat.toolSessionMappings rows carry a count, and that count is of tool sessions the
terminal chat mapped, not of every tool call.

### 7. agent_home_roots: editor roots and profiles as a resolved dimension, by marker not by name list

`Platform` · `CISO` · **M** · exact · unscored

paths.ts resolves exactly one home and no editor roots at all. Add a resolver that readdirs
~/Library/Application Support and keeps every directory where User/globalStorage/storage.json
exists — a marker test, so a fork nobody has heard of still resolves. On this machine that yields
exactly 4 (Code, Cursor, Kiro, 'Antigravity IDE') and correctly rejects 2 lookalikes ('ZCode',
'Antigravity', no marker).

**In the app** — A Roots band on Posture and a term on the Coverage strip: '4 editor roots, 5
profiles, 3 readable' with the unreadable ones named; root and profile become filter chips on
Shadow AI and People so a session can be traced to the editor install it ran in.

**Source** — ~/Library/Application Support/*/User/globalStorage/storage.json (marker; keys
userDataProfiles, profileAssociations.workspaces, telemetry.devDeviceId/machineId/sqmId),
~/Library/Application Support/*/User/profiles/<id>/globalStorage/

**Limit** — A root launched with --user-data-dir elsewhere, a portable install, or a profile
folder deleted while still listed in storage.json leaves no marker and is invisible. The figure is
roots Vole could see and must always print with that denominator, never as 'all editors'.

*Extends the earlier entry "Multi-root agent-home census (paths.ts resolves exactly one home)".*

### 8. os_intelligence: the AI wired into macOS, and the MDM key that was supposed to stop it

`Posture` · `Platform` · **S** · exact · unscored

Nobody proposed OS-level AI, even though it is MDM-controlled and defaults-readable — and it is
the only AI surface on a seat that never opens a terminal. Read the plists directly:
com.apple.generativepartnerservicesettings -> AllLLMUISettings.<partner>.{enablementCount,
unavailable} (verified here: com.apple.openai.chatgpt = {enablementCount 0, unavailable 1}) and
gatMigrationComplete2; com.apple.CloudSubscriptionFeatures.optIn -> {opted_out_buddy,
opted_change_os_version "26.4.0"};

**In the app** — Posture screen gains an OS band showing per-partner enablement, the on-device
model asset state, and the MDM payload that governs it (or 'no payload applied'); the Shadow AI
screen shows the OS row for seats that run no agent at all, on the evidence ladder's bottom rung.

**Source** — defaults domains as plists: com.apple.generativepartnerservicesettings
(AllLLMUISettings.<partner>.{enablementCount,unavailable}, gatMigrationComplete2),
com.apple.CloudSubscriptionFeatures.optIn, com.apple.appleintelligencereporting;
/System/Library/AssetsV2/com_apple_MobileAsset_UAF_FM_GenerativeModels;

**Limit** — These keys record enablement and availability, never prompts: Apple writes no per-
request record any user-space reader can see, so tokens, cost and content are structurally NULL
forever and the row can never be misread as spend. unavailable: 1 may mean region, account tier or
hardware and Vole does not guess which — it reports the flag.

### 9. AI gateway persistence inventory (LaunchAgents and LaunchDaemons)

`Shadow AI` · `CISO` · **S** · exact · 5/5

Parse every plist under `~/Library/LaunchAgents`, `/Library/LaunchAgents` and
`/Library/LaunchDaemons` for `Label`, `ProgramArguments`, `RunAtLoad`, `KeepAlive` and the
Std*Path log targets, then match argv basenames against a gateway catalog (litellm, claude-code-
router/ccr, bifrost, portkey, helicone, openllm, vllm, ollama, lmstudio, jan, mitmproxy). Each hit
writes an `ai_surfaces` row kind=gateway plus rule `ai_gateway_persistent`.

**In the app** — AI Surfaces grid, kind chip 'Gateway': Label, port from argv, and
RunAtLoad/KeepAlive as two flags. An amber incident `ai_gateway_persistent` quoting the literal
ProgramArguments line.

**Source** — ~/Library/LaunchAgents/*.plist, /Library/LaunchAgents, /Library/LaunchDaemons: Label,
ProgramArguments, RunAtLoad, KeepAlive, StandardOutPath/StandardErrorPath.

**Limit** — A loaded LaunchAgent proves a process is configured to run, not that any agent was
ever pointed at it; binding a gateway to actual traffic needs the route-evidence and rerouted-
model features, and where both are absent this row stays informational.

### 10. vole assess --wedge: competitor-coverage annex computed on the buyer's own machine

`Governance` · `CISO` · **M** · new instr. · 3/5

Extend the assess report with the three facts a security buyer checks before a pilot, all computed
from their machine rather than asserted in a deck: which of their own agent surfaces each
incumbent category is documented to cover, read from a shipped, dated data/console_coverage.json
with one row per category (endpoint DLP, SASE proxy, agent gateway, LLM observability, vendor
console) and a URL plus read date per claim; the local row counts proving the uncovered cells are
non-empty; and the `verify --content` result line showing zero content matches in the very
database being shown.

**In the app** — A dashboard toolbar 'Assess' action that produces the report and reveals it in
Finder, with the same annex rendered inline on the Coverage screen so the demo and the document
are one artefact.

**Source** — usage_events, anomalies, agent_surfaces, posture_apps and coverage_gap rows; shipped
data/console_coverage.json with URL and read date per claim;

**Limit** — Competitor rows are dated readings of public documentation, so each is phrased 'as
documented on <date>' and never as 'vendor X cannot' — a vendor may have shipped coverage since,
and the annex invites the reader to check. The report describes one laptop;

*Extends the earlier entry "vole assess: retrospective assessment report from history already on
disk".*

### 11. Full Disk Access canary and the launch-context record

`Platform` · `CISO` · **S** · exact · unscored

There is exactly one bit that matters for buyer need #12's "honest reduced-functionality state
without FDA", and exactly one honest way to read it: `open('~/Library/Application
Support/com.apple.TCC/TCC.db', O_RDONLY)`, which succeeds only under
kTCCServiceSystemPolicyAllFiles. Confirmed here it returns EPERM (this shell has no FDA) while
~/Desktop, ~/Documents and ~/Downloads read fine — proving FDA and the per-category folder grants
are separate axes and that one cannot be inferred from the other. The probe opens the descriptor
and immediately closes it: no query is ever issued, so no TCC content is read, and the outcome
lands as a `scan_access` row with root='tcc_canary'.

**In the app** — Settings > Permissions gains one chip at the top: "Full Disk Access — granted /
not granted / not probed", with the launch context beside it and, when not granted, a button
opening `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles`
(falling back to the Privacy pane root — the URL scheme is unversioned Apple surface).

**Source** — ~/Library/Application Support/com.apple.TCC/TCC.db — open() outcome only, never
contents; process.ppid / process.getuid() / XPC_SERVICE_NAME for launch_context.

**Limit** — The canary answers "can this process read FDA-protected files right now", which is not
the same question as "the admin granted Vole FDA" — a PPPC profile, a grant inherited from a
responsible parent, or a stale grant on a different build can all produce `ok`. Vole cannot read
TCC.db's rows to explain the answer, and must not;

### 12. Evidence-ladder card: a surface with no telemetry that can never be misread as spend

`Desktop` · `CISO` · **S** · exact · unscored

One card design shared by every homegrown surface, whose only job is to make an inventory row
unmistakably not a usage row. Each surface renders a five-rung evidence ladder - dependency
resolved, provider key held, keychain or gateway-config binding, launchd persistence, matched
request lines - each rung either lit and clickable through to its path receipt, or greyed with the
reason it is dark. Sort order is evidence strength, never spend, because spend does not exist
here: the token, cost and session columns are structurally absent from this section rather than
rendered as zero, and the section header carries its own denominator, 'N surfaces found by
inventory;

**In the app** — Shadow AI screen gains a third section, 'No-log AI', beneath the enrolled agents
and the detected-but-unsanctioned apps. Each card expands to its ladder, its path receipts and the
incidents citing it (provider_key_without_sanctioned_surface,
sanctioned_name_unsanctioned_upstream, plaintext_model_transport).

**Source** — ai_surfaces, ai_dependencies, provider_keys, key_residency, model_routes,
surface_activity - read models only, no new collection

**Limit** — The ladder shows how much evidence Vole holds, not how much risk exists: five lit
rungs on a weekend side project outrank one lit rung on a service handling customer data, and the
product has no way to tell those apart. It ranks by evidence, never by exposure, and the card says
so in the place where a risk score would otherwise go.

### 13. site_capabilities: what a chat site was allowed to touch on this machine

`Data exposure` · `CISO` · **M** · exact · unscored

The existing browser feature stops at hostname visit counts, which cannot distinguish reading a
marketing page from handing an AI site the microphone and a directory picker. Chrome records every
persistent grant per origin in Default/Preferences -> profile.content_settings.exceptions.* (105
setting kinds present here); join those to the AI origins already registered in ai_surfaces.

**In the app** — Leak Ledger gains a Browser grants section beneath the at-rest findings: one row
per (origin, capability) citing the exact content-settings key and the pref file it came from,
with the picked directory shown as a path and a jump to the ai_surfaces row for that host.

**Source** — ~/Library/Application Support/Google/Chrome/Default/Preferences ->
profile.content_settings.exceptions.{media_stream_mic, media_stream_camera, clipboard,
file_system_access_chooser_data, file_system_last_picked_directory,
file_system_access_extended_permission, durable_storage, notifications,
permission_actions_history, site_engagement, media_engagement}

**Limit** — A grant is authority, not transfer: Vole cannot see whether any file was actually
uploaded, and chosen-objects is [] in the live state here, meaning nothing is currently persisted
— only that the picker was opened. Chrome prunes these entries on site-data clear, so absence
proves nothing.

*Extends the earlier entry "Browser AI-host visit census (hostname counts only, no extension, no
proxy)".*

### 14. Rerouted-model detector straight from the model column, with CCR hex decode

`Shadow AI` · `CISO` · **S** · exact · 5/5

v1's model-route item hunts config files, CCR backups and api_error bodies; the stored rows
already hold the proof. On this machine 2,540 `usage_events` rows carry `tool='claude_code'` with
a model id that is not Anthropic's — `qwen3.8-27b-fp8` (1,492 rows, 452M tokens), `glm-5.2` (564),
`fable-fusion-27b`, `gemini-3.7-flash`, `openrouter/stealth/ox-alpha`, `lfm2.5:latest` — plus 461
rows whose model is `anthropic/claude-ccr-h<hex>`, where the hex after the `h` is claude-code-
router's encoding of the true upstream (h7177656e2f… decodes to qwen/qwen3.8-27b-fp8, h6f70656e…
to openrouter/stealth/ox-alpha).

**In the app** — Breakdown shows a 'not first-party' badge per model row with the decoded upstream
printed underneath; Incidents gains one row per session;

**Source** — usage_events.model in ~/.vole/vole.db (counts verified by query);
packages/core/src/pricing.ts:75-96 rateFor/contextWindow;

**Limit** — The model string proves which model answered, not which host served it: a self-hosted
or proxied Anthropic-compatible endpoint returning `claude-sonnet-5` is indistinguishable from the
real thing here, and a NULL model (46 Codex, 789 Grok rows) can never be classified — report those
as 'unknown route', never as first-party.

*Corrects the earlier entry "Model-route integrity and allowlist (model_provider_rerouted,
model_switch, model_not_allowed)".*

### 15. Overview: security-first tile grid with no risk score

`Desktop` · `CISO` · **M** · partial · 4/5

The dashboard pane leads today with Tokens and Equivalent Cost (DashboardView.swift:388-400),
which is the right first screen for a cost monitor and the wrong one for a security buyer. Replace
the KPI form with six count tiles, each a plain COUNT or SUM over rows that exist and each a link
into its section with the matching filter pre-applied: people monitored on this host, agents
detected (n outside policy), open exposure findings, incidents by severity in 24h, posture
controls unknown, spend with its unpriced count beside it.

**In the app** — Overview: a 3x2 tile grid above the incident-annotated timeline; each tile shows
the figure, a one-line 'what this counts' caption ending in 'on this Mac', and a chevron that
navigates to the section with its filter applied.

**Source** — usage_events (COUNT DISTINCT user/machine, COUNT DISTINCT tool, COUNT cost_usd IS
NULL), anomalies severity counts, plus the enterprise tables when the capability probe finds them;
all in ~/.vole/vole.db today.

**Limit** — Counts on one laptop are not a fleet posture and the captions must say 'on this Mac'
until fleet sync exists.

### 16. scan_access: the attempted read is the only honest observable

`Platform` · `Platform` · **M** · exact · unscored

Every collector today guards with `existsSync(dir)` and on failure emits a note like devin.ts:36
`No Devin data at <dir>` — a sentence that is factually wrong for a permission denial, and that
nothing stores or renders (notes only reach `--verbose` stdout). Measured on this machine (macOS
26.6.2): `existsSync('~/Library/Safari')` returns **true** while `readdirSync` on it throws EPERM,
and `existsSync('~/Library/Safari/History.db')` returns true while `openSync` throws EPERM — TCC
denies at open/readdir and never at stat, so `existsSync` is not a permission oracle and cannot be
made into one.

**In the app** — Not a screen of its own — it is the join every other screen needs. Feeds the
Coverage strip and the Shadow AI screen (see the Readability matrix feature), and Settings >
Permissions lists the raw table: root, four-state pill, entries seen, errno, probe age.

**Source** — Attempted readdir/open on each of the 11 roots in paths.ts plus the ~15 discovery
roots the shadow-AI spine adds (~/Library/Safari/History.db, other apps' Application Support and
Group Containers, ~/Library/Logs/Claude, ~/Desktop, ~/Documents, ~/Downloads); errno from node:fs.

**Limit** — Reports the outcome of one attempt at one instant. It cannot say *why* — user denied,
never prompted, profile removed and re-signed binary are indistinguishable from the errno alone —
cannot enumerate its own grants, and a root readable at probe time can be denied 200ms later.

*Corrects the earlier entry "Honest coverage: per-collector heartbeat, four source states and a
coverage strip".*

### 17. Installed AI app census by bundle id and signing Team ID

`Shadow AI` · `CISO` · **M** · exact · 5/5

Walk /Applications, /Applications/Utilities, ~/Applications and ~/Downloads (depth 1, *.app only),
read `CFBundleIdentifier` / `CFBundleShortVersionString` / `CFBundleExecutable` from
`Contents/Info.plist`, read `TeamIdentifier` and the Authority line from a spawned `codesign -dv`,
and match against a shipped `data/ai-apps.json` catalog of bundle ids and Team IDs derived from
the 22 market profiles.

**In the app** — AI Surfaces grid, kind chip 'App'; the row prints the bundle id under the display
name so an admin sees com.openai.codex where Finder says ChatGPT, with the vendor column driven by
Team ID.

**Source** — /Applications/*.app/Contents/Info.plist CFBundleIdentifier +
CFBundleShortVersionString; `codesign -dv` TeamIdentifier/Authority (node:child_process, a node:
builtin, so SEA-safe);

**Limit** — Presence is not use: an installed app with no data-directory writes proves only that
it exists, and nothing here says what was typed into it, which account it used, or what it spent.
Only the scanned directories are seen — an app run from a DMG, from ~/Desktop, or a per-project
Electron build is missed, as is a browser PWA.

### 18. Menu bar as the security surface: six honest states and two security counts

`Desktop` · `CISO` · **L** · new instr. · 4/5

MenuBarLabel (VoleApp.swift:95-130) has two states — glyph tinted by liveSeverity and a token
count — and MenuPanel.swift:150-240 shows tokens, cost, a sparkline and the top five tools with no
incident or posture information whatsoever, which makes the always-visible surface the product's
biggest unused asset.

**In the app** — Menu bar: glyph plus optional figure with a distinct variant per state.

**Source** — Store.collectorStatus (Store.swift:132-140), Store.liveSeverity, ~/.vole/consent.json
presence, per-source readability probe over paths.ts; posture_apps / agent_surfaces /
account_class columns and policy.json sanctioned lists when present;

**Limit** — The menu bar carries an icon and a few characters, so the state is a summary and the
panel is where the reason lives; the counts are of what Vole observed on this one host in the
selected range, not a fleet position, and there is deliberately no composite score.

### 19. pnpm verify --surfaces: the firewall between inventory and usage

`Platform` · `Platform` · **S** · exact · unscored

A verify section that asserts the invariants this entire gap depends on, and fails the run when
one breaks. (a) No row in ai_dependencies, provider_keys, key_residency, model_routes,
surface_activity or history_sightings shares an event_key prefix with, or has ever produced, a
usage_events row - the cross-reference count must be zero. (b) Every surface_activity counter is
monotone against its stored predecessor and every scan cursor is <= the current file size, so a
rotated log resets instead of double-counting.

**In the app** — Settings -> Verification replaces the hard-coded 'Every stored row reconciled'
string with the last run's real per-section results including the surfaces section and its five
assertion outcomes; a failed assertion renders as a red row naming the offending table and column.

**Source** — the inventory tables themselves, their scan cursors, and the shipped DLP detector
pack

**Limit** — Verify proves the inventory never contaminated usage and never stored a value; it
cannot prove the inventory is complete.

### 20. AI CLI and package-manager inventory (PATH, npm global, pipx, Caskroom)

`Shadow AI` · `CISO` · **S** · exact · 4/5

Agents installed by a package manager have no .app bundle and often no dot-directory until first
run, so they are invisible to both the app census and the store prober. List (never execute) the
entries of `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`,
`/opt/homebrew/lib/node_modules`, `~/.npm-global/lib/node_modules`, `~/.local/pipx/venvs` and
`/opt/homebrew/Caskroom`, match basenames against the catalog, and write `ai_surfaces` rows
kind=cli with the install root as evidence and an 'installed via' class (npm/pipx/brew/manual).
Where the manager records a version — `<pkg>/package.json` version, the pipx venv metadata — read
it;

**In the app** — AI Surfaces rows kind=CLI grouped by install root, with the 'installed via' chip
and the version where readable, and a 'never launched' marker when no matching dot-directory,
store or log exists — separating 'installed' from 'has run' explicitly rather than implying use.

**Source** — Directory listings of ~/.local/bin, /opt/homebrew/bin, /usr/local/bin,
/opt/homebrew/lib/node_modules, ~/.local/pipx/venvs, /opt/homebrew/Caskroom; <pkg>/package.json
`version` for npm entries.

**Limit** — This is filename matching against a catalog: a locally built or renamed binary
(`~/bin/x`) is invisible, and a name collision produces a false positive that only the evidence
path lets an admin dismiss.

### 21. Notification coalescing, auditable per-rule mute and quiet hours

`Desktop` · `Developer` · **M** · partial · 3/5

Store.notifyFreshIncidents (Store.swift:151-176) posts one notification per new warn/critical
incident behind a 15-minute freshness gate and a monotonic id high-water mark. At the real rate on
this machine — 249 live incidents, 190 of them burn_rate_spike — that is a spam generator and the
fastest route to the user quitting the app, which makes shadow AI invisible again. Coalesce by
(rule, session) inside a window into one notification with an 'and N more' body, add quiet hours
and a per-rule mute, and make a mute write an auditable info-severity suppression row rather than
silently dropping, so an auditor can see what was hidden and by whom.

**In the app** — Grouped notifications; an Incidents toolbar 'Notifications' popover listing each
rule with its 24h fire count, a mute toggle and quiet-hours pickers;

**Source** — Store.swift:151 notifyFreshIncidents and the vole.lastNotifiedIncidentID UserDefaults
key; anomalies.anomaly_key/rule/session_id/severity/window_end;

**Limit** — Coalescing hides the individual arrival time of the merged incidents in the
notification banner even though the rows keep it; and because verdicts are frozen at first sight
by INSERT OR IGNORE (db.ts:137), a warn that later becomes critical never re-notifies until the
anomaly upsert and a re-notify path land.

*Extends the earlier entry "Incident noise controls: window chaining, per-session cap, info
rollup".*

### 22. coverage_degraded: a root that was readable and stopped being

`Platform` · `CISO` · **S** · exact · unscored

The dangerous failure is not "never had access" — that is loud on day one — it is a root that was
readable for six months and silently stopped, which is what a re-signed build, a removed PPPC
profile or a macOS upgrade produces. `scan_access` therefore keeps `last_ok_ts`, `last_ok_entries`
and `last_result` per root rather than only the current state, and a rule fires on the `ok →
eperm` transition only (never `ok → enoent`, since an uninstalled tool is not a degradation).
`anomaly_key = 'access:' || root || ':' || build_id || ':' || <UTC day bucket of first denial>` —
deterministic, no now(), so the existing INSERT OR IGNORE stays idempotent.

**In the app** — Appears in the existing incident feed with a distinct icon, and pins to the top
of Settings > Permissions until resolved. Severity is critical for a first-tier root (a
collector's own source path, so real spend is now invisible) and warn for a second-tier discovery
root.

**Source** — scan_access transition history joined to build_identity.cdhash.

**Limit** — It reports a transition and the two facts that bound the explanation (errno, cdhash
change); it cannot distinguish a revoked grant from a re-signed binary from a directory whose mode
changed for unrelated reasons.

### 23. Ghost-app detector: AI tools that ran here and were then deleted

`Shadow AI` · `CISO` · **S** · exact · 4/5

An uninstalled AI app leaves three residues macOS never cleans: `~/Library/Preferences/<bundle-
id>.plist`, `~/Library/Application Support/<name>/`, and dangling symlinks in /usr/local/bin and
/opt/homebrew/bin. Set-difference the residue bundle-id set against the installed bundle-id set
from the app census and emit `ai_surfaces` rows kind=residue, recording the plist mtime as
last_seen (the last preference write).

**In the app** — AI Surfaces grid, kind chip 'Residue', struck-through app icon, caption 'ran
here, no longer installed'; the drill-down lists every residue path found so a responder can
confirm or clean them, with the dangling symlink target shown literally.

**Source** — ~/Library/Preferences/*.plist filenames (bundle ids); ~/Library/Application Support/
directory names;

**Limit** — A preference plist proves the app launched at least once under this user; it does not
prove what was done with it, and mtime is the last preference write, not the last use.

### 24. Deleted agent sessions, proved by the stores that outlived them

`Platform` · `CISO` · **S** · exact · unscored

Three independent local records here name sessions that no longer exist. ~/.kiro/session-
index/<hash>.jsonl holds {'op':'remove','sessionPath':'<hash>/sess_<uuid>','at':<ms>} while that
session directory is now empty. Code/User/globalStorage/agent-host.db metadata holds
sessionTombstone:claude:/<uuid> rows alongside 104 live sessions(session_uri, provider,
start_time, external=1, registration_source='discovery', modified_time) — VS Code discovering and
hosting Claude Code's own sessions, which is also a double-count hazard the collector must dedupe
on the uuid.

**In the app** — Coverage strip gains a Deleted column per tool; each entry either jumps to the
surviving evidence or states plainly that no evidence remains, so a zero there is never read as
'nothing happened'.

**Source** — ~/.kiro/session-index/<hash>.jsonl (op add|remove, sessionPath, at); <editor
root>/User/globalStorage/agent-host.db metadata rows sessionTombstone:* and
sessionRegistryBackfilled:*;

**Limit** — A deletion is not misconduct — it is what 'clear chat' does in the vendor's own UI.
The record proves only that a session existed and stopped existing, never why, and never its
content.

*Corrects the earlier entry "Kiro collector (activity_only with autonomy flags)".*

### 25. Model-route rewrite evidence: rejected key labels, config backups, env names

`Shadow AI` · `CISO` · **S** · exact · 4/5

Three cheap reads that establish whether an agent's traffic was redirected, without ever reading a
secret value, ordered here by how much they actually deliver. (a) `~/.claude.json`
`customApiKeyResponses.{approved,rejected}` stores the short label of every custom API key the
user was prompted about — live here as `rejected: ["not-needed", "sk-litellm-local"]`, naming the
local gateway by label.

**In the app** — A 'Routing' card inside each agent's AI Surfaces drill-down: custom-key labels
offered with their approved/rejected verdict, a dated timeline of config-backup filenames, and the
env var names set with their value hostname — each leg rendering 'none found' rather than an empty
card.

**Source** — ~/.claude.json customApiKeyResponses.approved/rejected; ~/.claude/settings.json.ccr-*
filenames and mtimes;

**Limit** — Leg (c) is the weakest and must not be sold as the mechanism: the rc scan returns zero
matching exports on this machine even though a gateway demonstrably rewrote the config, because
the redirection lived in settings.json and launchd, not in a shell profile.

*Extends the earlier entry "Model-route integrity and allowlist (model_provider_rerouted,
model_switch, model_not_allowed)".*

### 26. Permission preflight in the app, and proof the grant reached the collector

`Platform` · `Developer` · **M** · partial · unscored

`apps/mac/Info.plist` carries zero usage-description keys, so every TCC prompt Vole will ever
raise shows a bare system string with no stated purpose — the worst possible first impression for
a tool asking a developer for their whole disk, and a works-council problem downstream.

**In the app** — A first-run Permissions sheet listing each root with its purpose sentence and a
live four-state pill that flips as the user answers, plus a Re-check button;

**Source** — apps/mac/Info.plist usage-description keys; paired app-side and collector-side
scan_access rows distinguished by launch_context.

**Limit** — A preflight can only ask. A denied category stays denied until the user changes it in
System Settings;

### 27. Copilot CLI collector: exact tokens from session.shutdown modelMetrics

`Platform` · `Eng mgr` · **M** · new instr. · 5/5

GitHub Copilot CLI writes ~/.copilot/session-state/<id>/events.jsonl, whose session.shutdown event
carries modelMetrics per model with input, output, cacheRead, cacheWrite and reasoning counts —
the same five components usage_events already stores, so rows land confidence='exact' and get a
real cost_usd once a rate exists. Key each row copilot:<session-id>:<model> from the shutdown
event (never a line index or an mtime — the two existing idempotency violations in codex.ts:197
and antigravity.ts:63 are bugs, not precedents) and read tool.execution events for the tools
column.

**In the app** — Copilot becomes an eighth tool in Theme.swift Labels.order, Pal.series and the
breakdown/timeline stacks, with exact tokens and no 'no tokens' badge; its AI Surfaces row shows
firstLaunchAt, process-log count, IDE lock workspace and session count, and reads 'present, 0
sessions recorded' when session-state is empty.

**Source** — ~/.copilot/session-state/<id>/events.jsonl (session.shutdown.modelMetrics.*,
tool.execution); ~/.copilot/config.json firstLaunchAt;

**Limit** — session-state/ does not exist on this machine (only config.json, logs/ and ide/), so
the token path is unverified against a real file and must ship behind a per-version fixture with
an 'unverified format' chip; presence-without-usage is the correct display, never zero usage.

*Corrects the earlier entry "GitHub Copilot collector (VS Code agent mode exact output tokens; CLI
activity_only)".*

### 28. foreign_root_transcript: a cwd this filesystem cannot have

`Shadow AI` · `CISO` · **S** · exact · unscored

The cheapest proof that an agent ran somewhere else: classify every recorded working directory
against the set of path roots that can exist on this volume. Sources are already parsed today —
Claude Code transcript `cwd` (present on all 806 non-assistant lines sampled) and the
`~/.claude/projects/<dash-encoded-path>` directory names, `~/.claude.json` `projects` keys (23
here), `~/.claude/history.jsonl` `project`, Codex `session_meta.payload.cwd` and
`turn_context.payload.workspace_roots` (a real multi-root array here), OpenCode
`session.directory`/`path.root`, and `~/.claude/ide/*.lock` `workspaceFolders` plus its
`runningInWindows` flag.

**In the app** — Shadow AI screen gains a 'Ran elsewhere' section listing foreign-root sessions
with their root prefix, tool, first/last seen and the config dir that carried them; a `deleted`
count sits beside it in grey so the two are never read as the same thing.

**Source** — ~/.claude/projects/*/ (dash-encoded cwd) and transcript `cwd`; ~/.claude.json
`projects` keys;

**Limit** — A foreign root proves the run's filesystem, not the machine or the container: a
`~/.claude` copied from a Linux workstation, synced by Dropbox, or restored from a backup looks
byte-identical to a live bind mount, and Vole says 'foreign root' for all of them rather than
naming a container it cannot see.

### 29. Gemini CLI collector with prompts-logged-to-disk posture

`Platform` · `CISO` · **M** · new instr. · 4/5

Gemini CLI persists per-project conversations at ~/.gemini/tmp/<project_hash>/chats/*.json with
token usage and tool executions, plus logs.json and a settings.json whose telemetry.logPrompts
defaults to true. Emit one exact row per model turn keyed gemini_cli:<project_hash>:<chat-
id>:<turn-index>, taking model, input/output tokens and tool names verbatim, and record
telemetry.logPrompts and any telemetry.outfile path as a posture row: a Gemini CLI with logPrompts
on is writing full prompt text to a local file plus the vendor's collector, a DLP surface the
company almost certainly does not know exists.

**In the app** — Gemini CLI as a separate tool from Antigravity in the breakdown, timeline and
Labels.order; an amber 'prompts logged to disk' chip on its AI Surfaces row when
telemetry.logPrompts is true, with the outfile path and the managed-layer path in the drill-down.

**Source** — ~/.gemini/tmp/<project_hash>/chats/*.json; ~/.gemini/logs.json;

**Limit** — Gemini CLI deletes chats after 30 days, so totals carry that horizon and are never
presented as lifetime. On this machine ~/.gemini holds only antigravity/, antigravity-ide/ and
config/ — the CLI chats directory does not exist, so this collector produces zero rows here and
the correct display is 'not present', never zero usage.

*Related to the earlier entry "Vendor telemetry and upload posture report".*

### 30. Agent-home redirect, re-detected every pass (CLAUDE_CONFIG_DIR, CODEX_HOME)

`Shadow AI` · `CISO` · **M** · exact · unscored

Re-run root enumeration on every scanner-cadence pass instead of once at install, into
agent_roots(root_path, tool, first_seen, last_seen, discovered_by). Fire agent_home_moved on
either of two exact signals: a live session id from ~/.claude/sessions/<pid>.json whose transcript
exists under no known root, or an allowlisted env name resolving to a path outside every known
root. For a running agent the environment is directly readable — ps -E -p <pid> returned the full
3.6 KB environment of a same-uid Claude process on this machine, so CLAUDE_CONFIG_DIR, CODEX_HOME,
XDG_CONFIG_HOME and ANTHROPIC_BASE_URL are obtainable with no hook and no injection;

**In the app** — The Shadow AI screen gains a Roots panel listing every agent home with first/last
seen, how it was discovered, and a 'moved' badge. The incident card names the old root, the new
root or 'unknown', which sessions fell outside it, and the pass that noticed.

**Source** — ~/.claude/sessions/<pid>.json {pid, sessionId, cwd, startedAt, version, entrypoint}
(3 live files here); ~/.claude.json projects[].lastSessionId (23 project entries);

**Limit** — ps -E sees only processes alive at that instant and only same-uid ones — an agent that
ran under a redirected home and exited between passes leaves only an orphan-session trace, which
cannot say where it went. launchctl setenv and rc-file exports are found;

### 31. Multi-root agent-home census (paths.ts resolves exactly one home)

`Shadow AI` · `Platform` · **M** · partial · 4/5

`paths.ts:24` resolves every source under a single `home()` (`VOLE_HOME_OVERRIDE ?? homedir()`)
and hard-codes `~/.claude/projects`, so any agent pointed elsewhere is 100% invisible while the
app still reports 'live' — which is worse than reporting nothing. Replace `claudeCodeProjects()`
with `claudeCodeProjectRoots(): string[]` and add a general `homes(): {label, path, granted_by}[]`
enumerating: the defaults, `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` from the environment and from
the shell-rc scan, `~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig` and
`Agents/XcodeVersions/*/claude/`, any `extra_roots[]` in policy.json, and `/Users/*/.claude` by
stat only.

**In the app** — Settings → Sources gains a 'Config roots' list: each root, how it was found,
whether it is being read, its transcript count and last scan.

**Source** — packages/core/src/paths.ts:24; $CLAUDE_CONFIG_DIR, $CODEX_HOME;

**Limit** — Only roots that are well-known, exported in a scanned rc file, or admin-listed are
discoverable: a root set inline for one command (`CLAUDE_CONFIG_DIR=/tmp/x claude`) leaves no
trace and is permanently invisible, so this widens coverage without ever proving completeness.
Enumerating another POSIX user's home needs Full Disk Access and usually root;

*Corrects the earlier entry "Windows and Linux collector distribution / Agent runtime inventory
(agent SBOM)".*

### 32. BYOK agent collectors: Goose, Amp and Continue

`Platform` · `Platform` · **L** · new instr. · 3/5

Three agents that write exact per-request token ledgers to disk that no vendor console anywhere
reports, and that a gateway sees only if the developer happened to point them at one: Goose
(~/.local/share/goose/sessions/sessions.db, or the macOS Application Support path — messages, tool
calls, accumulated tokens per provider/model), Amp (~/.local/share/amp/threads/**/*.json with
input/output/cache tokens and credits, plus a managed layer at /Library/Application
Support/ampcode/managed-settings.json) and Continue (.continue/dev_data/*.jsonl with
tokensGenerated, chatInteraction and toolUsage events).

**In the app** — Three first-class tools everywhere the existing seven appear — Labels.order,
Pal.series, breakdown and timeline stacks — each carrying an 'unverified format' chip in Settings
→ Sources until pnpm verify has reconciled a real store on some machine.

**Source** — ~/.local/share/goose/sessions/sessions.db and ~/Library/Application
Support/goose/sessions/sessions.db; ~/.local/share/amp/threads/**/*.json;

**Limit** — None of the three exists on this machine (all five candidate paths checked and
absent), so all three parsers are written from vendor documentation and ccusage's reading and must
ship activity_only until pnpm verify reconciles a genuine file, switching to exact per tool.

### 33. Second-tier store prober: one module, ten tools

`Shadow AI` · `CISO` · **M** · exact · 4/5

Ten more agents leave local stores worth detecting but not worth ten collectors, so ship one
prober driven by a table of `(name, glob, id_field, kind)`: Goose
`~/.local/share/goose/sessions/sessions.db` and `~/.local/state/goose/logs/llm_request.*.jsonl`,
Amp `~/.local/share/amp/threads/**/*.json`, Continue `.continue/dev_data/*.jsonl`, Cline/Roo
`<editor>/User/globalStorage/saoudrizwan.claude-dev/tasks/<id>/`, Zed `~/Library/Application
Support/Zed/threads/threads.db`, Kiro `~/.kiro/sessions/<hash>/sess_*/session.json` and
`~/.kiro/session-index/<hash>.jsonl`, Copilot `~/.copilot/session-state/<id>/events.jsonl`, Aider
`.aider.chat.history.md` in repo roots already known from `usage_events.project`, LM Studio
`~/.lmstudio/conversations`, Jan `~/Library/Application Support/Jan/data/threads`.

**In the app** — AI Surfaces rows kind=cli/extension with a 'store' column reading '3 sessions, 42
MB, last write 2026-08-15'; these tools appear in the Breakdown only once they have produced
activity_only rows, always with the existing 'no tokens' badge.

**Source** — The ten store paths above. Verified present on this machine: ~/.kiro/sessions (two
workspace hashes) with ~/.kiro/session-index/*.jsonl, ~/.copilot/{config.json,ide,logs},
~/Library/Application Support/{Kiro, Zed?, Devin, Codex, Cursor}.

**Limit** — Presence, file counts and byte sizes are exact; token counts, models and costs are not
recoverable for most of these and stay NULL forever — Zed's thread columns are undocumented, Aider
records tokens only via opt-in analytics, Cline's usage blocks vary by version, Kiro's tokens are
unverified.

*Related to the earlier entry "Kiro collector (activity_only with autonomy flags)".*

### 34. Local model runtime census and the exposed-bind rule

`Shadow AI` · `CISO` · **M** · partial · 4/5

Three independent probes for on-device inference, stored as facts with which probe fired, because
any one alone lies. (a) Socket sample: one unprivileged `lsof -nP -iTCP -sTCP:LISTEN` per pass,
filtered to 11434 (Ollama), 1234 (LM Studio), 1337 (Jan), 4891 (GPT4All), 8000/8080 (vLLM,
llama.cpp, LocalAI) plus any port whose owning process matches the catalog, recording process, pid
and bind address. (b) Manifest probe: directory listings only of `~/.ollama/models/manifests/**`
(registry/namespace/model/tag path segments are the model inventory), `~/.lmstudio/models`, and
the `model` field of `~/Library/Application Support/Jan/data/threads/*/thread.json`.

**In the app** — AI Surfaces → 'Local models' card: runtime, port, bind address, models pulled,
last observed request, evidence_kind chip saying which of the three probes fired, a red 'exposed'
badge on any non-loopback bind, and a permanent 'no tokens recorded — this runtime does not log
per-request usage' badge instead of a zero.

**Source** — `lsof -nP -iTCP -sTCP:LISTEN`; ~/.ollama/models/manifests/** path segments;

**Limit** — This machine is the proof that the socket probe alone is worthless: nothing is
listening on 11434 right now and the manifests tree is empty (models pruned with the app), yet the
server logs show the runtime bound to 0.0.0.0 as recently as 2026-08-30 — so the correct row is
evidence_kind=log_line with last_seen from the log, not a live port, and the port evidence must
always be stamped 'sampled at <ts>', never read as 'was never used'.

### 35. Ollama activity rows from the runtime's own server log

`Shadow AI` · `CISO` · **M** · partial · 3/5

`~/.ollama/logs/server*.log` is a structured logfmt stream (`time= level= source= msg=`) recording
model loads and, when `OLLAMA_DEBUG_LOG_REQUESTS` is true, `[GIN]` request lines. Parse it
incrementally with the existing `util/jsonl.ts` byte-offset reader adapted to line-oriented
logfmt, and emit `usage_events` rows with `tool='ollama'`, `confidence='activity_only'`, every
token field and cost_usd NULL, `model` verbatim from the load line, and `event_key='ollama:<log-
file-inode>:<byte-offset>'` so re-reads are idempotent and no poll-time value enters the key.

**In the app** — Ollama becomes a first-class tool in the existing Breakdown and Timeline with the
same 'no tokens' badge Cursor carries today, and a per-model call count inside the AI Surfaces
runtime drill-down.

**Source** — ~/.ollama/logs/server-1..5.log model-load lines and `[GIN]` request lines;
~/.ollama/models/manifests for the model catalog;

**Limit** — Ollama logs no per-request token counts, so every row is activity_only forever — no
cost, no context pressure, no burn-rate or budget rule can ever apply, and the digest must print
'—'.

### 36. execution_contexts: where the work actually ran, and the count Vole could not read

`Shadow AI` · `CISO` · **M** · exact · unscored

One table enumerating every execution context this machine has evidence of, built from five local
reads and zero network calls: VS Code/Cursor `User/workspaceStorage/*/workspace.json` (76 entries
here, each a single `folder` URI), `User/globalStorage/storage.json` keys
`profileAssociations.workspaces`, `backupWorkspaces.folders` and `windowsState`, Cursor's
`User/globalStorage/state.vscdb` `ItemTable['history.recentlyOpenedPathsList']`, plus
`~/.ssh/config` Host aliases (4 here: b300, fuchsia-lark, air, h200), `~/.docker/config.json` +
`~/.docker/contexts/meta`, container-runtime install evidence (docker/colima/limactl/podman/orbctl
on PATH, Docker.app/OrbStack.app, `~/Library/Application Support/OrbStack`), and `~/.vscode-
server`/`~/.cursor-server` (this machine acting as somebody else's remote host).

**In the app** — A new Topology card on the Coverage strip: 'N execution contexts seen, M
unmonitored'. On the People view every per-person figure gains a subscript reading 'k of this
person's n recent workspaces were remote or containerised;

**Source** — ~/Library/Application Support/{Code,Cursor}/User/workspaceStorage/*/workspace.json
(`folder`); .../User/globalStorage/storage.json (`profileAssociations.workspaces`,
`backupWorkspaces.folders`, `windowsState.lastActiveWindow.folder`);

**Limit** — A workspace URI proves an editor window, not an agent run — Vole cannot know whether
Claude Code or Codex was ever launched in that remote workspace, and it never estimates its
tokens. An SSH Host alias proves configuration, not use.

*Extends the earlier entry "Coverage and denominators: what Vole did not read".*

### 37. ai_extensions census: three readers, because extensions.json is the smallest one

`Shadow AI` · `CISO` · **L** · exact · unscored

The brief's collector reads <root>/extensions/extensions.json and would miss the single most-
deployed AI extension on earth. Verified here: GitHub Copilot Chat 0.64.1 lives at
/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/copilot/package.json as a
BUILT-IN and appears in no extensions.json anywhere, yet it has a populated globalStorage and 227
chat turns on disk. So ai_extensions is a UNION of three readers per editor root: (1)
<root>/extensions/extensions.json for identifier.id, version, metadata.installedTimestamp,
metadata.source, metadata.publisherId, publisherDisplayName, isPreReleaseVersion, pinned, updated,
private, targetPlatform;

**In the app** — Shadow AI screen gains an Extensions band grouped by editor root, each root
headed by its own version/commit/quality chip and its gallery host; a built-in badge distinguishes
bundled from installed;

**Source** — ~/.vscode/extensions/extensions.json (9 rows here), ~/.antigravity-
ide/extensions/extensions.json (7 rows), ~/.cursor/extensions/extensions.json and
~/.kiro/extensions/extensions.json (both empty arrays); /Applications/Visual Studio
Code.app/Contents/Resources/app/extensions/*/package.json (81 built-ins incl.

**Limit** — extensions.json is the installer's record, not proof the extension ever ran; every row
starts at 'installed, never observed running' until feature 4 or 7 supplies evidence.

### 38. Ghost AI extensions: assistants that are gone from disk but not from the editor's memory

`Shadow AI` · `CISO` · **M** · exact · unscored

Uninstalling an extension removes its directory and its extensions.json row; it does not remove
the workbench state it contributed. Keys of the shape
workbench.view.extension.<viewContainerId>.state.hidden, memento/webviewView.<id>,
memento/<viewId> and chatStatusDashboard.contributedCollapsed.<id> persist in global state
indefinitely.

**In the app** — A Ghosts band on the Shadow AI screen, visually distinct from installed rows,
each entry showing the view-container id verbatim beside the resolved product name or an explicit
'unmapped container' chip, and the two backup timestamps that bound its existence.

**Source** — ~/Library/Application Support/Code/User/sync/globalState/*.json (11 dated files here,
115-130 keys each) and ~/Library/Application Support/Code/User/globalStorage/state.vscdb
ItemTable; same key shapes in each fork's own globalStorage/state.vscdb

**Limit** — A view-container id is not an extension id. Resolution comes from a shipped offline
map and an unmapped id renders as 'unmapped container: <id>' — never guessed, never keyword-
matched into a vendor name.

*Extends the earlier entry "Ghost-app detector: AI tools that ran here and were then deleted".*

### 39. Contribution-point classifier: what makes an extension an AI surface, with no name list

`Shadow AI` · `CISO` · **M** · partial · unscored

An allowlist of known AI publishers is obsolete the day it ships. VS Code makes extensions DECLARE
their AI surface in package.json contributes, and that declaration is vendor-neutral, machine-
readable and already on disk.

**In the app** — Each Extensions-band row carries capability pills (model-route, chat, tools, mcp-
provider, remote-host, untrusted-ok/limited/no); a Shadow AI filter 'declares a model route' lists
every extension that can inject a model into chat regardless of publisher;

**Source** — <root>/extensions/<id>-<version>/package.json and
<App>/Contents/Resources/app/extensions/*/package.json — fields
contributes.{languageModelChatProviders, chatParticipants, chatAgents, languageModelTools,
languageModelToolSets, mcpServerDefinitionProviders, chatSessions, chatSkills, chatPromptFiles},
capabilities.untrustedWorkspaces.supported, extensionKind, enabledApiProposals

**Limit** — A contribution point is a declaration of intent, not proof of runtime registration,
and it only catches PROVIDERS. An extension that merely CONSUMES the API — calls
vscode.lm.selectChatModels and ships your buffer to a model — needs no contribution point
whatsoever and is invisible to this reader.

### 40. Model routes chosen inside the sanctioned editor

`Shadow AI` · `CISO` · **M** · exact · unscored

The most interesting model a developer uses is often selected inside an approved IDE, from a
picker, and appears in no console anywhere. The editor records every one. From the Settings Sync
global-state blob: chatModelRecentlyUsed, chatModelPinned, chatModelVisibility,
chatModelPickerPreferences, chat.currentLanguageModel.{panel,editor,terminal,editing-session}
(plus the .<agent> and .isDefault variants), and chat.modelConfiguration.panel whose value is a
per-model map of reasoningEffort and contextSize.

**In the app** — A Models row on the Shadow AI screen listing every model id ever selected in an
IDE, grouped by provider prefix, each with the surface it was selected on, its account class, and
a warning chip where the prefix resolves to a local runtime or a provider with no sanctioned
surface;

**Source** — ~/Library/Application Support/Code/User/sync/globalState/lastSyncglobalState.json —
storage['chatModelRecentlyUsed'], ['chatModelPinned'], ['chatModelVisibility'],
['chat.modelConfiguration.panel'], ['chat.currentLanguageModel.*'];

**Limit** — A model id in a recently-used list proves selection, not that a request was sent, and
carries no timestamp, no count and no repository — the only usage figures for these ids come from
feature 4's languageModelStats, and the two lists do not fully overlap, so a selected model with
no counter renders as 'selected, usage unread' rather than as zero.

*Extends the earlier entry "Rerouted-model detector straight from the model column, with CCR hex
decode".*

### 41. browser_extensions: the reach ledger read from Secure Preferences, not the Extensions folder

`Shadow AI` · `CISO` · **M** · exact · unscored

Enumerate Chromium roots (~/Library/Application Support/{Google/Chrome,Chromium,Microsoft
Edge,BraveSoftware/Brave-Browser,Arc,Comet,Dia,Vivaldi}), take the profile list from `Local State`
-> profile.info_cache keys (only `Default` here), and read each profile's `Secure Preferences` ->
extensions.settings.<id>: the cached
manifest.{name,version,permissions,host_permissions,content_scripts}, `location` (int enum: 1
INTERNAL, 4 UNPACKED, 5 COMPONENT, 7/9 policy, 10 EXTERNAL_COMPONENT), `path`, `from_webstore`,
`was_installed_by_default`, `disable_reasons`, and the three that actually matter —
`active_permissions`, `granted_permissions`, `withholding_permissions`. This corrects the brief
twice.

**In the app** — Shadow AI screen gains a Browser band listing profile, extension, install source
(webstore / MDM policy / sideloaded-unpacked / component) and a granted-reach chip; the drill-down
shows declared vs granted permission lists side by side with the withheld rows greyed.

**Source** — ~/Library/Application Support/<Chromium root>/Local State (profile.info_cache);

**Limit** — Reach is authority, not exercise — this row can never say the extension ran on a page.
Secure Preferences is Chrome's HMAC-protected store;

### 42. browser_assistant: the browser vendor's own AI, with a real last-invoked date

`Shadow AI` · `CISO` · **S** · exact · unscored

The assistant that ships inside the browser is the AI surface a non-engineer actually uses, and it
navigates to no domain and installs no extension folder, so both hostname counts and folder walks
miss it.

**In the app** — Shadow AI screen, Browser band: one row per profile showing the assistant name, a
real last-used date instead of the word 'installed', the paid AI tier from ai_subscription_tier,
and an expandable list of the connectors it was offered.

**Source** — ~/Library/Application Support/Google/Chrome/Default/Preferences (glic,
in_product_help.new_badge.Glic*, contextual_cueing.zero_state_suggestions.supported_tools,
ntp.compose_button, account_values.sync.ai_subscription_tier,
account_values.sync.glic_rollout_eligibility);

**Limit** — last_invoked_time is the last time the assistant panel was opened, not a prompt count
— the row prints one date and never a call or token figure. used_count is an in-product-help badge
counter that saturates and is not usage.

### 43. Browser AI-host visit census (hostname counts only, no extension, no proxy)

`Shadow AI` · `CISO` · **M** · partial · 4/5

Opt-in and off by default. Open each Chromium-family `History` SQLite read-only
(`file:History?immutable=1`, which succeeds while the browser runs; fall back to copying History
and History-wal into ~/.vole/tmp so Vole's write scope stays inside ~/.vole) and run one aggregate
over `urls`: hostname, `SUM(visit_count)`, `MAX(last_visit_time)` grouped by host, filtered inside
the read loop to a shipped `data/ai-hosts.json` allowlist (chatgpt.com, claude.ai,
gemini.google.com, perplexity.ai, poe.com, copilot.microsoft.com, huggingface.co, x.ai,
mistral.ai, deepseek.com, together.ai, openrouter.ai).

**In the app** — AI Surfaces → 'Web AI' strip: one row per host with visit count, last-visit date
and a 30-day sparkline, plus a per-browser badge showing which profiles were readable. An explicit
'counts only — Vole reads no URL, title or page content' line rendered from the redaction
manifest, not hard-coded.

**Source** — ~/Library/Application Support/Google/Chrome/<profile>/History and the
Brave/Edge/Arc/Chromium equivalents, `urls` table columns url, visit_count, last_visit_time;
~/Library/Safari/History.db behind Full Disk Access.

**Limit** — A visit count is an adoption signal and nothing else: it is not a conversation count,
not a volume, and not a leak measurement — a ChatGPT tab left open all day counts once, and what
was pasted into it is unknowable from here and must be stated as such. Incognito, guest and
private profiles write no row.

### 44. Repo-only agents: Aider's footprint and Continue's repo-side dev_data

`Shadow AI` · `CISO` · **M** · exact · unscored

Two agents are structurally invisible to a home-rooted collector: Aider writes nothing under $HOME
at all, only .aider.chat.history.md, .aider.input.history, .aider.model.metadata.json and
.aider.tags.cache.v*/ in the repo root plus an optional --llm-history-file, and Continue's per-
project dev_data JSONL sits at <root>/.continue/dev_data even where the covered BYOK collector
reads ~/.continue/config.yaml. The sweep turns those footprints into ai_surfaces rows with
discovery='repo_artifact', and for Continue emits surface_activity from a per-file line-count
watermark over dev_data event names only (tokensGenerated, chatInteraction, toolUsage,
autocomplete) with no bodies read.

**In the app** — New rows on the Shadow AI screen carrying a 'found in repo' badge and the root
path instead of a home path, with the evidence-ladder card showing 'footprint only, no telemetry'
for Aider; the Repos band shows a per-root agent chip.

**Source** — <root>/.aider.chat.history.md, .aider.input.history, .aider.model.metadata.json,
.aider.tags.cache.v*/ ; <root>/.continue/dev_data/*.jsonl event-name field and line count;

**Limit** — Both tools are invisible in any root Vole never discovered, so this is a lower bound
on a lower bound. Aider records tokens only through opt-in analytics, so every token field and
cost_usd stay NULL at confidence activity_only.

*Extends the earlier entry "BYOK agent collectors: Goose, Amp and Continue".*

### 45. VS Code chat request rows: fixing the 'Copilot collector' into an editor chat-store collector

`Shadow AI` · `Eng mgr` · **L** · exact · unscored

Measured on this machine: 173 chatSessions files, 213 MB, 163 requests, 163 unique responseId with
zero collisions, 690,680 completionTokens that Vole stores none of. Four corrections to the v1
entry. (a) It walks workspaceStorage/*/chatSessions only;

**In the app** — The People-view rows for every employee who never opens a terminal. The request
card shows a real duration (two kinds: totalElapsed and timeSpentWaiting) and an 'agent's own
turn' badge for isSystemInitiated.

**Source** — <editor root>/User/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl and <editor
root>/User/globalStorage/emptyWindowChatSessions/<id>.jsonl

**Limit** — The store has no input or cache count at all, so rows are confidence='exact' with
output_tokens set and input_tokens, cache_*, total_tokens and cost_usd all NULL. TOKEN_FILTER
(total_tokens IS NOT NULL) already excludes them from token aggregates, which is correct but
silently drops 690,680 real tokens unless the output-only counter is shown.

*Corrects the earlier entry "GitHub Copilot collector (VS Code agent mode exact output tokens; CLI
activity_only)".*

### 46. Cline / Roo / Kilo task collector: one exact row per task from the vendor's own running totals

`Shadow AI` · `CISO` · **M** · partial · unscored

Read state/taskHistory.json under each root x profile x extension-id (saoudrizwan.claude-dev,
rooveterinaryinc.roo-cline, kilocode.kilo-code): per task {id, ts, task, tokensIn, tokensOut,
cacheWrites, cacheReads, totalCost, size, workspace}. Emit one usage_events row per task,
event_key 'cline:<extensionId>:<taskId>' — no line index, no mtime — because those totals only
ever grow while a task runs, which is precisely what the monotone upsert at db.ts:87-101 already
implements: each poll rewrites the row when total_tokens strictly grows and is a no-op otherwise.
That also survives Cline's context-condense, which rewrites api_conversation_history.json and
would renumber any index-based key.

**In the app** — These rows are what People view is missing for the non-terminal employee:
surface='extension' with the editor root and profile beside the model. The Costs screen shows them
in a separate vendor-figure column with its own subtotal, so a mixed total can never be printed as
one number.

**Source** — <editor root>/User/[profiles/<id>/]globalStorage/{saoudrizwan.claude-
dev,rooveterinaryinc.roo-cline,kilocode.kilo-code}/{state/taskHistory.json,
tasks/<id>/{api_conversation_history.json,task_metadata.json,ui_messages.json}}

**Limit** — Not installed on this machine, so the key names come from the vendors' trackers rather
than from disk here — the collector must probe and, when the usage keys are absent, emit
activity_only with the extension version stamped and every token field NULL, never deriving tokens
from message counts. These schemas change per extension version.

### 47. ai_dependencies: the installed SDK tree, not the declared manifest

`Shadow AI` · `CISO` · **M** · exact · unscored

Under already-consented repo roots, read both the declaration and the resolution and store them as
separate bindings: package.json dependencies, requirements.txt, pyproject.toml, go.mod and
Cargo.toml for 'declared'; node_modules/.package-lock.json (packages{} -> version), **/site-
packages/*.dist-info directory names, ~/.local/pipx/venvs/*/lib/python*/site-packages/*.dist-info,
uv.lock and poetry.lock for 'installed'.

**In the app** — Shadow AI screen gains a 'No-log AI' section; inside it a 'Code that calls a
model directly' table lists repo, package, installed version (declared version struck through when
they differ), first seen and an advisory-floor chip.

**Source** — package.json / requirements.txt / pyproject.toml / go.mod / Cargo.toml;
node_modules/.package-lock.json;

**Limit** — A dependency is not a call. It cannot know whether the code ever ran, which key it
used, or how many tokens it spent;

### 48. launchd-declared log tail: surface_activity for daemons that were never instrumented

`Shadow AI` · `Platform` · **M** · exact · unscored

Parse ~/Library/LaunchAgents/*.plist and /Library/Launch{Agents,Daemons}/*.plist with the plist
reader (never launchctl load), and for any job whose ProgramArguments[0] resolves inside an
ai_dependencies repo or venv, enrol it in ai_surfaces as surface_class='homegrown',
binding_evidence='launchd', carrying RunAtLoad, KeepAlive and StartInterval. Then read the log the
job's own operator declared in StandardOutPath / StandardErrorPath, tailed with a byte-offset
cursor in scan_state, counting only windows that match a shipped versioned endpoint pattern pack
(POST /v1/messages, POST /v1/chat/completions, POST /v1beta/models/*:generateContent, model=<id>).

**In the app** — 'No-log AI' section, 'Always-on AI services' card per launchd job: label, program
path, run-at-load and keep-alive chips, restart count, and a per-day sparkline of matched request
lines split by status class, captioned 'requests observed, tokens unknown'.

**Source** — ~/Library/LaunchAgents/*.plist and /Library/Launch{Agents,Daemons}/*.plist (Label,
ProgramArguments, RunAtLoad, KeepAlive, StandardOutPath, StandardErrorPath); the file those two
keys name

**Limit** — The counter counts log lines that match a pattern, never billed API calls: the
operator can point StandardOutPath at /dev/null, rotate on their own schedule, or run the same
service under nohup or tmux with no plist at all. A matched line proves the daemon logged a
request shape, not that a provider charged for it, so tokens and cost remain NULL forever.

*Corrects the earlier entry "Agent registration handshake for SDK apps, CI runners and custom
agents".*

### 49. First-seen AI surface rule (new_ai_surface)

`Shadow AI` · `CISO` · **M** · exact · 4/5

A zero-configuration rule over the ai_surfaces table in the shape detect/*.ts already uses: the
first time a surface_key is stored, fire an info anomaly keyed 'surface_first_seen:' +
surface_key. The key contains no now(), so the INSERT OR IGNORE at db.ts:137 makes it fire exactly
once per surface for the life of the store. observed = 1, threshold = 0, baseline NULL, and the
detail quotes the evidence path (the residue file, bundle id or process name that produced the
surface row).

**In the app** — Incident feed row 'New AI surface: Windsurf (residue) first seen 2026-09-07' with
the evidence path; the AI Surfaces grid marks the row with a 'new' dot until acknowledged.

**Source** — ai_surfaces rows (surface_key, kind, evidence path, first_seen) produced by the
shadow-AI scanners; db.ts insertAnomalies.

**Limit** — A surface that existed before Vole was installed cannot be distinguished from one
installed today, which is why first-scan discoveries are suppressed and the suppression disclosed.
The rule proves an artifact exists on disk, never that the tool was used, and never that it was
used with company data.

### 50. Sanctioned-vs-detected policy join and unsanctioned_surface_first_seen

`Shadow AI` · `CISO` · **M** · partial · 4/5

The buyer-facing layer over the registry: join every `ai_surfaces` row against an allowlist in
`~/.vole/policy.json` (merged under the admin-owned `/Library/Application
Support/Vole/policy.json`, following the pricing.json override pattern) to resolve a Sanctioned /
Unsanctioned / Undeclared chip, and fire `unsanctioned_surface_first_seen` the first day a surface
appears that policy does not declare. Each card states detected (yes/no/artifact-only), sanctioned
(yes/no/undeclared), first seen, last seen, sessions, whether tokens are exact or activity-only,
and which literal local artifact proved it.

**In the app** — Agents & Shadow AI card grid ordered detected-unsanctioned first; card drill-down
shows the artifact path with Reveal in Finder, the per-pass heartbeat sparkline from
collector_runs, and the sessions list filtered to that surface.

**Source** — ai_surfaces joined to policy.json allowlist; collector_runs /
CollectorResult.notes+filesScanned (collect.ts:36-60) for the heartbeat half;

**Limit** — Sanctioning is only as complete as the policy file: with no allowlist every surface is
'undeclared' and the screen must say so rather than defaulting anything to unsanctioned.

*Extends the earlier entry "Policy-as-code file with local enforcement, drift report and
vole_policy check".*

### 51. Provider key-name census and the provider_key_without_sanctioned_surface rule

`Shadow AI` · `CISO` · **M** · exact · unscored

Four name-only reads that never carry a value past the match window: (i) ~/.zshrc, .zshenv,
.zprofile, .bashrc, .bash_profile, .profile, ~/.config/fish/config.fish, .envrc and repo .env* -
store the variable NAME, the file and a line ordinal for *_API_KEY, *_AUTH_TOKEN,
ANTHROPIC_BASE_URL, OPENAI_BASE_URL, AZURE_OPENAI_*, GEMINI_API_KEY, OLLAMA_HOST; (ii) launchctl
getenv <name> over the same dictionary, recording set/unset and a length only; (iii) security
dump-keychain with no -w ever, keeping only the svce and acct blob labels;

**In the app** — 'No-log AI' section, 'Provider keys held here' table: provider, key name, holder,
first seen, and a chip reading 'an enrolled agent uses this provider' or 'no enrolled surface'.
Rows open a path receipt naming the file and byte offset read;

**Source** — shell rc and env files; .envrc;

**Limit** — Possession is not use, and this rule fires on possession: it cannot count a call,
price one, or prove the key is still valid. security dump-keychain returns only unlocked keychains
and may prompt, so an absent row is not an absent key;

### 52. Console and gateway coverage ledger — what nobody else can see

`Shadow AI` · `CISO` · **M** · partial · 4/5

Turn the market wedge into a number the buyer computes on their own laptop. Ship
data/console_coverage.json: for each vendor console and gateway shape, the exclusions the vendor
itself documents — Anthropic's Compliance API excludes API-key, Bedrock/Vertex and personal
accounts; Codex governance covers ChatGPT-workspace accounts only;

**In the app** — A new top-level Dashboard screen 'Coverage' showing a two-axis matrix (rows =
tool, columns = visible to vendor console / gateway / neither), each cell carrying calls and exact
tokens, with a footnote per column citing the vendor doc URL and the date it was read, and an
Export button that writes the same table into the assessment report.

**Source** — usage_events (tool, session_id, tokens, cost_usd, account_class) joined to a shipped
data/console_coverage.json; provider host from provider config snapshots where present.

**Limit** — This is a claim about what a vendor's documentation said on a given date, not an
observation of the customer's actual console or gateway configuration, so every column is labelled
'as documented <date>' and an admin can override it. It cannot see rows on laptops that never ran
Vole, so the 'neither' cell is a floor and never a total.


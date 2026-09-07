# Tier 6 — Posture, supply chain and the pack plane: what granted the authority in the first place

[← Enterprise roadmap index](../ENTERPRISE-ROADMAP.md) · 80 features

Every incident in Tier 5 has an upstream cause sitting in a config file: an MCP server registered
at a new endpoint, a hook whose command changed, a plugin from an unverified marketplace, a
wildcard allowlist entry that authorised a shell class forever, a workspace-trust transition, an
instruction file with hidden Unicode, an `ANTHROPIC_BASE_URL` planted by a dependency. The
2025-2026 incident record is almost entirely this shape — Rules File Backdoor, MCP tool poisoning,
Amazon Q's committed wipe prompt, the Nx s1ngularity `--dangerously-skip-permissions` recon, the
Keyv worm planting hooks, the Claude Code project-file RCE with key exfiltration via base URL —
and all of it is exact from local config plus the agents' own rotating backups, with no network
and no scanner anyone else has to run. This tier inventories MCP registrations keyed on endpoint
identity rather than server name, hooks with first-seen command hashes, plugins with cross-agent
blast radius, grants and overrides with the file that granted them, managed-policy coverage and
precedence per agent, native telemetry and prompt-logging posture, binary signing (Team ID,
CDHash, ad-hoc), and a shipped offline advisory floor. It also builds the pack plane properly —
two trust classes (vendor-signed content, admin-authored policy), a builtin floor that cannot be
removed, `content_rev` on incidents so a pack bump re-scores without duplicating, a suppression
register that keeps counting what it hid, and `vole packs --preflight` so a candidate pack is
scored against real evidence before a fleet gets it. It follows Tier 5 because posture without the
ledger is a list of settings, and posture beside the ledger is 'this grant is what let that
happen'.

Legend: `category` · `buyer` · effort **S**/**M**/**L**/**XL** · feasibility (*exact* =
readable from local data today, *partial*, *new instr.* = needs something written that does
not exist, *network* = crosses the network line) · value 1–5, 5 meaning a security lead blocks
the rollout without it. `unscored` came from a completeness sweep and skipped the verifier.

---

### 1. Shadow MCP: servers called but present in no local config

`Shadow AI` · `CISO` · **M** · exact · 4/5

Set-difference between the servers the agent actually called and the servers any local config
declares. Left side: distinct `mcp__<server>__` prefixes from the tool_calls ledger — playwright
1,994, searxng 548, Claude_Browser 298, github 48, context7 31, ui 13, ccd 2. Right side:
`posture_mcp_servers` identities from `~/.claude.json` (four here: searxng, playwright, context7,
github), `.mcp.json`, Codex config.toml, opencode.jsonc, Cursor.

**In the app** — Supply Chain → MCP splits into two lists, 'Configured' and 'Observed only (no
local config)', the second badged amber with call counts; the menu-bar panel surfaces the first
unregistered server seen in the last 24h.

**Source** — tool_calls / usage_events.tools LIKE 'mcp\_\_%'; ~/.claude.json mcpServers and
claudeAiMcpEverConnected;

**Limit** — A server reached through the vendor's own proxy leaves no command, no URL, no
transport and no version locally — Vole can name it and count its calls and nothing more; the
endpoint fields are NULL, never guessed.

*Extends the earlier entry "MCP server inventory, trust posture, usage diff and pin/sign rules".*

### 2. Offered-tool-surface ledger (what the model was actually handed)

`Tool ledger` · `Platform` · **M** · exact · 4/5

Config says which servers are registered; the transcript says which tools reached the model. A
posture_tool_surface table stores one row per (session, ts, kind, name, action) from three Claude
attachment types re-counted today: deferred_tools_delta (761) carrying
addedNames/addedLines/removedNames/readdedNames plus pendingMcpServers[], agent_listing_delta
(129) carrying addedTypes/addedLines, and skill_listing (608) carrying the full skill roster.

**In the app** — Session detail gains a 'tool surface' strip: a timeline of tools added and
removed during the session, with names not traceable to a config file marked unconfigured; Supply
Chain → MCP shows configured-but-never-offered servers as 'pending', and an incident's detail
names the tools that were on offer when it fired.

**Source** — ~/.claude/projects/**/*.jsonl attachment.type in {deferred_tools_delta,
agent_listing_delta, skill_listing}

**Limit** — Names only — the ledger records that a tool was offered, never its schema or
description, so it cannot support tool-poisoning analysis. pendingMcpServers means 'registered,
not yet connected at this point in the session', which is not the same as failed;

*Extends the earlier entry "System-prompt and injected-context census (Tier 3), which hashes these
attachments for drift but builds no per-session tool-availability ledger".*

### 3. MCP registration sweep keyed on endpoint identity, not server name

`Posture` · `CISO` · **M** · exact · 5/5

One posture_mcp_servers(source, config_path, client, server_name, mcp_identity, transport,
command, argv, url, cwd, enabled, env_key_names, first_seen, last_seen) table covering every MCP
client on the machine, keyed on mcp_identity = sha256 over the normalised endpoint (transport,
resolved command, argv array, cwd, url and the sorted KEY NAMES of env/headers) and never on the
display name the user chose.

**In the app** — Supply Chain > MCP: one row per identity with a transport glyph, the command or
URL, enabled state, the list of client config files that registered it, and first/last seen; a red
identity-changed badge opens a drill-down showing the old and new identity hashes side by side
with their two timestamps.

**Source** — ~/.claude.json mcpServers and projects[*].mcpServers; repo .mcp.json;

**Limit** — An `npx -y <pkg>` identity is stable while the package contents change on every run -
the hash proves the registration did not change, never that the code did not. Relative commands
resolve differently per cwd, so their identity is recorded as-written and flagged unresolvable.

*Corrects the earlier entry "MCP server inventory, trust posture, usage diff and pin/sign rules".*

### 4. Vendor lever cards: each tool's own permission config, observed value beside the hardened one

`Control` · `CISO` · **M** · exact · 4/5

Instead of reinventing process control for tools with no hook seam, read each tool's native lever
and show the literal config line to change, with a copy button; Vole writes nothing (SECURITY.md:
writes only under ~/.vole). Real values on this machine: opencode.jsonc has permission
{edit:'allow', bash:'allow', webfetch:'allow', external_directory:'allow'} — all four wide open;

**In the app** — A 'Harden this tool' card on the incident drill-down showing only the levers
relevant to the rule that fired, and a Settings > Levers matrix: one row per tool per lever with
observed value, recommended value, copy button, and a drift badge when the value changed since
first seen.

**Source** — ~/.config/opencode/opencode.jsonc permission block; ~/.grok/config.toml yolo,
permission_mode;

**Limit** — A config file proves what is written, not what runs: a project-level config, a CLI
flag, an env var or an MDM-managed profile can override it and Vole sees none of those at the
process level, so a card can say 'hardened' about a session that is not. Keys absent from the file
are rendered 'not set', never filled in with the vendor's default.

*Corrects the earlier entry "Cross-tool control adapters (Codex, OpenCode, Grok)".*

### 5. content_packs registry: verified offline load with an unremovable builtin floor

`Platform` · `Platform` · **M** · new instr. · unscored

Adds `content_packs(kind TEXT PRIMARY KEY, version, built_at, source, ring, sha256, signed_by,
entry_count, installed_at, load_state)`, written by the collector once per poll from
`/Library/Application Support/Vole/packs/<kind>.json` plus a detached `<kind>.json.sig`, verified
with `crypto.verify(null, bytes, spki, sig)` against an Ed25519 SPKI pinned in the SEA — confirmed
working on this machine under the bundled node v26.7 with `node:crypto` alone and a 60-char base64
SPKI key, so no native module and no dynamic require.

**In the app** — Settings → Content: one row per pack kind with version, built date, age in days,
ring, signer fingerprint and a load_state chip; a rejected pack shows the literal reason and
states that shipped content is still running.

**Source** — New: /Library/Application Support/Vole/packs/<kind>.json and <kind>.json.sig (root-
owned, MDM-delivered). Existing precedent: packages/core/src/data/pricing.json frozen into the SEA
by scripts/build-sea.mjs, and the ~/.vole/pricing.json override at paths.ts:21.

**Limit** — A signature proves the pack came from whoever holds the key, not that its content is
correct or complete. Anyone who can write /Library can also replace the app, so this is tamper-
evidence for non-root users and drift-evidence for MDM, never a defence against root.

*Extends the earlier entry "Policy-as-code file with local enforcement, drift report and
vole_policy check".*

### 6. Suppression register: turn a detector off centrally, keep counting what it hid

`Governance` · `DPO` · **M** · exact · unscored

v1's policy.json lists `suppressions` with no accounting, which makes "0 findings"
indistinguishable from "0 reported" — unacceptable in a product whose whole claim is that a number
is never invented. A suppression entry `{kind, entry_id, reason (required), set_by, expires_at?,
mode}` ships in an admin_authored pack: `mode=mute_report` still evaluates the detector and
increments `suppressed_counts(day, kind, entry_id, n)` while writing no finding and sending no
notification, whereas `mode=mute_scan` skips the work entirely and writes NULL — never 0 — into
that counter. Every aggregate that could read as clean renders the suppressed count beside it.

**In the app** — Policy screen gains a Suppressions table (entry, reason, set_by, expires, hits
hidden in range); every zero-finding figure on Data Exposure and the Behaviour board carries a "+N
suppressed" affordance that opens it, and a mute_scan entry renders "— not evaluated" rather than
a count.

**Source** — suppressions block of the admin pack under /Library/Application Support/Vole/packs;
counters incremented in the same collector pass that evaluates the detector, so no second scan is
needed.

**Limit** — The counter counts matches, not true positives: a suppression hiding a real leak looks
identical to one hiding noise, and the count is the only evidence either way. mute_scan cannot be
counted at all by construction, which is why it renders as unknown rather than zero.

*Corrects the earlier entry "Policy-as-code file with local enforcement, drift report and
vole_policy check".*

### 7. Pricing as a pack kind, and the user override that must lose in managed mode

`FinOps` · `FinOps` · **M** · exact · unscored

`~/.vole/pricing.json` (paths.ts:21, `$VOLE_PRICING`) is today unsigned, user-writable,
unversioned and read once at import in `loadPricing()`, and `repriceUnpriced` (db.ts:199) rewrites
historical `cost_usd` in place — so on a managed laptop a developer can change their own showback
and nothing anywhere records that they did. Pricing becomes content_pack kind `pricing` with
precedence managed_pack > user override > builtin; the resolved revision is stamped into
`cost_basis` at insert as `pricing_rev`;

**In the app** — Costs screen footer names the pricing revision behind every total and shows a
"mixed pricing revision" chip when the range spans a bump; Settings → Content lists the pricing
pack like any other kind, including an ignored user override with its checksum.

**Source** — packages/core/src/data/pricing.json (builtin, inlined into the SEA at build);
~/.vole/pricing.json or $VOLE_PRICING (absent on this machine, so builtin is what runs today);

**Limit** — Every figure remains a list-price equivalent, not a bill; a rate bump changes what
past usage "would have cost", so Vole labels mixed ranges instead of pretending one number covers
both.

*Corrects the earlier entry "What-if per project/session with third-party rate cards".*

### 8. Repos band on Posture: four readability states and a printed denominator

`Desktop` · `CISO` · **M** · exact · unscored

A band on the existing Posture screen that renders the registry with the same honesty the coverage
strip already demands: roots known, roots readable, roots skipped by policy, roots not present,
and the byte receipt from repo_scan_state, with the denominator sentence written out — 'artifact
findings cover 24 readable roots of 58 known; 34 roots are not present on disk and their last-
known state is from <date>'. Every count is a real query, never a bare zero: a root with no
artifacts renders 'none of the 18 declared paths present', a root that could not be opened renders
'unreadable', and a root with an over-budget file renders its em-dash sha with the skip reason.

**In the app** — Posture screen, Repos band: a sortable root list with kind, origin,
classification, last agent activity and artifact-count chips; expanding a root shows the artifact
ledger with tracked-state and sha;

**Source** — work_roots, root_cwds, repo_artifacts, repo_scan_state (all local); no new source
read

**Limit** — The band can only show roots that produced agent evidence, so its 'known' figure is
itself a lower bound and is labelled as one rather than presented as a repo inventory. Artifact
counts describe this laptop at the last scan cursor;

*Extends the earlier entry "Posture screen with three-state controls and an evidence coverage
ratio".*

### 9. Crown-jewel-scoped rule variants: same detection, escalated only on a tiered target

`Data exposure` · `CISO` · **M** · exact · unscored

No new matching — a join and a distinct rule id, so a SOC can route tier-1 separately without
retuning a single threshold: crown_jewel_read_unasked (sensitive_read_unasked where the path
resolves to tier ≤ 2), crown_jewel_egress (dlp_egress whose class × tier crosses the register's
declared line), tier1_remote_write (action_targets remote_database_write against a declared
production DSN — this machine's transcripts name launchsafe-db-do-
user-35002029-0.e.db.ondigitalocean.com 39 times and a second landing DB 30 times) and
crown_jewel_left_device (context_edges whose destination is off-device carrying a tier-1 target).

**In the app** — A 'Crown jewels' filter pill on Leak Ledger and the Behaviour board; each
incident card shows the parent rule and the variant together with the register entry's basis.

**Source** — secret_sightings / dlp_egress / action_targets / context_edges rows carrying asset_id
and asset_tier; register dsn, domain, path and repo entries from ~/.vole/policy/assets.json.

**Limit** — Shape near-misses are the real failure mode: the same transcripts contain db-
xxxx.b.db.ondigitalocean.com 25 times plus HOSTNAME_OR_IP_ADDRESS and host:25060 placeholders, all
of which look like a production DSN.

*Corrects the earlier entry "sensitive_path_class_exposed rule (destination-aware)".*

### 10. Grant widening by one click: the always-accept that wrote a wildcard shell rule

`Authority` · `CISO` · **S** · exact · unscored

The sequence is on disk in full: Got response: {'optionId':'always-accept'} followed within 130 ms
by [PolicySession] Persisted allow rule for shell matching 'echo *' at scope=workspace, then 'git
*' at scope=user, then 'head *' at scope=session, with rebuild() complete: 17 then 18 then 19
rules parsed. The results are still there — ~/.kiro/settings/permissions.yaml holds capability:
shell / effect: allow / match: [git *] and ~/.kiro/workspace-roots/<hash>/permissions.yaml holds
'echo *'.

**In the app** — Posture > Grants lists each pattern with its scope, the timestamp, whether a
click or a file edit created it, and the rule-count delta; the two shapes sit side by side (Kiro's
allow-list growth and VS Code's shrinking deny-list) so a reviewer sees the same event in both
idioms.

**Source** — ~/.kiro/logs/<stamp>/kiro.log ([ACP ToolApproval] Got response, [PolicySession]
Persisted allow rule ... at scope=...);

**Limit** — The log gives the pattern and the scope, not who clicked beyond the OS user already
stamped at insert. A rule typed directly into permissions.yaml produces no event, only a file
mtime, so origin='file_edit' carries a coarser timestamp and cannot be pinned to a session.

*Extends the earlier entry "Grant and override ledger: which file granted this authority, and what
weakens the guardrails".*

### 11. security_envelope_changed: posture- and authority-weighted, not count-weighted

`Behaviour` · `CISO` · **M** · exact · unscored

One rule over the classified rows, scored by who authorised the change rather than how many
changes there were. Each envelope-class write joins round 2's four-state `authorization_basis`
(denied / pre-authorised / posture-waived / no record) and the `autonomy_intervals` timeline
covering the write's timestamp: info when the write sits under an explicit grant in `default`
mode, warn under `acceptEdits` or `auto`, critical when the covering interval is
`bypassPermissions` and the unattended evidence chain holds.

**In the app** — Incident card on the Triage queue whose drill-down lands directly on the 'what
the agent left behind' section filtered to that session and class, with the posture interval drawn
as a band under the write's timestamp.

**Source** — The change_risk_class ledger joined to autonomy_intervals and authorization_basis;
posture from Claude `permissionMode` lines (712 bypassPermissions, 767 auto, 51 default here) and
Codex `turn_context.payload.{approval_policy, sandbox_policy.type}`.

**Limit** — Three of the 25 envelope writes here sit in sessions that also carry
bypassPermissions, but Claude records the mode as its own line type rather than per tool call, so
posture at the instant of the write is an interval lookup and is NULL when no interval covers it —
never defaulted to 'default', and a NULL posture degrades the rule to warn.

*Extends the earlier entry "Out-of-repo write and agent self-modification rules (scope_escape,
agent_config_modified)".*

### 12. Cross-agent credential and base-URL injection

`Posture` · `CISO` · **S** · exact · 5/5

One agent can silently reconfigure another, and modelling each agent's config in isolation misses
it entirely. ~/.codex/config.toml [shell_environment_policy.set] is injected into every shell
Codex spawns, and on this machine it sets ANTHROPIC_AUTH_TOKEN,
ANTHROPIC_BASE_URL=http://localhost:4141, ANTHROPIC_MODEL=claude-opus-4.6 and
ANTHROPIC_SMALL_FAST_MODEL=gpt-4 (verified, with inherit="core") -- so a `claude` launched from
inside a Codex session talks to a different endpoint under a different token than the same command
run from a normal terminal.

**In the app** — Supply Chain -> Environment: a matrix of 'set by' agent versus 'affects' agent,
each cell listing the variable names and the destination host; a cell containing a credential-
shaped variable name renders critical with the config file path and a Reveal in Finder action.

**Source** — ~/.codex/config.toml [shell_environment_policy].inherit and
[shell_environment_policy.set] (verified live on this machine); ~/.claude/settings.json env block
(empty here) plus its 5 ccr/reset backups;

**Limit** — Only variable NAMES, the parsed host and the config path are stored; the token value
stays in memory for the scan and never reaches vole.db.

*Extends the earlier entry "Model-route integrity and allowlist (model_provider_rerouted,
model_switch, model_not_allowed)".*

### 13. Plugin always-on context tax, priced per model per session

`FinOps` · `FinOps` · **S** · partial · 2/5

Claude Code caches the marketplace catalog at `~/.claude/plugins/plugin-catalog-cache.json` with,
per plugin, `tokens:{<model>:{always_on, on_invoke}}`, `components`, `unique_installs` and
`marketplace_sha`. Store it as a `posture_plugin_catalog` table keyed on (marketplace_sha, plugin)
and compute, per enabled plugin, the exact always_on token cost it adds to every request on this
machine multiplied by the session count from usage_events in range — a figure that comes from the
vendor's own catalog and is therefore counted, not estimated.

**In the app** — A FinOps 'context tax' row under Breakdown listing always_on tokens per plugin
per model and the running total across sessions in range, rendered as an em dash wherever the
catalog lists no figure for the model actually in use.

**Source** — ~/.claude/plugins/plugin-catalog-cache.json — verified here: fetchedAt
2026-08-29T07:17:37Z, catalog.generated_at 2026-08-28, marketplace_sha 0620a687…, catalog.models
['claude-opus-4-7','claude-sonnet-4-6'], plugins[].tokens.<model>.{always_on, on_invoke} (e.g.

**Limit** — The catalog is a cache with a fetchedAt and lists token figures only for the models it
was generated against (two models here), so a session on any other model gets NULL and never a
substituted figure. It covers marketplace plugins only — a locally installed or inline plugin has
no catalog entry at all.

*Related to the earlier entry "Context cost views: first-call context per session and growth
following each tool".*

### 14. Rule provenance and control-framework mapping on every incident

`Governance` · `Procurement` · **S** · exact · 4/5

Every rule ships a static provenance record in its definition — {incident_name, incident_date,
url, detectability, framework_ids[]} — plus a rule_controls(rule, framework, control_id,
control_title, mapping_version) table in packages/core/data/controls.json, joined to
anomalies.rule at read time so one Vole incident lands in a SIEM already carrying the control id
the auditor asks about. Seeded mappings: privilege_escalation_mid_session and
unattended_full_access to OWASP ASI excessive agency (ASI02/03); sensitive_read_unasked and
cross_scope_read_then_publish to OWASP MCP tool poisoning and MITRE ATLAS CS0045;

**In the app** — Framework chips on each incident row and a framework filter in the incident feed;
a collapsed 'Why this rule exists' footer on every incident card showing the source incident name,
its date, a copyable URL and its detectability verbatim;

**Source** — Static provenance metadata compiled into detect/*.ts alongside each rule's
thresholds; packages/core/data/controls.json versioned in the repo;

**Limit** — The mapping is Vole's editorial judgement about which control a rule provides evidence
for — not a certification and not an assessor's opinion — so it is versioned, shown with its
version and the framework version it was written against, and worded 'evidence toward', never
'compliant with'.

*Extends the earlier entry "Compliance evidence pack export".*

### 15. repo_carried_grant: the permission allowlist that travels with the clone

`Authority` · `CISO` · **S** · exact · unscored

The already-planned allowlist scans score a grant's content; this scores its distribution. Join
repo_artifacts rows of kind claude_settings, claude_settings_local, cursor_hooks, mcp_json or
vscode_settings where tracked_state='tracked' to the existing grant-and-override ledger and to
work_roots.origin_slug, and fire repo_carried_grant keyed (root_id, artifact_sha256,
rule_text_hash) — deterministic, no now() — because a committed grant installs itself on every
clone, every teammate's checkout and every CI runner without any of them seeing an approval
prompt.

**In the app** — A 'travels to every clone' column on the Repos band showing origin slug and
tracked-file count, and an incident card on the Behaviour feed quoting the literal rule text, the
artifact path, its sha256 and the origin — with the observed/baseline/threshold figures selected,
not dropped.

**Source** — repo_artifacts rows for .claude/settings.json, .claude/settings.local.json,
.mcp.json, .cursor/hooks, .vscode/settings.json joined to tracked_state from .git/index and to
work_roots.origin_slug from <root>/.git/config; measured literal rules quoted above

**Limit** — Vole reads this laptop's index, so it cannot know whether the commit was pushed or how
many clones exist — the incident says 'staged in this repo', never 'installed on N machines'.
origin_slug NULL (apiup here has a .git and no remote) means the blast radius is unknown, not one.

### 16. Data-class entries: what 'customer data' means here, as validators and salted hashes

`Data exposure` · `DPO` · **M** · exact · unscored

The second half of the same pack: `class` entries that state what this company's customer data
looks like — a regex plus one of dlp_detectors' shipped offline checksum validator ids (Luhn,
mod-11, IBAN), a table/column name list, a filename shape such as customers*.csv, or a `literal`
supplied as HMAC-SHA256 under a pack-declared salt so the register on every laptop is never a file
of live values. Hits land in secret_sightings with class_entry_id and validator_checked, and the
two never aggregate into one figure: a checksum-validated customer id and an unvalidated shape
guess stay in separate columns everywhere they are rendered.

**In the app** — Data Exposure gains a 'Company classes' section beside the builtin detectors —
per-entry counts split validated vs shape-only, with the entry's basis; the Privacy Center field
dictionary lists class_entry_id and states that no matched value is ever stored.

**Source** — ~/.vole/policy/assets.json `class` entries; the existing dlp_scan_state cursors,
keyword prefilter and byte budget;

**Limit** — Exact matches only. A paraphrase, a re-encoded or joined export, a screenshot, a
summarised row set or a column renamed in transit is invisible, and the count is rendered with
that sentence beside it rather than implying recall.

### 17. Register coverage on every asset-scoped figure, and the unresolved worklist

`Desktop` · `CISO` · **S** · exact · unscored

A view v_asset_coverage(ledger, period, resolved, unresolved, no_target, coverage_pct) computed
per ledger over a declared denominator, because an implicit one lies: this machine's transcripts
touch 2,670 distinct hosts, nearly all public documentation, so coverage is computed over eligible
targets (write, egress, secret-sighting and remote-action rows) and the denominator's definition
is printed next to the number. An absent register renders 'No asset register loaded — every
severity is posture-only', never '0 critical assets', so an empty register is visible rather than
silently making everything low.

**In the app** — A coverage strip on Blast Radius, Leak Ledger and Data Exposure, matching the
attribution-coverage strip on People and the cost_basis strip on Costs; plus an 'Unresolved
targets' worklist ranked by row count, each with a copy-as-entry button that emits a candidate
register line.

**Source** — asset_id / asset_match / asset_rev columns on the five ledgers; the assets table's
pack_version;

**Limit** — Coverage measures how much of what Vole saw resolves — not how much of the company's
estate is declared. A perfect 100% can still mean the admin declared only the three systems these
agents happened to touch, and the strip says so.

### 18. vole packs --preflight assets.json: score a candidate register before the fleet gets it

`Platform` · `Platform` · **M** · exact · unscored

Reuses the existing pack preflight path to score a candidate register against this machine's
retained evidence, emitting per entry: rows it would resolve, entries resolving zero rows (dead),
entries claiming the same target (collision, naming which loses because chain order decides),
near_match entries where an observed host differs from a declared one by a single label or matches
a documentation placeholder, entropy-floor rejections for literals, and a severity delta — how
many already-stored incidents would escalate under content_rev if this pack shipped.

**In the app** — Posture → Asset Register → 'Preflight a candidate' file picker, rendering the
same worksheet the CLI prints, with a copyable diff and the severity-delta count.

**Source** — a candidate ~/.vole/policy/assets.json; the five asset-bearing ledgers already in
~/.vole/vole.db;

**Limit** — It scores against one machine's evidence, itself bounded by the evidence-expiry
countdown, so an entry scoring zero here may be another team's crown jewel. The output is a
worksheet, never a pass/fail gate, and the header states that before the first table.

### 19. change_risk_class: the envelope classifier on the file-write ledger

`Tool ledger` · `CISO` · **M** · exact · unscored

Adds nullable `change_risk_class`, `class_pattern_id` and `content_rev` columns to the existing
file-write ledger, populated at insert from a versioned path pack loaded through round 2's
content_packs registry. Every input is already in the ledger: Claude `toolUseResult.filePath`
(2,374 write results over 358 distinct paths on this machine), OpenCode `part.data` rows of
`type='patch'` (`files[]`, 971 here) and `tool.write|edit` `state.input.filePath`, plus the Bash
redirect/heredoc/copy targets round 2 resolves for Codex and Grok, which have no structured write
tool at all.

**In the app** — A class chip on every row of the file-write drill-down, and a new Envelope band
on Blast Radius counting rows per class with the unclassified rows printed as their own count
rather than folded into zero.

**Source** — ~/.claude/projects/**/*.jsonl `toolUseResult.filePath`;
~/.local/share/opencode/opencode.db `part.data` (`type='patch'.files[]`, `tool.write|edit
.state.input.filePath`);

**Limit** — This is a path class, not a content risk: a file named auth.ts may hold nothing
sensitive and a plain .ts may hold the whole authorisation policy. Cursor, Antigravity and Devin
record no write target of any kind, so their sessions contribute zero rows and must render as an
unmonitored denominator beside the total, never as 'no envelope changes'.

*Corrects the earlier entry "Agent edit ledger with blast radius, time-to-first-edit and cost per
lines written".*

### 20. envelope_change_escaped: did the widening leave the laptop

`Behaviour` · `Eng mgr` · **S** · exact · unscored

Joins the classified writes to the VCS action ledger inside the same session: Claude's own
`toolUseResult.gitOperation.{commit.sha, commit.branch, push.branch}` (105 such results here, 43
carrying both a commit and a push), falling back to the parsed `git push` command shape for agents
that record no gitOperation. Adds `escape_state` (local_only / committed / pushed) and
`push_evidence` (gitOperation / command_shape / none) to the envelope row — a provenance column,
not a confidence value, since confidence stays exactly two-valued.

**In the app** — An escape chip (Local / Committed / Pushed) on every row of 'what the agent left
behind', with the branch and short sha on the incident card so a reviewer can open the actual
commit.

**Source** — ~/.claude/projects/**/*.jsonl `toolUseResult.gitOperation`; Bash `input.command` for
`git push` / `git commit --no-verify` shapes;

**Limit** — gitOperation is Claude-only and appears only on the Bash results Claude chose to
annotate, so `push_evidence='none'` is common and must render as 'not observed', never as 'not
pushed'. A push from a terminal outside the agent, or a later push by a human, is invisible.

*Related to the earlier entry "Session to commit / PR provenance ledger".*

### 21. Hook execution ledger with first-seen command hashes

`Posture` · `CISO` · **M** · exact · 5/5

A posture_hook_runs(source, session_id, ts, hook_event, hook_name, command_sha256, argv0_basename,
script_in_managed_dir, exit_code, duration_ms, prevented_continuation, level) table reconciling
the two records Claude Code writes, with one correction that matters:
attachment.type='hook_success' (741 here) carries {hookName, hookEvent, command, exitCode,
durationMs, stdout, stderr, content, toolUseID} but its `command` field is the hook's DISPLAY
LABEL, not the shell command - verified: {"hookName":"SessionStart:startup", "command":"Loading
ponytail mode...", "exitCode":0, "durationMs":108}.

**In the app** — Supply Chain > Hooks: rows grouped by hook event with run counts, median
duration, exit-code distribution and a first-seen date; new-hash rows pinned to the top with a
critical badge and the argv0 path;

**Source** — ~/.claude/projects/**/*.jsonl attachment.type='hook_success' (741) and type='system'
subtype='stop_hook_summary'.hookInfos[].command (459); attachment.type='hook_additional_context'
(439);

**Limit** — hook_success.stdout and .content carry the full injected prompt verbatim (verified: an
entire multi-kilobyte instruction block), so only sha256 and length are ever stored.

*Corrects the earlier entry "Hook inventory and execution ledger".*

### 22. Pack-bump re-scan of retained evidence, oldest-first and bounded, with the unscannable backlog counted

`Data exposure` · `CISO` · **M** · exact · unscored

`dlp_scan_state` gains `pack_rev TEXT`; when the dlp_detectors version changes, the collector
requeues only rows whose `raw_ref` file still exists, oldest-first, draining inside the byte
budget the scan engine already enforces, so a bump degrades throughput rather than blocking a
poll. `secret_sightings` gains `first_seen_pack` and `refired_by_pack` written as NULL-only
widening updates, so the existing "rewrite only when total_tokens strictly grows" upsert rule is
not violated, plus a `retro` flag so a finding surfaced today about three-week-old evidence is
never rendered as new activity.

**In the app** — Data Exposure gains a "re-scanned for dlp_detectors <version>" banner carrying
the coverage fraction and the count of findings tagged retro; the Leak Ledger filter bar gains a
`retro` facet so an analyst can separate "new leak" from "new detector".

**Source** — dlp_scan_state cursors; usage_events.raw_ref (file path plus byte offset stamped by
every collector);

**Limit** — A new detector can only find what is still on disk. Claude Code deletes local
transcripts after 30 days by default (anthropics/claude-code#23710), so for older sessions the
honest answer is "not re-checked", never "no finding" — and the window between a leak and the pack
that could have seen it is unrecoverable.

*Extends the earlier entry "Secret pattern scanner with entropy gate (secret_findings)".*

### 23. assets.json: the admin-authored register, and the two entry kinds it refuses to load

`Governance` · `CISO` · **M** · exact · unscored

Reads only ~/.vole/policy/assets.json, loaded through the content_packs registry as kind `assets`
in the admin-authored trust class under the customer trust anchor — never vendor-signed, never
inferred from evidence. Entries are {asset_id, tier, kind, match, owner, basis} where kind is repo
(a normalised remote URL or a `github.com/<org>/*` prefix), path (glob), domain (host suffix), dsn
(host+port), store (path prefix) or class (see the data-class feature); `basis` is a one-line
admin sentence quoted verbatim in every incident that cites the asset.

**In the app** — Posture → Asset Register: a read-only entry table (tier chip, owner, basis,
resolved-row count) matching the existing Policy screen's read-only-by-design rule, with a red
'Rejected entries' section naming the entry index and the refusal reason.

**Source** — ~/.vole/policy/assets.json (admin-authored, signed under the customer trust anchor,
loaded via the content_packs registry); validated against the shipped dlp_detectors credential
shapes at load time.

**Limit** — The register is a declaration, not evidence: Vole can prove an agent touched
github.com/launchsafe/platform, never that the org's tier-1 list is complete or correct. An absent
file means 'no register loaded', never 'nothing here is critical'.

*Extends the earlier entry "Policy-as-code file with local enforcement, drift report and
vole_policy check".*

### 24. Criticality as the second severity input — and why asset_tier must stay out of anomaly_key

`Authority` · `CISO` · **M** · exact · unscored

Severity becomes f(posture, asset_tier): a rule firing against a tier-1 or tier-2 target escalates
exactly one step above its posture-weighted level, and an unresolved target never de-escalates —
it keeps the posture-only severity and the detail line reads 'target not in the register', never
'low value'. Adds anomalies.asset_id, asset_tier and asset_rev plus a severity_inputs template
parameter so an incident reads 'critical: bypass posture + tier 1 (assets.json v7, entry prod-db:
"customer database, DPA scope")'.

**In the app** — Severity chips gain a tier marker; the incident card shows a two-line severity
derivation (posture input, asset input) with the register entry's basis quoted and a link straight
to that entry in Posture → Asset Register.

**Source** — anomalies rows joined to the ledger row's asset_id/asset_tier/asset_rev;
~/.vole/policy/assets.json tier and basis;

**Limit** — Escalation is one declared step, never a computed risk score — the product stays out
of Annex III 4(b) scoring territory by construction. An incident that fired before the register
existed shows its original severity beside 're-scored at content_rev N', so the audit trail admits
the verdict changed rather than pretending it was always critical.

### 25. Blast Radius sorted by asset tier, with a counted untiered bucket

`Desktop` · `CISO` · **M** · exact · unscored

The Blast Radius screen sorts and groups by asset tier, and the 'Untiered' group is always counted
and expandable — never collapsed to zero, never hidden, and never sorted to the bottom, so an
undeclared crown jewel is not buried by its own absence. Each row shows tier, asset_id, owner, the
basis verbatim, the chain link that resolved it and the register version that made the match. A
'Propose as asset' action writes a candidate entry to ~/.vole/policy/assets.proposed.json and
never touches the signed pack: in managed mode the register is admin-only, so the desktop's only
write is a proposal an admin can accept or discard.

**In the app** — Blast Radius with tier headers ('Tier 1 — 3 targets, 214 actions', 'Untiered — 61
targets, 1,908 actions'), the resolution link on every row, and the proposal button; the menu bar
carries a count of tier-1 incidents only, never a score.

**Source** — action_targets, context_edges and remote-execution rows joined to assets via
asset_id; ~/.vole/policy/assets.proposed.json for the write.

**Limit** — Untiered is not safe — it is unknown, and the group header says exactly that. The
proposal file is a suggestion with no authority: nothing in it affects severity until an admin
signs it into the pack, and the screen must not imply otherwise.

### 26. write_then_hide: the change the agent made unreviewable

`Behaviour` · `CISO` · **S** · exact · unscored

The visibility class, joined rather than alerted on alone. An addition to `.gitignore`,
`.dockerignore`, `.npmignore` or `.git/info/exclude`, a `git update-index --assume-
unchanged|--skip-worktree`, or a `git config` write is stored with the added pattern taken from
the key-set delta. `write_then_hide` fires only in two shapes: a path the same session wrote is
matched by a pattern the same session added, or the added pattern covers a path already present in
round 2's `tracked_state` snapshot from `.git/index`.

**In the app** — Hidden paths rendered struck-through in 'what the agent left behind' with the
ignoring pattern shown beside them, and an info-tier count of visibility writes that did not fire
so the quiet ones are still visible.

**Source** — The change_risk_class visibility rows, their pre/post images for the pattern delta,
the same session's write ledger, and `tracked_state` from `.git/index`.

**Limit** — Adding build output to `.gitignore` is overwhelmingly the honest case, which is why
the bare class stays info and only the join fires. The rule cannot see a file hidden by a pattern
that was already there, nor one hidden by a human.

### 27. Window hunt: what entered this machine's agent surface between two timestamps

`Tool ledger` · `Platform` · **S** · exact · unscored

Half the advisories name an interval rather than an artifact — s1ngularity was "whoever installed
in this window", the Keyv worm was a publication range — so the hunt takes [A,B] and returns every
first appearance across the ledgers that already carry a first_seen: package executions, MCP
registrations by endpoint identity, hook command hashes, tool_first_seen, ai_extensions, egress
hosts on context_edges, plugin installs and work_roots.

**In the app** — A date-range picker on the Triage screen's hunt entry point producing a single
grouped list, each row jumping to the ledger card that owns it; rows whose first_seen sits at the
horizon are struck with a floor marker instead of a date.

**Source** — first_seen columns on the existing package execution, MCP registration, hook,
tool_first_seen, ai_extensions, context_edges, plugin and work_roots ledgers; answerable_from for
the floor

**Limit** — first_seen is first observed, not first present: anything whose first observation
coincides with the answerable_from floor is reported as floored and can never be claimed to have
arrived inside the window. An artifact that arrived and was removed before the collector's first
pass leaves nothing here — only the residue hunt can reach it.

### 28. Managed-policy coverage and precedence chain per agent

`Posture` · `Platform` · **M** · partial · 5/5

Answer the first question a platform lead asks: is any of this actually under management? Probe
every managed layer that exists per tool and record presence, owner_uid, mode and sha256 into
posture_policy_layers(source, layer, path, present, owner_uid, mode, sha256, checked_at), then
render the precedence chain per tool with the layer that actually wins: /Library/Application
Support/ClaudeCode/managed-settings.json, the com.anthropic.claudecode defaults domain,
/Library/Managed Preferences/<user>/*.plist, /Library/Application Support/GeminiCli/settings.json,
/Library/Application Support/ampcode/managed-settings.json, /Library/Application
Support/Cursor/hooks.json, ~/.codex/requirements.toml.

**In the app** — Supply Chain → Policy: one row per (tool, layer) with present/absent/unknown,
file owner and mode, and the precedence order drawn as a chain with the winning layer highlighted;
a headline chip reads 'device managed · 0 of 8 agents under policy'.

**Source** — /Library/Application Support/ClaudeCode/managed-settings.json; `defaults read
com.anthropic.claudecode`;

**Limit** — Absence is only provable for paths Vole can read: under a Full-Disk-Access-denied
state some /Library paths return EPERM and the row must read 'unknown', never 'absent' (the
reduced-functionality pattern in market.md §7).

*Corrects the earlier entry "Permission allowlist and managed-settings posture".*

### 29. content_rev on incidents: re-score without duplicating, retire without lying

`Behaviour` · `CISO` · **M** · exact · unscored

`anomalies` gains `content_rev` (the pack revision that first produced the row) and
`rescored_rev`; `anomaly_key` deliberately excludes both, because including the pack version
duplicates every open incident on every bump, while the row must carry it or an incident that
appears with no new activity is unexplainable. Re-scoring rides the escalation channel that has to
exist anyway to fix db.ts:137, where `INSERT OR IGNORE` freezes severity and observed at first
sight: a newer pack scoring the same window higher widens severity/observed/rescored_rev, a newer
pack scoring it lower changes nothing and records `rescore_declined`.

**In the app** — Incident detail gains a provenance line "fired by dlp_detectors 2026.08.11, re-
scored by 2026.09.03" beside the observed/baseline/threshold figures; the incident feed tags rows
whose content_rev postdates their own window as `retro`;

**Source** — anomalies table (schema.ts); content_packs.version read at detection time;

**Limit** — Only windows whose events are still in usage_events can be re-scored; older incidents
keep the verdict the pack of the day produced and are labelled with it, so a threshold change is
never retroactive across the whole history.

### 30. recipient resolution: the model name is not the recipient

`Governance` · `Platform` · **M** · exact · unscored

The brief proposes keying the register on 'endpoint host and model-id shape', and on this machine
that keying is actively wrong: 456 rows carry model `anthropic/claude-
ccr-h7177656e2f7177656e332e382d3237622d667038`, whose hex alias decodes to a qwen model served
from `http://195.242.30.141:30000/v1` — a cleartext raw-IP endpoint in an unnamed country that the
model string calls 'anthropic'. Equally, 2,275 rows read `github-copilot/claude-opus-4.6`: an
Anthropic model whose recipient is GitHub/Microsoft, with Anthropic as a downstream sub-processor.

**In the app** — A recipient chip on every Leak Ledger row coloured by state, and a 'Recipients'
lane on the Blast Radius screen grouping the four states with counts; broker rows expand to show
'chain truncated at hop 1 — downstream provider chosen per request by the broker' rather than a
vendor name.

**Source** — ~/.vole/vole.db usage_events.model, ~/.claude-code-router/config.sqlite
app_config.value_json (base URLs: http://195.242.30.141:30000/v1, https://openrouter.ai/api/v1),
model_routes alias map, ~/.local/share/opencode/opencode.db message.data.providerID

**Limit** — Where no route record exists, the state is `unattributable` and stays there — Vole
will not name a vendor from a model string. A broker's downstream provider is chosen per request
server-side and is unknowable from disk, so `broker_truncated` is a permanent ceiling, not a
backlog item.

*Extends the earlier entry "model_routes: resolving the local gateway's alias map, and the two
rules it exposes".*

### 31. Hunt-time fingerprinting: the pack carries the burned value, the store never does

`Data exposure` · `CISO` · **M** · exact · unscored

An advisory that names a leaked credential publishes the value; Vole stores only HMAC-SHA256
fingerprints under a per-install Keychain key, so the two can never be compared unless the
fingerprint is computed here, at hunt time. The pack (admin trust class only) carries the already-
public value in memory;

**In the app** — On the Data Exposure screen, an "advisory match" band on a finding: which epoch
matched, first and last sighting, the sinks it reached, and the rotation state from the existing
credential-liveness sweep — with a visible "value not stored" receipt naming the verify --content
run that proved it.

**Source** — secret_sightings (fingerprint, epoch, detector id, sink, raw_ref byte offset);
Keychain-held fingerprint key with epoch rotation;

**Limit** — Matching can only find what was already a sighting: a credential shape no shipped
detector recognised was never fingerprinted, so a negative here means "no fingerprint of this
exists", not "this key was never in a transcript".

### 32. Successor window: the "and what happened next" half of the question

`Authority` · `CISO` · **M** · exact · unscored

A hit answers "were we exposed" and "when"; the security team's next sentence is always "and what
did it do". For each hit the hunt runs a bounded join forward from the matched evidence row — same
session_id and the agent tree via agent_edges, default 30 minutes, declared on the view and never
inferred — across context_edges and egress hosts, first-seen secret_sightings, action_targets
remote writes, package executions, VCS actions, and the four-state authority of every tool call in
between;

**In the app** — An ordered strip beneath each hit on the hunt result — minute offsets on one
axis, one chip per consequence, tinted by authority state — with the window length printed on the
strip itself and a fixed "adjacency, not causation" caption; each chip opens the just-in-time
evidence viewer at the byte offset.

**Source** — tool_calls with authorization_basis; context_edges and the egress ledger;

**Limit** — Nothing here is causal, and the caption must say so: the window is a time filter, so
widening it strictly widens the noise and every count is printed with its window length.

### 33. Xcode bundled Claude Code posture: skip-permissions by default

`Behaviour` · `CISO` · **M** · partial · 4/5

The consequence of the multi-root gap, and the reason it matters more than a coverage percentage:
Xcode's embedded Claude Code runs from its own config dir and, per the
`IDEChatAgenticChatSkipPermissions` default, is launched with `--dangerously-skip-permissions`.
Read `~/Library/Preferences/com.apple.dt.Xcode.plist` for that key (binary plist, so `defaults
read` / `plutil -convert xml1 -o -` spawn), and when it is true write an `autonomy_intervals` row
with `autonomy='full_auto'`, `granted_by='xcode_default:IDEChatAgenticChatSkipPermissions'`
covering every session in that home — an autonomy grant that no human ever clicked.

**In the app** — The Agent-homes list in Settings shows a red badge on any home whose posture is
full_auto by default rather than by user action; the session list shows those sessions with a
'permissions skipped (Xcode default)' chip, and the incident feed carries one info row the first
day it is seen.

**Source** — ~/Library/Preferences/com.apple.dt.Xcode.plist key IDEChatAgenticChatSkipPermissions;
~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig/projects/**/*.jsonl permissionMode
stamps.

**Limit** — Verified on this machine: both the CodingAssistant directory and the preference key
are absent, and `defaults read` returns 'does not exist' — so the correct stored value is NULL,
never `false`, since Xcode's own default may differ from an unset key and may change between
builds.

*Related to the earlier entry "Permission-mode and sandbox posture per session (normalised
autonomy column)".*

### 34. Native-telemetry and prompt-logging posture per agent

`Posture` · `CISO` · **S** · partial · 5/5

Before Vole exports anything, a security team needs to know whether the agents are already
shipping telemetry somewhere unmanaged - and whether that telemetry includes prompts. Read the
settings layers as a snapshot: ~/.claude/settings.json, settings.local.json and the managed-
settings path for CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_EXPORTER_OTLP_ENDPOINT / PROTOCOL / HEADERS
(key names and host only, never header values) and OTEL_LOG_USER_PROMPTS / OTEL_LOG_TOOL_CONTENT;
~/.codex/config.toml [otel] exporter;

**In the app** — Posture > a per-tool telemetry card reading 'native telemetry: on/off, endpoint
<host>, prompt logging: ON' with the file and key that decided it, and a link into Supply Chain >
History when a backup shows the flag was different before.

**Source** — ~/.claude/settings.json and settings.local.json (verified present);
/Library/Application Support/ClaudeCode/managed-settings.json;

**Limit** — Config files are a snapshot of now and must never be stamped onto historical rows - a
flag flipped yesterday says nothing about last week, and only backup replay recovers earlier
states.

*Extends the earlier entry "Vendor telemetry and upload posture report".*

### 35. os_grants: which AI app can read the screen and the keystrokes

`Authority` · `CISO` · **M** · partial · unscored

For a non-engineer, the most literal version of 'an agent read data from my system without
permission' is an AI desktop app holding Screen Recording and Accessibility — it sees every window
and every keystroke with no tool call, no MCP server and no agent transcript to parse. Open
/Library/Application Support/com.apple.TCC/TCC.db and ~/Library/Application
Support/com.apple.TCC/TCC.db read-only and select from table `access`: service, client,
client_type, auth_value, auth_reason, last_modified, filtered to kTCCServiceScreenCapture,
kTCCServiceAccessibility, kTCCServiceListenEvent, kTCCServicePostEvent,
kTCCServiceSystemPolicyAllFiles and kTCCServiceMicrophone.

**In the app** — Posture screen, OS band, plus a Blast Radius entry per AI app: the systems this
application can reach with no agent, tool call or network of its own, sorted by asset tier like
every other Blast Radius row.

**Source** — /Library/Application Support/com.apple.TCC/TCC.db and ~/Library/Application
Support/com.apple.TCC/TCC.db, table `access` (service, client, client_type, auth_value,
auth_reason, last_modified), opened read-only and joined by bundle id to the installed AI-app
census

**Limit** — Verified on this machine that BOTH TCC databases refuse to open without Full Disk
Access ('authorization denied'), so without FDA every column is NULL and the attempt is a counted
scan_access denial — never a zero and never an empty list rendered as 'no grants'.

### 36. terms_basis: the contract tier that selects the terms, measured per surface

`Governance` · `DPO` · **M** · exact · unscored

The register cannot be keyed on the auth path alone — a personal OAuth login and a Max
subscription and an enterprise seat all look like 'OAuth' to the account-class classifier, yet
they sit under three different vendor agreements.

**In the app** — A 'Plan' column on the Shadow AI screen and on each surface card in People view,
showing the plan token verbatim beside its source file; clicking it opens the evidence drill-down
with the file path and the first/last-seen dates.

**Source** — ~/.claude.json (oauthAccount.*), ~/.codex/sessions/**/rollout-*.jsonl
(token_count.rate_limits.plan_type), ~/.grok/logs/unified.jsonl
(paywall_check_result.ctx.subscription_tier), ~/.local/share/opencode/account.json
(accounts[].serviceID, credential.type), Claude transcript bridge-session lines
(ownerOrganizationUuid)

**Limit** — A plan token is what the client last cached, not what billing says today;
~/.claude.json is rewritten on login so a mid-window plan change leaves only the newer value, and
the first_seen date is the first time Vole saw it, not the date the plan started.

*Extends the earlier entry "Account-class classifier from the auth path".*

### 37. Grant and override ledger: which file granted this authority, and what weakens the guardrails

`Posture` · `CISO` · **L** · partial · 5/5

One posture_grants table answering both halves of 'who gave the agent this authority'. First,
resolve each autonomy interval against the settings precedence chain, highest first -
/Library/Application Support/ClaudeCode/managed-settings.json (absent here),
~/.claude/settings.json (skipDangerousModePermissionPrompt=true here, a host-level do-not-even-ask
flag), ~/.claude/settings.local.json, the repo's own .claude/settings.local.json, ~/.claude.json
projects[cwd].allowedTools - and store the winner as granted_by with a path_class of managed /
user / project / repo_controlled / unknown.

**In the app** — Supply Chain > Grants: a 'where the autonomy came from' table (one row per grant
source with its class, the keys it sets, how many sessions it covered, red flag on repo-controlled
sources) above an Overrides table grouped by agent, each row printing the literal key = value, the
file it came from and a scope column (global / per-project / per-account), with home-directory and
wildcard scopes flagged amber.

**Source** — /Library/Application Support/ClaudeCode/managed-settings.json;
~/.claude/settings.json (verified: permissions.allow 9 entries,
skipDangerousModePermissionPrompt=true, remoteControlAtStartup=false, effortLevel xhigh);

**Limit** — The CLI invocation appears in no log, so a session launched with --dangerously-skip-
permissions and one switched with /permissions at the first turn are indistinguishable; when no
settings file explains the observed posture, granted_by is 'unknown' and the panel says so rather
than guessing a flag.

*Extends the earlier entry "Permission allowlist and managed-settings posture; Workspace trust and
repo-controlled permission exposure".*

### 38. detection_epochs: rules have a birthday, and an empty history has to say which kind of empty it is

`Governance` · `DPO` · **S** · exact · unscored

A retro-hunt applies today's knowledge to yesterday's evidence, which makes "no incidents before
March" ambiguous between nothing happened and nothing was looking. Adds `detection_epochs(rule,
content_rev, evaluated_from, evaluated_to, first_run_at)`, written by the same insert-gated
detection pass that already keeps scan cursors, and extended backwards only as far as a hunt or
pack-bump re-scan genuinely scanned. Backdated incidents keep the constraint intact — `anomaly_key
= rule:indicator_id:evidence_row_identity`, never now() — while `window_start` carries when it
happened and `detected_at` when it was found, plus a basis string ("found by hunt run 41 on 7 Sep;

**In the app** — A left-hand cutoff marker on every rule's history sparkline, and a line in the
incident detail sheet separating occurred-at from evaluated-at so a months-old incident that
surfaced today cannot be misread as a months-old alert nobody acted on. Feeds the same two dates
into the evidence bundle.

**Source** — detect pass scan cursors; content_packs registry and content_rev on incidents;

**Limit** — An epoch proves a rule ran over an interval, not that the evidence the rule needed
existed in it — it must be read beside answerable_from, and the two will legitimately disagree
when a rule was evaluated over a window whose sources were already pruned. It also cannot speak
for rules that were never shipped at all.

### 39. Workspace-trust transitions and untrusted-execution rule

`Posture` · `CISO` · **M** · exact · 4/5

Snapshot ~/.claude.json projects[<cwd>].{hasTrustDialogAccepted, allowedTools, mcpServers,
enabledMcpjsonServers, hasClaudeMdExternalIncludesApproved,
hasClaudeMdExternalIncludesWarningShown} into workspace_trust each poll - 23 projects here, 14
with hasTrustDialogAccepted=false - alongside Codex [projects.*].trust_level and OpenCode
session.directory, and own the transitions the static override ledger cannot see.

**In the app** — Supply Chain > Workspaces: a table of directory class, trust state, MCP servers
enabled from repo config and tool calls executed, with a timeline strip of trust flips per
workspace; a flip inside the fresh-clone window renders as a critical incident card quoting both
poll timestamps.

**Source** — ~/.claude.json projects[*].{hasTrustDialogAccepted, allowedTools, mcpServers,
enabledMcpjsonServers, hasClaudeMdExternalIncludesApproved,
hasClaudeMdExternalIncludesWarningShown}; .git/ birthtime of the cwd;

**Limit** — ~/.claude.json is a single mutable JSON file with no change history, so Vole can only
report 'this key differed between poll N and poll N+1' and cannot attribute the change to a
session or a person unless a tool call in the same interval named the file; a flip and flip-back
inside one poll interval is invisible.

*Extends the earlier entry "Workspace trust and repo-controlled permission exposure".*

### 40. Policy screen: effective rule thresholds with provenance, read-only by design

`Governance` · `Platform` · **M** · partial · 3/5

Render ~/.vole/policy.json and the built-in defaults side by side: for each rule show window,
group key, gates, fire and critical thresholds, and where the effective value came from — module
default, policy.json global, or a scoped override — plus the sanctioned-agent, sanctioned-model
and MCP-server allowlists that the Agents and Posture screens compare against. The app stays a
read-only consumer: it explains, diffs and copies a proposed JSON patch and offers Reveal in
Finder rather than writing the file behind the operator's back.

**In the app** — A Policy screen listing rules with their effective values and a provenance chip
per value; an Allowlists section for agents, models and MCP servers;

**Source** — ~/.vole/policy.json (the Tier-1 RuleConfig); detect module constants burn-
rate.ts:4-7, loop.ts:4-8, error-storm.ts:4-6, rate-limit.ts:4-5, context-pressure.ts:5-7;

**Limit** — The screen reflects the policy file this machine reads — under MDM the authoritative
copy is a managed preference and a local edit may be overwritten silently, which the screen must
label 'managed by your administrator'. It shows configured thresholds, not enforcement: nothing
here prevents an agent from doing anything.

*Extends the earlier entry "RuleConfig contract, effective threshold in every incident,
conformance tests".*

### 41. MCP server-instruction rug-pull detector

`Posture` · `CISO` · **M** · exact · 4/5

Claude Code persists the full text every MCP server injects into the system prompt: attachment
entries of type mcp_instructions_delta carry addedNames[] and addedBlocks[] - 665 occurrences
across 622 transcripts here, containing the complete context7 and github instruction blocks
verbatim. A posture_injected_text table stores (source, mcp_identity, server_name, block_sha256,
block_len, first_seen, last_seen, session_count) - hash and length only, never the text - and
mcp_instructions_changed fires when a stable mcp_identity emits a new block_sha256, quoting both
hashes, both lengths, both dates and the intervening agent version.

**In the app** — Supply Chain > MCP row expands to an 'injected instructions' sub-row: current
hash, length in characters, the sessions it was injected into, and a change-history strip; a
changed hash renders as a critical incident card carrying both hashes, both lengths and the two
dates.

**Source** — ~/.claude/projects/**/*.jsonl entries where type='attachment' and
attachment.type='mcp_instructions_delta' (fields addedNames, addedBlocks, removedNames), joined to
posture_mcp_servers.mcp_identity by server name within the same session's client config.

**Limit** — This is server INSTRUCTIONS, not per-tool descriptions: the poisoned-description
variant of the attack (a single tool's description carrying hidden directives) is not in this
field, Claude Code does not persist per-tool schemas, and Codex thread_dynamic_tools remains the
only place that variant is visible.

*Corrects the earlier entry "Offline injection-indicator scans: MCP tool descriptions and ingress
content; System-prompt and injected-context census".*

### 42. processing_terms pack with an as-of-the-evidence lookup, not an as-of-today one

`Governance` · `DPO` · **L** · partial · unscored

A vendor-signed content pack (existing content_packs trust classes, preflight and checksum path
unchanged) whose entries carry legal entity, processing region(s), trains-on-input default,
retention default, sub-processor status, the plan condition that changes them, a citation URL and
an `asserted_as_of` date — plus, critically, `in_force_from`/`in_force_to`, so the resolver
`termsAsOf(recipient_id, plan_token, evidence_ts)` returns the terms that were published when the
bytes moved, not the terms published today.

**In the app** — A 'Processing Register' section under Privacy Center: one row per recipient with
entity, region, training default, retention, each cell footnoted 'vendor's published default, in
force <from>–<to>, cited <url>'.

**Source** — ~/.vole/packs/processing_terms.<version>.json (vendor-signed, offline checksum),
joined to dlp_egress rows and terms_basis; citations are URLs recorded in the pack, never fetched

**Limit** — Every field is a dated assertion with a citation, not a measurement — Vole cannot
verify what a vendor does with received bytes, and a vendor that quietly changes a default between
pack releases leaves a window Vole will describe with the older entry until the bump lands. The
pack is only as complete as its authors;

### 43. Instruction-file hidden-Unicode scan and include graph

`Posture` · `CISO` · **M** · exact · 4/5

Track every instruction file an agent may load - repo-root CLAUDE.md and AGENTS.md, .cursorrules,
.cursor/rules/**, GEMINI.md, copilot-instructions.md, plus the installed plugins' own AGENTS.md -
with sha256, byte length and mtime, and run one codepoint-class scan over each: zero-width
(U+200B-U+200F), bidi overrides (U+202A-U+202E, U+2066-U+2069), Unicode Tags (U+E0000-U+E007F),
soft hyphen (U+00AD) and BOM-in-body. Findings store (file, class, codepoint, count, line_no) and
never the surrounding text.

**In the app** — Supply Chain > Instructions: a table of files with size, last-changed, an
include-count column and a hidden-codepoint column reading em-dash when clean; a hit opens a
detail card naming the codepoint, its count and the line number, with 'text not stored' printed
underneath;

**Source** — CLAUDE.md / AGENTS.md / .cursorrules / .cursor/rules/** / GEMINI.md / copilot-
instructions.md under project cwds already seen in transcripts; ~/.claude/plugins/**/AGENTS.md;

**Limit** — Zero-width and bidi codepoints have legitimate uses (RTL text, emoji ZWJ sequences),
so a hit is a flag for human review at warn severity and never a verdict.

*Extends the earlier entry "Instruction-file inventory, drift and load evidence".*

### 44. declared_dpa_scope_mismatch: the agreement you rely on does not cover the account that ran

`Governance` · `Procurement` · **M** · partial · unscored

The register must accept an admin override for a negotiated DPA, and the override is where a
compliance tool most easily starts lying. This adds `terms_overrides` under the admin-authored
trust class (never vendor-signed, never silently merged into pack rows) with a required `covers`
predicate naming the vendor, the contract_scope and, where the vendor exposes one, the org
identifier.

**In the app** — A red 'outside your DPA' banner on the Processing Register row, with the declared
scope and the measured scope printed as two adjacent figures and a link to the sessions that fall
outside; the override itself renders with an 'admin-authored by <principal> on <date>' byline
everywhere it appears.

**Source** — ~/.vole/policy/terms_overrides.json (admin-authored, preflight-validated) joined to
terms_basis (~/.claude.json oauthAccount.organizationType, Codex rate_limits.plan_type, Grok
subscription_tier)

**Limit** — Vole cannot read the contract; it compares an admin's declaration against the plan
tokens the clients cached, and both can be stale.

### 45. Plugin declared-capability tier from the marketplace catalog

`Posture` · `CISO` · **S** · exact · 4/5

The same `~/.claude/plugins/plugin-catalog-cache.json` lists, per plugin, `components:{commands,
agents, skills, hooks, mcpServers, lspServers}` — the vendor's own declaration of what the
extension is allowed to do. Derive a capability tier per enabled plugin: declaring hooks,
mcpServers or lspServers means the plugin executes code or opens a transport and is high tier;
skills and commands only is low tier.

**In the app** — Supply Chain → Plugins shows a capability tier badge per installed plugin with
the declared component counts, the catalog sha and fetchedAt it came from, and a diff marker when
the tier changed since the last recorded sha.

**Source** — ~/.claude/plugins/plugin-catalog-cache.json
plugins[].components.{commands,agents,skills,hooks,mcpServers,lspServers},
plugins[].unique_installs, catalog.marketplace_sha, fetchedAt (all verified present).

**Limit** — This is a declaration in a cached vendor catalog, not an observation of behaviour — a
plugin that declares no hooks may still ship code that runs via a skill, and a plugin declaring
hooks may never fire one. Marketplace plugins only: locally installed and inline plugins have no
catalog entry and must render as 'not in catalog' rather than as low tier.

*Related to the earlier entry "Hook inventory and execution ledger".*

### 46. residency_evidence with a ranked chain, and an inference_geo that is honestly empty

`Governance` · `DPO` · **M** · partial · unscored

Where the processing happened gets four ranks and never a flag emoji below the top two:
`vendor_stated` from Claude's own `usage.inference_geo` field, `route_declared` from a Bedrock
cross-region inference-profile prefix on the model id (`us.`/`eu.`/`apac.`/`us-gov.`) or a
Vertex/Foundry region in the settings env snapshot, `pack_default` from processing_terms, and
`unknown`. The honest headline is that `inference_geo` is present on 40,088 assistant lines here
and says `"not_available"` on 34,871 of them and `""` on 5,087 — so the field that would settle
the question is, on this account, empty.

**In the app** — A 'Region' column on the Processing Register and Leak Ledger whose cell always
shows the rank badge beside the value; `pack_default` renders in italic with the pack date,
`unknown` renders an em dash.

**Source** — Claude transcripts: assistant line usage.inference_geo (verified present, values
not_available/empty); usage_events.model prefix;

**Limit** — On this machine every inference_geo value is `not_available`, so the top rank is
currently unreachable for Claude — the feature must ship being visibly empty rather than falling
back to a guess. Zero Bedrock rows exist here, so the geo-prefix parser is untested against real
traffic and degrades to NULL.

### 47. Plugin and marketplace provenance with cross-agent blast radius

`Posture` · `CISO` · **M** · partial · 4/5

One walk of the installed plugin trees plus the marketplace registries answers both where a plugin
came from and how far a single approval reaches. posture_marketplaces(source, name, source_type,
source_url, pinned_revision, install_location, last_updated) is filled from
~/.claude/plugins/known_marketplaces.json, plugin-catalog-cache.json, ~/.claude/settings.json
extraKnownMarketplaces, ~/.codex/config.toml [marketplaces.*] and ~/.grok/config.toml
[[marketplace.sources]]; posture_plugin_targets(plugin_id, marketplace_url, git_sha, target_agent,
manifest_file, component_kind) is filled from the manifests each installed tree ships.

**In the app** — Supply Chain > Plugins: a card per plugin listing target agents as icon chips and
declared component kinds (hooks / MCP / skills / commands / scripts) with a 'reach: 5 agents'
figure, above a Marketplaces table of source-type icon, URL or path, pinned revision short-sha,
last-updated date and a warning chip on user-writable local sources;

**Source** — ~/.claude/plugins/installed_plugins.json (installPath, version, installedAt,
gitCommitSha), known_marketplaces.json (source.url, installLocation, lastUpdated), plugin-catalog-
cache.json; the installed tree's hooks/*.json, *-extension.json, opencode.json, plugin.json,
plugin.yaml, ponytail-mcp/;

**Limit** — Reach is what the package DECLARES, not what a given agent loaded - a copilot-
hooks.json in the tree proves intent to target Copilot, never that Copilot read it - and Vole
cannot see plugins installed into agents it has no collector for.

*Extends the earlier entry "Plugin, skill and marketplace supply-chain inventory".*

### 48. Vendor retention clock: is the vendor's copy still inside its own stated window

`Governance` · `DPO` · **S** · partial · unscored

Once a leak row has a resolved recipient and a pack retention default, the actionable question is
whether a deletion request is still worth sending. For each secret_sighting or dlp_egress row this
computes `deletion_window_ends_at = evidence_ts + retention_days(recipient, contract_scope,
in_force_at(evidence_ts))` and sorts an incident worklist into 'inside the vendor's published
window — deletion request actionable until <date>' and 'window elapsed — deletion unverifiable'.

**In the app** — A 'Deletion window' column on the Leak Ledger with a stepped chip
(14d/7d/48h/elapsed/uncomputable) and a sort control; the incident detail card prints the
arithmetic — evidence date, retention days, in-force pack entry, resulting date — as the figures
that fired.

**Source** — secret_sightings.first_seen / dlp_egress.ts joined to processing_terms
retention_default via the as-of resolver and terms_basis.contract_scope

**Limit** — Retention days are the vendor's published default, not a measurement, and a vendor
legal hold, an abuse investigation or a training snapshot taken during the window all outlive it
invisibly. Vole cannot confirm a deletion happened, only that a request falls inside a stated
window.

### 49. Package execution ledger: installs, fetch-and-run, and registry provenance

`Posture` · `CISO` · **M** · exact · unscored

The entry vector for Nx, the Keyv worm, postmark-mcp and Agentjacking is an agent running a
package command, and `npx` matters more than `install`: it fetches and executes with no install
record and no lockfile line.

**In the app** — A Supply Chain table on the Posture screen with one row per package: ecosystem,
spec, pinned badge, registry host, mode, first seen, and the sessions that ran it; a cacache
column shows the corroborating fetch date and integrity prefix or an em dash.

**Source** — Bash/exec command strings; ~/.npm/_npx/*/package.json;

**Limit** — cacache proves this machine fetched a version, never that this agent's command caused
that fetch — the two are correlated by time and reported as corroboration, not as the same event.
A package already in node_modules or in the pnpm store produces no fetch record at all, so absence
is not evidence.

*Extends the earlier entry "MCP server inventory, trust posture, usage diff and pin/sign rules
(mcp_unpinned_package)".*

### 50. work_roots: the root registry, with git as an attribute and not the identity

`Posture` · `Platform` · **M** · exact · unscored

Discovery-only registry built from evidence Vole already holds, never a filesystem crawl: distinct
usage_events.project values, ~/.codex/state_5.sqlite project_roots.path and
threads.{cwd,git_origin_url}, ~/.claude.json githubRepoPaths and projects[] keys, and
~/.claude/projects/<slug> directory names used as an existence hint only. Each candidate cwd is
resolved upward to the nearest ancestor holding a .git entry (dir or gitdir-pointer file) to give
root_kind='git_repo'; when no ancestor has one the cwd itself is the root with
root_kind='work_dir', and $HOME plus an enumerated system-path list are never roots by
construction.

**In the app** — Posture screen gains a Repos band listing every root with its kind chip (git repo
/ work dir / scratch / gone), origin slug or an em dash, last agent activity, and the cwd count
folded under it; clicking a root opens the artifact ledger drill-down (F2).

**Source** — usage_events.project (58 distinct live values); ~/.codex/state_5.sqlite tables
project_roots.path (7 rows) and threads.{cwd, git_origin_url} (33 of 63 threads carry an origin);

**Limit** — A root Vole never observed an agent run in is invisible, so the registry is a lower
bound and every figure must print its denominator. The Claude slug is not reversible — '-Users-
shiva-Developer-landing-new' could be Developer/landing-new or Developer/landing/new — so slugs
prove a root existed, never which path it was;

*Corrects the earlier entry "Repo identity and attribution keys (repo slug, team, ticket)".*

### 51. Bounded repo sweep: a declared manifest, a per-pass byte budget, and a receipt

`Posture` · `Platform` · **M** · exact · unscored

A scanner that may only open files named literally in a shipped repo_artifact_manifest (a
content_packs kind, so it versions and validates offline like the detector pack):
.claude/settings.json, .claude/settings.local.json, .claude/hooks/*, .claude/skills/*/SKILL.md,
.mcp.json, .cursorrules, .cursor/rules/**, .cursor/mcp.json, .github/copilot-instructions.md,
AGENTS.md, CLAUDE.md, GEMINI.md, .devcontainer/devcontainer.json, .continue/config.yaml,
.clinerules, .roomodes, .vscode/settings.json, .git/hooks/<name> excluding *.sample. readdir is
permitted only on the manifest's declared directory prefixes at the manifest's declared depth;

**In the app** — Each Repos-band row expands to an artifact list — kind, relative path, bytes,
mtime, first seen — with a footer receipt reading 'read 88 KB across 12 files in 3 roots, 0
skipped over budget, manifest v3'.

**Source** — The declared relative paths above under each work_roots.root_path; measured here:
.claude present at 3 roots, <redacted-local-path> = 88 KB / 12 files
including skills/apple-hig/references/*.md;

**Limit** — A sha256 proves drift, never intent — an identical hash means unchanged bytes, not a
benign file. A root that is unreadable (permissions, unmounted volume, a container-only path)
records state 'unreadable', never 'clean'.

### 52. tracked_state from .git/index, not from git ls-files or .gitignore

`Posture` · `CISO` · **S** · exact · unscored

Parse <root>/.git/index directly — the DIRC header, version, entry count, and entry path names
only, never a blob — to answer whether each repo_artifacts row is in the staged tree, and cache
the answer against the index's own mtime and size so an unchanged index is not re-parsed. No git
subprocess is spawned, so the answer works with git absent from PATH, cannot mutate the repo, and
needs no per-repo opt-in for a spawn. Adds tracked_state ∈ {tracked, untracked, unknown} on every
repo_artifacts row plus index_mtime/index_size on repo_scan_state.

**In the app** — A tracked/untracked chip on every artifact row in the Repos-band drill-down, with
'unknown' rendered as an em dash and a tooltip naming the reason (no .git, index version
unsupported, index unreadable).

**Source** — <root>/.git/index (verified DIRC v2 here: 9,922 B in vole, 87,225 B in platform);
<root>/.git/HEAD for the ref label;

**Limit** — The index is the staged tree on this laptop — not HEAD, not origin. A file tracked
here may never have been committed or pushed, so tracked_state bounds blast radius upward and
never proves distribution.

*Corrects the earlier entry "Agent wrote a secret to disk (tracked vs ignored) / Workspace trust
and repo-controlled permission exposure".*

### 53. agent_config_with_dependency: the Keyv-worm shape, joined to the install ledger

`Posture` · `CISO` · **M** · exact · unscored

Fire when a repo_artifacts row of kind claude_settings, claude_hook, mcp_json, vscode_settings or
git_hook first appears in a root inside the window of a package-execution row for that same root,
and the root's lockfile sha changed across the same boundary — the exact shape of the Keyv npm
worm, which planted Claude Code and VS Code hooks in 353-868 poisoned packages that execute once a
workspace is trusted. The lockfile is added to the manifest as a hash-only artifact kind (package-
lock.json, pnpm-lock.yaml, yarn.lock, Cargo.lock, uv.lock: name, bytes, mtime and sha256, never
contents).

**In the app** — An incident card on the Behaviour feed reading 'a .claude/settings.json first
appeared in <root> during npm install at <ts>; package-lock.json sha changed in the same window',
with jumps to the install row in the package-execution ledger and to the artifact row in the Repos
band.

**Source** — repo_artifacts.first_seen and sha256 per root; the covered package-execution ledger's
install rows and their cwd;

**Limit** — first_seen is Vole's first observation, not the file's creation, which is why the
prior-clean-pass gate exists and why the incident text says 'first observed', never 'created'.
mtime is writer-controlled and can be back-dated, so it is corroboration and never proof.

### 54. Root tombstones: the clone that is gone and the hash that can never be re-verified

`Posture` · `CISO` · **S** · exact · unscored

When a known root stops resolving on disk, set work_roots.exists_now=0 and disappeared_at, freeze
every repo_artifacts row for it with verifiable=0 and a preserved last_verified_at, and fire
root_not_present keyed (root_id, disappeared_at_day) at info severity so it lands once per root
instead of once per poll.

**In the app** — Gone roots render in the Repos band greyed with a 'not present since <date>' chip
and a 'last verified <date>' line on each of their frozen artifact rows; the evidence-bundle
preview shows the tombstone count inline with any repo-artifact claim.

**Source** — work_roots.root_path existence probe (a single stat per root on the discovery
cadence); repo_artifacts.last_seen;

**Limit** — Gone is not deleted. An unmounted external volume, a renamed directory, a container-
only path (/private/tmp/claude-501/...

### 55. MCP registered-vs-observed call and spend join

`Posture` · `CISO` · **S** · partial · 4/5

The half of MCP visibility no scanner has: cross-join posture_mcp_servers.mcp_identity to observed
`mcp__<server>__<tool>` calls in usage_events.tools (and the Tier-1 tool_calls ledger once it
lands) to produce, per registered server, calls, sessions, tokens, cost_usd where priced, and the
set of registrations with no observed call. Every inventory row gains a used/dormant chip and the
dashboard gains a by-MCP-server grouping.

**In the app** — Dashboard > Breakdown gains a 'by MCP server' grouping (calls, sessions, tokens,
cost, unpriced-call count); each Supply Chain > MCP row shows a used/dormant chip and a calls-per-
day sparkline, and clicking it filters the tool ledger to that server's calls.

**Source** — posture_mcp_servers.mcp_identity joined to usage_events.tools LIKE 'mcp__%' (and
tool_calls.name once the Tier-1 ledger exists); usage_events token columns and cost_usd for the
spend side.

**Limit** — Entirely dependent on the tools column, which is NULL on 7,108 rows whose stop_reason
is tool_use, so every count is a floor until the tools-union fix lands, and six of the seven
collectors do not record tool names at all. The chip must therefore read 'no call observed in
range on this machine', never 'unused' - absence of a call is not absence of use.

*Corrects the earlier entry "MCP server inventory, trust posture, usage diff and pin/sign rules".*

### 56. Agent and AI-app binary signing ledger (TeamID, CDHash, ad-hoc)

`Posture` · `CISO` · **L** · partial · 4/5

For every executable behind a collected agent and every AI app in the surface registry, resolve
the real binary (`which` + readlink for CLIs, Contents/Info.plist CFBundleExecutable for .app
bundles) and run one read-only `codesign -dv --verbose=4`, parsing Identifier, TeamIdentifier, the
first Authority line, CDHash, hardened-runtime and the adhoc/linker-signed flags into
posture_binaries(source, kind, tool, path, version, signing_id, team_id, authority, cdhash,
hardened_runtime, signature_kind, first_seen, last_seen), cached on (path, size, mtime) so
codesign only re-runs when the file actually changes.

**In the app** — Supply Chain > Binaries: one row per resolved executable with a signature chip
(Developer ID / ad-hoc / not applicable / unknown), Team ID, authority string, short CDHash,
resolved path and version;

**Source** — `which <agent>` plus readlink resolution; .app Contents/Info.plist
CFBundleExecutable;

**Limit** — codesign is a subprocess, not a file read - the first external tool Vole shells out to
- so it needs its own consent entry, a slow cadence, and must degrade to signature_kind='unknown',
never 'unsigned', when the tool is absent or exits non-zero. npm-installed JS CLIs run under an
unsigned interpreter and are recorded signature_kind='not_applicable';

*Extends the earlier entry "MCP server inventory, trust posture, usage diff and pin/sign rules
(mcp_unsigned_binary); Agent runtime inventory (agent SBOM)".*

### 57. Shipped offline advisory floor table (version-vs-CVE, no network)

`Posture` · `Platform` · **M** · exact · 3/5

Ship a dated data/advisories.json alongside data/pricing.json - {tool, cve, fixed_in[],
affects_range, title, url, published, class} - frozen into the SEA at build time exactly as
pricing.json is, and join it to the version already stamped on every row. Claude Code writes
`version` on every transcript line (15 distinct versions here, 2.1.215 through 2.1.263, with
2.1.234 / 2.1.251 / 2.1.263 retained under ~/.local/share/claude/versions/); ~/.claude/.last-
update-result.json records {version_from: 2.1.251, version_to: 2.1.263, outcome: success};

**In the app** — Supply Chain > Versions: a bar per agent showing sessions by version in range
with versions below a floor shaded red; each advisory row shows CVE id, fixed-in floor, sessions
affected, and the footer reads 'advisory data as of <date>, from <file>'.

**Source** — data/advisories.json shipped in the build, overridable by ~/.vole/advisories.json
exactly as pricing.json is; ~/.claude/projects/**/*.jsonl `version`;

**Limit** — The table is only as current as the Vole build: it can never claim a version is safe,
only that no shipped advisory names it, and the UI must read 'no advisory data' rather than
'clean'. Vole makes no network call to refresh it;

*Corrects the earlier entry "Agent runtime inventory (agent SBOM) and runtime_behind_local_max".*

### 58. Version residency: the exposure interval an advisory's affected range actually intersects

`Posture` · `CISO` · **M** · exact · unscored

Five of the 27 dated incidents are version-bounded (Gemini CLI <0.1.14, Cursor <1.3.9 and <3.0,
Amazon Q 1.84.0, Claude Code fixed in 1.0.93/1.0.105/1.0.111), and every one of them is answered
by an interval, not by today's version. Claude Code stamps `version` on every JSONL line (12
distinct versions, 2.1.229 → 2.1.263, in a sample of 80 transcripts on this machine); Codex
carries `session_meta.payload.cli_version`, OpenCode `session.version`, and IDE extension versions
come from the editor's own Settings Sync backups.

**In the app** — A version lane on the annotated timeline — one band per agent version, advisory-
affected bands tinted, click for the session list and the bypass count inside the band. Also a row
on the Posture screen: "you have been on 12 Claude Code versions in the answerable window".

**Source** — version field on every ~/.claude/projects/**/*.jsonl line;
~/.codex/sessions/**/*.jsonl session_meta.payload.cli_version;

**Limit** — An interval is bounded by answerable_from: a version that ran before the oldest
retained transcript is invisible, and the first retained line reports first-observed, not first-
run — rendered as a left-open band, never as a start date. Sessions with no telemetry-bearing line
contribute no version at all.

*Extends the earlier entry "Shipped offline advisory floor table (version-vs-CVE, no network)".*

### 59. Agent reach: the key, the host policy and the forwarded agent that got it out

`Posture` · `Platform` · **S** · exact · unscored

Once an agent can cross to an unmonitored context, the question is what authority it carried
across. Three exact reads, no new instrumentation. From `~/.ssh/config`: per-Host `IdentityFile`,
`ForwardAgent`, `StrictHostKeyChecking` and `ProxyJump` (this machine sets `StrictHostKeyChecking
accept-new` on three of four hosts, meaning any new host is trusted silently).

**In the app** — Posture screen gains a Reach row per context: key class, forwarding state, host-
key policy, all three as the observed-versus-hardened pairs the vendor lever cards already use.
The incident card states the reach in one line — 'this agent used <key class> to reach <label>,
agent forwarding on, host policy accept-new;

**Source** — ~/.ssh/config (Host, IdentityFile, ForwardAgent, StrictHostKeyChecking, ProxyJump,
Include), ~/.ssh/known_hosts (line count only), and `-i` / `-A` / `-o StrictHostKeyChecking`
arguments extracted in the collector's command-shape pass from Claude Code Bash input.command,
Codex local_shell_call and OpenCode tool parts

**Limit** — An `-i <path>` argument proves what was typed, not that the key existed, was accepted,
or was even the key used — ssh may fall back to the agent or to a default identity, and Vole never
opens the key file to check.

*Extends the earlier entry "Sensitive-file access ledger and protected_path_access rule".*

### 60. Retroactive config history replayed from the agents' own rotating backups

`Posture` · `CISO` · **M** · exact · 3/5

Claude Code writes timestamped copies of its own config that Vole can replay to reconstruct
posture history from before Vole was ever installed.

**In the app** — Supply Chain > History: a timeline of config states per file with 'reconstructed
from backup' provenance chips, each entry expandable to the field-level diff; a first-run banner
reading 'N historical states recovered from the tools' own backups';

**Source** — ~/.claude/backups/.claude.json.backup.<epoch_ms>; ~/.claude/settings.json.{bak-pre-
ccr, ccr-original, ccr-backup-<iso>, reset-backup-<iso>};

**Limit** — Backups are a rotating window (5 here, all inside one day) - anything older is gone,
so the history is bounded and must be labelled 'earliest recovered state', never 'first ever
state'. The filename is the only timestamp, and a backup written by a third-party tool such as ccr
carries that tool's clock, not the agent's.

*Related to the earlier entry "Provider endpoint snapshots (time-versioned, keys never read)".*

### 61. Blanket-approval inventory: what each wildcard grant actually authorised

`Posture` · `CISO` · **L** · partial · 3/5

Parse every reachable allow-list - ~/.claude/settings.json permissions.allow (9 entries here),
~/.claude/settings.local.json, each repo's .claude/settings.local.json, ~/.claude.json
projects[*].allowedTools (21 of 23 projects carry one here) and the per-turn
attachment.type='command_permissions'.allowedTools snapshots (130 occurrences across 622
transcripts here) - and classify each entry as exact, prefix_wildcard, tool_wildcard or
mcp_server_wildcard. Then count, per entry, how many calls in the tool_calls ledger that entry
authorised, so the panel answers the only question a security review cares about: how much did
this one rule let through.

**In the app** — Supply Chain > Standing permissions: a sortable table of entry text (masked where
it carries a path or URL), class, scope (user / project / per-turn), calls authorised and a
destructive-class count, with a summary line reading 'N calls authorised by M wildcard rules';

**Source** — ~/.claude/settings.json permissions.allow; ~/.claude/settings.local.json;

**Limit** — Attribution is Vole's own re-implementation of the vendor's matcher and can disagree
with what the vendor actually matched, so the panel prints the matcher version and attributes a
call matched by no entry to posture rather than to a rule. It cannot count anything until the
Tier-1 tool_calls ledger exists;

*Extends the earlier entry "Permission allowlist and managed-settings posture".*

### 62. Dependency key-set delta from the pre- and post-image the transcript already holds

`Posture` · `Platform` · **M** · partial · unscored

For a write classified `dependency`, the collector reconstructs both file images in memory —
`toolUseResult.originalFile` is the pre-image and applying `oldString`→`newString` (or `content`
for a create) yields the post-image — parses each as the manifest it is, and stores only the key-
set delta in a new `dependency_deltas` table: ecosystem, manifest path, package name, old spec,
new spec, section (dependencies / devDependencies / peer / optional) and verb. No regex over diff
lines, so the result is exact rather than best-effort; run against this machine it recovers
`devDependencies + {esbuild, postject}` and `dependencies − {better-sqlite3}` from single Edit
rows.

**In the app** — A 'dependencies this agent added' table on the repo half of Blast Radius: name,
section, spec, the session that added it, and a second column showing whether an install actually
ran, so an unresolved manifest edit reads differently from an executed one.

**Source** — ~/.claude/projects/**/*.jsonl `toolUseResult.{originalFile, oldString, newString,
replaceAll, content, filePath}` on package.json, requirements*.txt, pyproject.toml, go.mod,
Cargo.toml, Gemfile and their lockfiles; joined to round 2's package execution ledger.

**Limit** — Only Claude Code carries a pre-image, so OpenCode `patch` parts give the path and
nothing else and Codex/Grok manifest edits arrive as shell heredocs with no parseable delta —
those rows keep the path class and every name column stays NULL. If either image fails to parse
the row records `parse_failed` and no name is guessed.

### 63. install_hook_added: the lifecycle script the agent planted

`Posture` · `CISO` · **S** · exact · unscored

The same pre/post images, restricted to the keys that execute at install time rather than at run
time: package.json `scripts.{preinstall, install, postinstall, prepare, prepublish, prepack}`,
pyproject `[build-system]` and build-hook tables, Cargo `build`/`build.rs`, a Makefile default
target, and Gradle/Maven plugin blocks. The row stores the key name, a sha256 of the command
string and round 2's command-shape skeleton id — never the command text. `install_hook_added` is
critical by default, because this is the exact rung the Nx s1ngularity postinstall and the
Malware-Slop package used, and because the entry then runs on every teammate's `npm install`
without anyone opening the file.

**In the app** — Pinned to the top of the repo half of 'what the agent left behind', showing the
key name, the command skeleton and the hash, with a copy-as-evidence action that emits the
incident bundle row rather than a screenshot.

**Source** — The same `toolUseResult.{originalFile, oldString, newString, content}` images used by
the dependency delta, keyed on install-time script paths within the parsed manifest.

**Limit** — Benign build wiring dominates — `build:sea` here was entirely legitimate — so the rule
states that an install-time entry point was added and by whom, never that it is malicious. It
cannot see a script added by the editor, by `npm pkg set`, or shipped inside a dependency's own
tarball;

### 64. Devcontainer and compose manifest reader: the agent the image installs, the home it mounts, the bypass it declares

`Posture` · `Platform` · **M** · partial · unscored

Under consented repo roots only, read `.devcontainer/devcontainer.json`,
`.devcontainer/*/devcontainer.json` and a root `devcontainer.json` (JSONC — comments and trailing
commas tolerated by a hand-written stripper, no new dependency), and line-scan
`compose.yaml`/`docker-compose*.yml` for `image:`, `volumes:` and `command:` blocks.

**In the app** — Posture screen gains a Contexts section: one row per manifest with three-state
chips (agent installed / home mounted / bypass declared), the evidence path and a diff badge when
content_hash changes.

**Source** — <repo>/.devcontainer/devcontainer.json and .devcontainer/*/devcontainer.json
(`features`, `image`, `remoteEnv`, `containerEnv`, `mounts`, `postCreateCommand`, `runArgs`);
<repo>/compose.yaml, docker-compose*.yml (`image:`, `volumes:`, `command:`);

**Limit** — This reads declarations, never runtime. A `postCreateCommand` that curls an installer,
a `--build-arg` override, a Codespaces prebuild, an image whose Dockerfile installs an agent no
`features` entry names, or a `docker run` typed by hand all defeat it — Vole reports what the
manifest says and never claims the container matched it.

### 65. IDE agent posture as a dated interval, from the editor's settings backups

`Posture` · `CISO` · **M** · exact · unscored

The bypass switches for IDE-resident agents live in the editor's settings, and the editor keeps a
dated history of them. Two readers.

**In the app** — Posture screen gains an IDE band: one card per editor root, three-state controls
showing observed value beside the hardened value, each with a provenance line naming the exact
file; clicking a control opens the dated lane of that key's history with the windows in which it
was permissive shaded.

**Source** — ~/Library/Application Support/Code/User/settings.json
(claudeCode.allowDangerouslySkipPermissions:true, chat.agent.maxRequests:1000000000000,
chat.agent.sandbox.enabled:'on');
.../User/sync/settings/{20260429T132155,20260501T143321,20260507T153716,...}.json;

**Limit** — settings.json is the user layer only: the effective value also depends on workspace,
folder and managed-policy layers, so a row without all layers read is labelled 'user layer,
precedence incomplete' rather than presented as effective.

*Extends the earlier entry "Vendor lever cards: each tool's own permission config, observed value
beside the hardened one".*

### 66. Retroactive extension-version history from the editor's own Settings Sync backups

`Posture` · `CISO` · **M** · exact · unscored

A snapshot cannot answer 'did this machine ever run the vulnerable version', and polling only
samples forward from install day. VS Code already keeps the answer: ~/Library/Application
Support/Code/User/sync/extensions/<YYYYMMDDTHHMMSS>.json, each a {version, content} envelope whose
content is a JSON string of [{identifier.id, version, preRelease, pinned}]. The UTC timestamp is
IN THE FILENAME, so event_key = sha256(root|filename|extension_id|version) is deterministic and
contains no now() — it satisfies the anomaly-key constraint by construction.

**In the app** — Clicking any Extensions-band row opens a version lane: a horizontal timeline of
observed versions with advisory-floor bands shaded, each segment labelled with its two bounding
observation timestamps and a 'sampled, not continuous' watermark; the incident card renders the
interval, the floor version and the advisory id.

**Source** — ~/Library/Application Support/Code/User/sync/extensions/{20260428T195920,20260514T093
339,20260813T192417,lastSyncextensions}.json; ~/Library/Application
Support/Code/CachedExtensionVSIXs/

**Limit** — This directory exists ONLY when Settings Sync is signed in — verified absent for
Cursor, Kiro and Antigravity IDE on this machine, which have no sync/ dir at all, so those roots
degrade to forward-only polling and the lane renders 'history unavailable, snapshot only'.

*Extends the earlier entry "Retroactive config history replayed from the agents' own rotating
backups".*

### 67. extension_version_history: the permission that arrived in an auto-update

`Posture` · `Platform` · **M** · exact · unscored

Chrome retains more than one unpacked version per extension id — verified here,
bgnkhhnnamicmpeenaelnjfhikgbkllg holds both 5.5.2.19_0 and 5.5.2.20_0, each with its own
manifest.json — which makes the on-disk profile an offline record of what an auto-update changed.
Read every <ver>_0 directory under Extensions/<id>/, hash each version's permissions,
host_permissions and content_scripts.matches, and date the switch from Secure Preferences
last_update_time (AdGuard: 13433252744864122 = 2026-09-07T11:05:44Z) against first_install_time.
granted_permissions records what the user then accepted.

**In the app** — Posture screen, Browser band drill-down: the two permission lists rendered side
by side with added entries marked, the update date, and — when no predecessor survives on disk —
the words 'no prior version on disk' in place of a diff.

**Source** — ~/Library/Application Support/<Chromium
root>/<Profile>/Extensions/<id>/<version>_0/manifest.json (permissions, host_permissions,
optional_permissions, optional_host_permissions, content_scripts.matches); Secure Preferences
extensions.settings.<id>.{first_install_time, last_update_time, granted_permissions}

**Limit** — Only versions still on disk are comparable. Chrome deletes older version directories
on its own schedule, so the first observation of an extension has no predecessor and the rule
yields baseline NULL, printed as 'no prior version on disk' — never as 'no change'.

### 68. extension_store_state: Chrome's own store verdict, read from disk with zero network

`Posture` · `CISO` · **S** · exact · unscored

Chrome caches the Web Store's safety verdict for every installed extension in Secure Preferences
-> extensions.settings.<id>.cws-info {is-live, is-present, last-updated-time-millis, no-privacy-
practice, unpublished-long-ago, violation-type}, verified present on all six store extensions here
(AdGuard: last-updated-time-millis 1788678000000 = 2026-09-06). Alongside it sit .allowlist (Safe
Browsing extension allowlist state, 1 here), .disable_reasons (verified [1] on three ids) and
.location. Vole reads the verdict the browser already fetched;

**In the app** — Posture screen, Browser band: each extension row carries a verdict chip reading
"Chrome's verdict, N days old" — attributed to Chrome, never to Vole — and an 'unknown' bucket
counting the ids that carry no verdict at all.

**Source** — ~/Library/Application Support/<Chromium root>/<Profile>/Secure Preferences ->
extensions.settings.<id>.{cws-info, allowlist, disable_reasons, location, lastpingday}, plus the
file's own mtime

**Limit** — This is Chrome's verdict, not Vole's, and it is exactly as fresh as Chrome's last
store ping (lastpingday) — a browser that has not launched in weeks yields a stale verdict, which
is printed as an age and never refreshed. Five ids on this machine exist only as a lastpingday
stub with no cws-info at all;

### 69. Fork drift: the same extension at two versions, and the fork the patch cycle forgot

`Posture` · `CISO` · **S** · exact · unscored

A three-line join over feature 1 that produces a number nobody currently has. Group ai_extensions
by extension_id across roots and compare versions. Measured on this machine: ms-python.vscode-
python-envs is 1.36.0 in ~/.vscode and 1.20.1 in ~/.antigravity-ide — sixteen minor versions of
drift for the identical extension id, because the fork has its own update cadence and its own
gallery.

**In the app** — A drift strip at the top of the Extensions band: one row per drifting extension
id showing each root's version side by side with the floor marked, sorted by distance below the
floor; Posture screen gets a per-fork 'behind primary root by N extensions' figure.

**Source** — the ai_extensions table from feature 1, over ~/.vscode, ~/.vscode-insiders,
~/.cursor, ~/.windsurf, ~/.kiro, ~/.antigravity-ide and each fork's app bundle; advisory floors
from the shipped offline content pack

**Limit** — Forks pin their own marketplace — product.json.extensionsGallery.serviceUrl differs
per fork and some point at OpenVSX or a private gallery — so 'behind' is not always 'patchable',
and a row whose gallery differs from the primary root's is labelled version_incomparable rather
than flagged as unpatched.

### 70. Editor-synced agent plugins and skills: instruction packs that arrive over the wire with no install event

`Posture` · `CISO` · **M** · exact · unscored

Instructions now reach IDE agents through a channel with no marketplace row, no extension id and
no install prompt: Settings Sync. Verified on this machine: ~/.vscode/agent-plugins/cache.json
plus ~/.vscode/agent-plugins/vscode-synced-customization-agent-host-
claude/1066553724/skills/{pylance-docs,pylance-python-profiling,pylance-refactoring,python-fact-
grounded-coding}/SKILL.md — four skill files delivered into the Claude agent host by sync, not by
an install; ~/.cursor/skills-cursor/*/SKILL.md holds eighteen more, including shell, automate,
create-hook and update-cursor-settings;

**In the app** — A Synced packs row inside the Posture screen's IDE band: pack directory, file
count, the agent host it targets, first-seen date and a hidden-Unicode verdict; the Policy screen
shows whether roaming of mcp and languageModels is enabled per profile.

**Source** — ~/.vscode/agent-plugins/cache.json and .../vscode-synced-
customization-<agent>/<id>/skills/*/SKILL.md; ~/.cursor/skills-cursor/*/SKILL.md;

**Limit** — cache.json carries a numeric sync id, not a publisher, a signature or a source URL, so
provenance stops at 'arrived via Settings Sync under this account' — the customer trust anchor
cannot be applied and the pack is classed unsigned by construction, never inferred as vendor-
signed.

*Extends the earlier entry "Plugin, skill and marketplace supply-chain inventory".*

### 71. Admin control resolved vs behaviour observed: autonomousAgentsDisabled while Autopilot ran

`Posture` · `CISO` · **M** · exact · unscored

One line per launch carries the vendor's admin policy exactly as it landed on this device:
[GovernanceService] Resolved
{'enterprise':true,'provider':'Enterprise','profileArn':'arn:aws:codewhisperer:us-
east-1:<acct>:profile/<id>','controlPlaneEndpoint':'https://management.us-east-
1.kiro.dev','mcpDisabled':false,'mcpReason':'admin_disabled','webToolsDisabled':false,'autonomousA
gentsDisabled':true,'disabledReason':'admin_disabled','registryUrl':'','catalogSize':0}. The same
log then shows agent_controller.triggered {autonomyMode:'Autopilot'} and session.json shows
autopilot:true.

**In the app** — Posture gains an 'Admin says / device did' pair per control, each with the
resolved_at that makes staleness visible; Reconciliation gains the hashed tenant reference as a
join key into whichever AWS account actually pays for these tokens.

**Source** — ~/.kiro/logs/<stamp>/kiro.log lines [GovernanceService] Resolved, [KiroAgent]
Resolved capabilities, agent_controller.triggered;
~/.kiro/sessions/<hash>/sess_<uuid>/session.json (autopilot, agentMode, _meta.kiro.policyPreset)

**Limit** — This is the vendor's client-side resolution of policy, not the console's current
state: it is only as fresh as the last launch, so a device that has not launched since a policy
change shows a stale value and must display resolved_at next to it. It proves what the client
received, never what the admin intended.

### 72. Measured collection posture: the vendor turned uploads on remotely, and here are the receipts

`Posture` · `CISO` · **M** · exact · unscored

Grok CLI writes the one thing every other posture feature can only assert: a per-session
precedence chain for its own data collection. `trace.upload.decision` carries `{trace_upload,
trace_upload_source, telemetry_mode, telemetry_source, in_requirement_pin, in_env_trace_upload,
in_env_telemetry_enabled, in_cfg_telemetry_trace_upload, in_cfg_features_telemetry,
in_remote_trace_upload_enabled, has_remote_settings, uploads_enabled, upload_reason}` — on this
machine 209 decisions with `trace_upload_source:"remote"` and every local input NULL, i.e. the
vendor's server enabled trace upload and no local setting contested it.

**In the app** — An 'Uploads' band on the Posture screen listing, per agent, who decided the
collection setting (local / env / remote / unset) with the field names as evidence; a drill-down
table of upload receipts with repo path, phase, byte count and destination object path, summed per
repo on the Blast Radius screen.

**Source** — ~/.grok/logs/unified.jsonl msg='trace.upload.decision' ctx.* and
msg='repo_state.upload.{start,enqueued}'
ctx.{repo_path,phase,turn_number,size_bytes,gcs_path,blobs}

**Limit** — Only Grok CLI logs this; for every other agent the collection posture stays a config
reading, and the absence of receipts is not evidence that nothing was uploaded.

*Extends the earlier entry "Native-telemetry and prompt-logging posture per agent".*

### 73. Plugin install-vs-use reconciliation (ghost and orphan plugins)

`Posture` · `Platform` · **S** · exact · 2/5

Three registries disagree on this machine and the gap is the finding. ~/.claude.json pluginUsage
records the vendor's own counters for seven entries - ponytail@ponytail usageCount 3455 /
lastUsedNumStartups 79, ponytail@inline 2434, caveman@inline 2406, caveman@caveman 1296,
anthropic-skills@inline 2, rust-analyzer-lsp@claude-plugins-official 0, 1.0.0@inline 0 - while
installed_plugins.json lists only ponytail@ponytail, ~/.claude/settings.json enabledPlugins
enables only ponytail@ponytail, and ~/.claude.json enabledPlugins is null.

**In the app** — Supply Chain > Plugins gains a Reconciliation section: three columns (enabled /
installed / used) with mismatched rows highlighted and the vendor's own usageCount, lastUsedAt and
lastUsedNumStartups printed beside each row.

**Source** — ~/.claude.json pluginUsage{usageCount, lastUsedAt, lastUsedNumStartups} and
enabledPlugins (null here); ~/.claude/plugins/installed_plugins.json;

**Limit** — lastUsedAt is a single epoch and the registry keeps no history, so 'used 1296 times'
is a lifetime total with one timestamp that can never be split across a date range or attributed
to a session.

*Related to the earlier entry "Plugin, skill and marketplace supply-chain inventory".*

### 74. Comparability gate: not_comparable is the verdict the third verdict was hiding

`Posture` · `CISO` · **M** · exact · unscored

An indicator can fail to match because it was never here, or because this store cannot express it
— and calling the second case "not seen" is the lie this feature refuses. Adds
`indicator_matchers(kind, ledger, column, normaliser_id, norm_rev, strength)`: package joins the
execution ledger and the resolved lockfile with semver-range semantics; mcp_endpoint joins on the
endpoint identity key the registration sweep already uses, never on server name;

**In the app** — A fourth counter on the hunt result and a per-indicator reason chip; clicking a
not_comparable row shows exactly what would make it answerable (bump the pattern pack, re-scan N
retained files, cost in bytes) and offers the bounded re-scan.

**Source** — existing round-2 ledgers (package execution, MCP registration by endpoint identity,
ai_extensions, context_edges/egress, tool_calls command skeletons with pattern_id + pack_version,
secret_sightings); indicator pack files under the signed content-pack path

**Limit** — A shape match over a command skeleton can collide — two different commands can share a
skeleton — so shape-strength hits are evidence to read, not proof, and are never promoted to
identity. Fixing a not_comparable command_hash requires re-hashing retained evidence under the
pack's pattern version, which the retention window and byte budget may not cover.

### 75. Pre-Vole residue hunt: the filesystem remembers days the store never saw

`Posture` · `Platform` · **M** · partial · unscored

The store starts on install day; the machine does not, and the s1ngularity-class questions are
always about weeks before anybody deployed a monitor. At hunt time only, under a declared byte
budget and the existing exclusion-at-open() path, the hunt reads dated residue:
`~/.npm/_logs/*-debug-0.log` (bounded by logs-max, 10 here, 14 files present), pnpm's
`node_modules/.modules.yaml` and npm's `node_modules/.package-lock.json` under the declared
work_roots for exact resolved versions, Homebrew `/opt/homebrew/Cellar/*/*/INSTALL_RECEIPT.json`
(`time`, `source.versions`) and `Caskroom/<cask>/<version>/`, and
`~/.vscode/extensions/extensions.json` plus `.obsolete`.

**In the app** — A separate "before Vole" section under the hunt result, visually demoted, each
row labelled with whose clock the date came from (install receipt time, log filename, lockfile
mtime) and whether the artifact is still on disk.

**Source** — ~/.npm/_logs; node_modules/.modules.yaml and node_modules/.package-lock.json under
work_roots;

**Limit** — Residue proves presence, not execution: a lockfile entry proves resolution, an install
receipt proves an install, neither proves the postinstall ran or the agent used it.

### 76. Posture screen with three-state controls and an evidence coverage ratio

`Posture` · `Platform` · **L** · partial · 5/5

One card per host control - permission/approval mode per agent, sandbox policy, MCP servers
registered, hooks installed, instruction-file drift, binary signing, agent version against the
advisory floor, marketplace pinning, vendor upload posture - each rendered as pass / fail /
unknown, where unknown is a first-class state that names why (file unreadable, tool not installed,
no run recorded). The header shows a coverage ratio, 'evidence for 11 of 17 controls', because a
screen of green ticks over missing evidence is the exact failure mode EU AI Act audits and SOC 2
CC7.1 punish.

**In the app** — Posture: control cards grouped by Autonomy / Supply chain / Configuration, each
showing state, the evidence path, the last-checked timestamp and a drill-down listing the sessions
or files that produced the verdict;

**Source** — posture_snapshots and the per-feature tables (posture_binaries, posture_mcp_servers,
posture_grants, workspace_trust, posture_hook_runs, posture_marketplaces); Codex rollout
turn_context.{approval_policy, sandbox_policy.type, permission_profile};

**Limit** — Absence of evidence is never compliance: a control with no artifact stays unknown and
must never count toward the pass ratio, and the ratio itself is the headline rather than a score.

*Extends the earlier entry "Posture snapshots, vole posture CLI and vole_posture MCP tool".*

### 77. Two trust classes: vendor-signed content vs admin-authored policy, and the customer trust anchor

`Posture` · `CISO` · **M** · new instr. · unscored

The six content artefacts do not share a trust model and pretending they do is the round-2 brief's
mistake: Vole can sign dlp_detectors, command_patterns, advisory_floor, semconv and pricing, but
it can never sign the customer's own sanctioned-surface allowlist or rule thresholds, because the
customer holds no Vole key. `content_packs.trust` splits kinds into `vendor_signed` and
`admin_authored`;

**In the app** — The Content table's signer column prints the literal trust string, never an icon;
the Policy screen shows each effective threshold and allowlist entry with its trust class beside
the provenance it already renders;

**Source** — /Library/Managed Preferences/com.launchsafe.vole.plist (absent here — that directory
holds only a per-user subdir, so this machine is unmanaged); file ownership and mode of
/Library/Application Support/Vole/packs/*.json via fs.statSync;

**Limit** — Provenance-based trust is exactly as strong as the filesystem: where the developer is
a local admin, a root-owned pack proves nothing about who wrote it, and Vole labels it
root_file_unsigned rather than implying otherwise. Vole also cannot distinguish a managed
preference written by MDM from one written by a local root shell, and says so.

### 78. content_stale, per kind, with a rule key that ages in steps instead of firing daily

`Posture` · `CISO` · **S** · exact · unscored

`content_stale` fires when a pack's `built_at` exceeds its per-kind floor — default 90 days, but
advisory_floor defaults to 30 because an old CVE table means "unknown", not "clean", and semconv
is info-only because a stale one is cosmetic. Thresholds resolve through the same policy
provenance chain the Policy screen already renders with its effective values. The key is
`content_stale:<kind>:<version>:<floor(age_days/30)>`: deterministic and free of `now()`,
satisfying the constraint that detect.test.ts:120 pins, so the incident escalates in 30-day steps
rather than duplicating every poll or freezing at its first severity under `INSERT OR IGNORE`.

**In the app** — A content-age chip beside the menu bar's six honest states and on the coverage
strip — grey when current, amber when stale — reading "content 118d old" rather than a red dot;
the Policy screen lists each per-kind floor with its provenance next to the thresholds it already
shows.

**Source** — content_packs.built_at compared against poll time; per-kind floors from the policy
precedence chain.

**Limit** — Staleness is measured against the pack's own declared build date, which the pack
author controls; with no network Vole cannot know whether a newer pack exists, only how old the
one it holds is.

### 79. vole packs --preflight: score a candidate pack against this machine's evidence before the fleet gets it

`Posture` · `Platform` · **M** · exact · unscored

`vole packs` prints kind, version, built_at, age, ring, trust, load_state and which entries came
from the builtin floor rather than the pack — the support call answered in one line, and the only
way a helpdesk can tell a rejected signature from an old pack. `--preflight <file>` goes further:
it verifies the candidate's signature, then dry-runs it over the evidence this machine still holds
(dlp_scan_state's surviving raw_refs for detector packs, the tool_calls ledger for command-pattern
packs, usage_events windows for rule thresholds) and prints findings-added, findings-removed and
per-entry hit counts, writing nothing to the store and opening every third-party file read-only.

**In the app** — None by design — an admin CLI, not a user surface. The Settings → Content table's
empty state names the command so an admin arriving from the GUI finds it.

**Source** — The candidate pack path given on the command line; read-only queries over
dlp_scan_state, secret_sightings, tool_calls, anomalies and usage_events in ~/.vole/vole.db.

**Limit** — Preflight measures one laptop's evidence, which is not the fleet's — a detector clean
on the canary can still flood elsewhere, and the output labels the sample size it actually saw. It
also cannot estimate a true-positive rate, only how many rows would match.

### 80. Approved-baseline snapshot and one-key drift diff

`Posture` · `Platform` · **M** · new instr. · 4/5

Posture is only actionable against a baseline. Add `vole posture baseline` and a Settings button
that writes the current posture_snapshots rows — MCP identities, hook command hashes, plugin ids
with git shas, marketplace revisions, instruction-file hashes, binary CDHashes, policy-layer
hashes — into a human-readable ~/.vole/baseline.json with a capture timestamp and the tool
versions in force. Every later poll diffs against it, and the Supply Chain screen shows one 'N
changes since baseline' figure expanding to per-item before/after.

**In the app** — Supply Chain screen header: 'Baseline captured <date> · N changes since', a drift
list showing item kind, identity, old hash, new hash and change time, and a 'Set baseline' action
whose confirm dialog lists exactly what will be captured and which file is in force.

**Source** — posture_snapshots rows keyed on (kind, identity, sha256); ~/.vole/baseline.json;

**Limit** — A baseline captured after a compromise blesses the compromise: the UI states the
capture date prominently and never calls a matching state 'secure'.

*Extends the earlier entry "Posture snapshots, vole posture CLI and vole_posture MCP tool".*


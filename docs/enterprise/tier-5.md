# Tier 5 — Deep agent monitoring: the tool-call ledger, authority, autonomy and blast radius

[← Enterprise roadmap index](../ENTERPRISE-ROADMAP.md) · 52 features

'Are agents using tools and reading data from the user's system without permission' is a question
that cannot be answered from `usage_events.tools`, a comma-joined string that is NULL on half the
turns. It needs a real ledger: one row per invocation with source-native keys, a two-phase NULL-
only-widening bind for late tool results, four-state authority on every call (denied / pre-
authorised / posture-waived / no record), signal provenance so `status_source` and `duration_kind`
are never silently invented, and a command-shape skeleton reduced to a versioned pattern id rather
than a stored string. On top of it sit the things no vendor console can produce:
`autonomy_intervals` that make permission posture a timeline rather than a session column, the
unattended-run evidence chain, `sensitive_read_unasked`, the destructive-command classifier with
cwd-relative blast radius, `denied_then_achieved` as the guardrail-bypass matcher,
`agent_self_authorised` when the agent edited its own permission surface,
`subagent_inherited_bypass` down the agent tree, and Codex's declared sandbox and network policy
checked against observed behaviour. This tier also upgrades Tier 4: `dlp_egress`,
`action_targets`, remote-database and remote-execution hop ledgers, and
`agent_pushed_data_off_device` all need the ledger to say which class of data reached which
endpoint under whose authority. It also repairs the rules that are wrong today — burn rate scored
on cache reads fires on 77% of incidents here, and a runaway loop at a constant rate is
undetectable by construction — replacing them with `billable_burn_spike` and `repeat_call_loop`.
It is XL work and it comes fifth because the three vision-defining answers ship before it, but
everything in tiers 6 and 8 that claims to be an audit trail depends on it.

Legend: `category` · `buyer` · effort **S**/**M**/**L**/**XL** · feasibility (*exact* =
readable from local data today, *partial*, *new instr.* = needs something written that does
not exist, *network* = crosses the network line) · value 1–5, 5 meaning a security lead blocks
the rollout without it. `unscored` came from a completeness sweep and skipped the verifier.

---

### 1. dlp_egress: which class of data reached which provider endpoint

`Data exposure` · `CISO` · **M** · partial · 5/5

A model name is not a destination. Resolve each sighting to an endpoint from what is actually on
disk: Codex session_meta.model_provider plus turn_context, Grok's 'subagent spawn
credentials'.ctx.base_url, OpenCode providerID joined to the provider block in opencode.jsonc, and
for Claude Code the model-id prefix (us.anthropic.* -> Bedrock, bare id -> first-party). View
dlp_egress(fingerprint, class, provider_key, host, transport, first_ts, sessions, events) answers
the question a CISO actually asks -- 'this Stripe key reached two providers across three sessions'
-- from rows that never hold the value.

**In the app** — Data Exposure drill-down: fingerprint -> destinations list with provider, host,
transport and session count; unresolved-endpoint rows render in an amber 'endpoint unknown' state
that sorts to the top rather than being hidden.

**Source** — ~/.codex/sessions/**/rollout-*.jsonl session_meta.model_provider and turn_context;
~/.grok/logs/unified.jsonl 'subagent spawn credentials'.ctx.base_url;

**Limit** — ANTHROPIC_BASE_URL and proxy overrides never appear in a Claude Code transcript, so a
rerouted session resolves to host = NULL and Vole says 'endpoint unknown', never 'first-party'.
That gap is exactly the CVE-2026-21852 exfiltration path, so unknown must render as a risk state.

*Extends the earlier entry "Model provenance facts and the per-session 'where did this code go'
line".*

### 2. autonomy_intervals: posture as a timeline, not a session column

`Authority` · `CISO` · **L** · exact · 5/5

Adds a sibling table autonomy_intervals(id, source, session_id, agent_id, seq_start, ts_start,
ts_end, mode_raw, autonomy, profile_kind, fs_policy, network_policy, approvals_reviewer,
evidence_ref, confidence, user, machine) keyed posture:<source>:<session>:<seq_start>, so a tool
call joins to the posture in force at its own timestamp instead of one session-level label.

**In the app** — Breakdown gains a Posture tab, and a session row opens a detail sheet with a
posture ribbon above the call list: a horizontal band coloured per autonomy level, the vendor's
raw mode string on hover, grey hatching over unknown stretches, and a marker at each transition
naming the artifact line (<file>#<offset>) that proved it.

**Source** — ~/.claude/projects/*/*.jsonl entry permissionMode + type:"permission-mode" lines +
attachment.type auto_mode/auto_mode_exit/plan_mode;

**Limit** — 103 of the 125 Claude type:"permission-mode" lines carry no timestamp of their own (22
do), so those transitions are bounded by the neighbouring timestamped entries and calls before the
first stamp stay 'unknown', never 'default'.

*Corrects the earlier entry "Permission-mode and sandbox posture per session (normalised autonomy
column)".*

### 3. billable_burn_spike replaces burn_rate_spike (cost-scored, session-attributed)

`Behaviour` · `FinOps` · **M** · exact · 5/5

detect/burn-rate.ts:29 scores each 10-minute window on SUM(total_tokens), which for Claude Code is
85% cache reads priced at 0.1x (3.53B of 4.15B tokens here; 98% for exact Grok rows, 63% for
OpenCode): the rule fires on 14.8% of windows, is 190 of the 247 live incidents, and the median
fired window is 99% cache_read_tokens — the headline incident class reports that the context got
large, not that money was spent. Score on SUM(cost_usd) when every row in the window is priced,
else on SUM(total_tokens - cache_read_tokens), keeping the raw total in the detail line so nothing
is hidden.

**In the app** — Incident feed rows show billable tokens and dollars with the raw total beneath
and the scoring basis named ('cost' or 'non-cache tokens'); the burn_rate_spike badge is renamed
while old rows keep their key and are labelled 'scored by rule v1';

**Source** — packages/core/src/detect/burn-rate.ts:29,43,56-58; usage_events.{cost_usd,
total_tokens, cache_read_tokens, model, session_id};

**Limit** — Cost-scored burn is unavailable wherever cost_usd is NULL — Codex (83 rows), Grok's
exact rows, every rerouted claude_code row — so those windows fall back to non-cache tokens and
the incident must state which basis it used rather than presenting the two as one scale.

*Corrects the earlier entry "Incident noise controls: window chaining, per-session cap, info
rollup".*

### 4. Session behaviour surface: live board and ledger-native drill-down card

`Desktop` · `Platform` · **XL** · exact · 4/5

queries.ts already computes everything a live view needs — context against the model window,
tokens/min over 5 minutes, cache expiry and re-warm cost, agents in the tree, last tools,
incidents in the last hour (getLiveSessions L277) and per-call context deltas with bloat
attribution (getSessionDetail L395) — and the app renders none of it, because DB.swift ports four
queries and cannot bind a session_id string at all. Port both behind shared views and build the
screen this product is missing: a live board of every session with a call in the last 30 minutes,
and a drill-down that is the behaviour report card.

**In the app** — A Live Sessions screen with one row per active session (agent logo, model,
repo/branch, context gauge against the window, tokens/min, cache-expiry countdown, incident chip,
last tools), and a drill-down page combining the per-call context-growth chart, the agent/subagent
tree, the top context-bloat calls with the tools that caused them, that session's incidents and
the full behaviour card;

**Source** — queries.ts getLiveSessions L277 and getSessionDetail L395 (both unported to
DB.swift); tool_calls, agent_edges, the file-write ledger and control/denial rows;

**Limit** — 'Live' means a row landed in the last 30 minutes at a 5-second poll — a session where
the agent is thinking, waiting on a permission prompt, or running a long Bash command looks idle,
and Devin, Cursor and Antigravity rows carry no tokens so their gauges stay empty rather than
reading zero.

*Corrects the earlier entry "Session behaviour report card and tool-mix breakdown".*

### 5. tool_calls ledger with source-native keys and a two-phase, NULL-only-widening bind

`Tool ledger` · `CISO` · **XL** · exact · 5/5

One row per tool invocation written inside each collector's existing parse loop, never derived
from usage_events.tools. Keys are source-native and verified on this machine:
claude_code:<tool_use.id> (22,687 tool_use blocks, 22,687 carry an id), opencode:<part.id> (12,292
tool parts, 12,292 with callID), devin:<db>:<content.toolCallId> (1,715 distinct),
codex:<function_call.call_id|custom_tool_call.call_id>, grok:<sid>:<ts>:<seq>. Idempotency is two-
phase because the issue and the result are separate lines: phase 1 INSERT OR IGNORE writes the
issue row (name, mcp server prefix, session_id, agent_id, issued_ts, args_sha256, permission mode,
source='live');

**In the app** — New 'Behaviour' section in DashboardView with a per-session tool-call table
(time, tool, mcp server, outcome, duration); MenuPanel's top-5 tools reads this ledger instead of
usage_events.tools;

**Source** — ~/.claude/projects/**/*.jsonl assistant content[].tool_use.{id,name} joined to user
content[].tool_result.{tool_use_id,is_error}; ~/.local/share/opencode/opencode.db part.data
$.callID/$.state (verified 12,292 rows where $.type='tool');

**Limit** — Cursor (ai_code_hashes) and Antigravity (.pb blobs) record no tool invocations at all
— those tools must render 'not recorded', never 0. Grok emits no call id, so its key is (sid, ts,
seq) and two calls in the same millisecond collide.

*Corrects the earlier entry "tool_calls ledger with tool_result error join (Tier 1)".*

### 6. Session-tree cost roll-up, and the two event_key bugs that make it wrong today

`FinOps` · `Eng mgr` · **XL** · partial · 4/5

A vendor console bills per API request; a human bills per task. The subagent contract says child
events carry the parent's session_id and their own agent_id, so Vole can produce cost-per-root-
session including every descendant — a unit Cursor's OTel export explicitly lacks and that appears
in no admin API.

**In the app** — Session detail drill-down gains a tree with own-versus-descendant cost per node
and a fan-out count; the Dashboard's biggest-session KPI switches to biggest root tree, with a
per-tool 'folded / not folded' badge so an under-reported tree is visible rather than silent.

**Source** — usage_events.{session_id, agent_id};
~/.claude/projects/**/subagents/agent-*.meta.json {agentType, spawnDepth};

**Limit** — Only Claude Code and OpenCode fold subagents correctly today, so the Codex and Grok
trees are wrong until their keys are fixed and the view must show which tools are folded rather
than silently under-reporting. A tree spanning a compaction boundary or a forked session file can
attribute a shared message.id to whichever file was scanned first.

*Extends the earlier entry "Subagent and workflow fan-out monitor (fanout_burst)".*

### 7. repo_state_uploads: the whole-repo tarball, and the vendor server that decided to send it

`Posture` · `Platform` · **S** · exact · unscored

Reads Grok's own `~/.grok/logs/unified.jsonl`, which records the client tarring the working tree
and shipping it to xAI's GCS:
`repo_state.upload.start.ctx.{phase,turn_number,repo_path,max_file_bytes}` and
`repo_state.upload.enqueued.ctx.{size_bytes,gcs_path,blobs}`, and — decisively — `trace.upload.dec
ision.ctx.{uploads_enabled,upload_reason,trace_upload_source,telemetry_mode,data_collection_disabl
ed,in_env_trace_upload,in_cfg_telemetry_trace_upload,in_remote_trace_upload_enabled,has_remote_set
tings}`, the client's full precedence chain for why it decided to upload. Adds `bulk_uploads` and
`upload_decisions` (one column per input in the chain) and two rules.

**In the app** — A Bulk Egress card on Posture listing each upload root with total enqueued bytes,
turn count and the decision chain rendered as a precedence ladder (env → config → remote →
effective), with the deciding row highlighted; the two rules land on the Triage queue with the
chain attached as incident evidence.

**Source** — ~/.grok/logs/unified.jsonl: msg='repo_state.upload.start' (399 records, roots
<redacted-local-path> 274, <redacted-local-path> 123, <redacted-local-path> 2),
msg='repo_state.upload.enqueued' (274 records, 520,761 bytes total), msg='trace.upload.decision'
(209 records, 207 enabled remotely)

**Limit** — `size_bytes` is the compressed tarball and exists only on `enqueued` records — 399
starts produced 274 enqueued lines here, so 125 uploads have no recorded size and the ledger
prints that count rather than summing them as 0.

*Corrects the earlier entry "Vendor telemetry and upload posture report".*

### 8. authorization_basis per tool call, ungated-call KPI and default_policy_delta

`Authority` · `CISO` · **L** · partial · 5/5

The owner's mandate - 'are agents using tools and reading data WITHOUT permission' - becomes two
columns on the tool_calls ledger plus one dashboard card. authorization_basis in {bypass_no_gate,
mode_auto, rule_matched, human_denied, unknown} is filled by joining each call to
autonomy_intervals: a call inside a bypassPermissions interval, or a Codex turn with
approval_policy='never' and sandbox_policy.type='danger-full-access', had no gate that could have
stopped it, full stop; a call whose tool_result carries toolDenialKind was refused (37 records
here).

**In the app** — Dashboard KPI strip gains 'ungated tool calls' beside tokens and cost, with the
default-policy counterfactual as its second line and the policy-table version as a footnote;

**Source** — tool_calls.name joined to autonomy_intervals; ~/.claude/projects/*/*.jsonl
permissionMode entries and tool_result toolDenialKind;

**Limit** — Most Claude permission-mode lines carry no timestamp, so a call's basis is bounded by
neighbouring stamps and calls before the first stamp stay 'unknown' - a blank must render as 'not
recorded', never as 'gated'.

*Extends the earlier entry "tool_calls ledger with tool_result error join".*

### 9. anomaly_context: blast radius attached to every behaviour incident

`Behaviour` · `CISO` · **M** · exact · 5/5

A behaviour incident is unreadable without the reach of what happened, and the anomalies row
cannot grow that answer because it is frozen at first sight. Add a sibling table
anomaly_context(anomaly_key PRIMARY KEY, distinct_files, distinct_dirs, out_of_repo_writes,
destructive_calls, failed_calls, unknown_outcome_calls, top_path_classes, contributing_sessions,
window_end) filled from the tool_calls and file-write ledgers over the incident's own window and
upserted only when window_end grows, which keeps collection idempotent without entangling it with
the anomalies upsert semantics.

**In the app** — Incident detail gains a 'reach' block (files, directories, out-of-repo writes,
destructive calls, failed and unknown-outcome calls) above the explanation, and finally renders
observed / baseline / threshold from the columns that already store them.

**Source** — tool_calls and the file-write ledger joined on session and the anomaly's window;
anomalies.{observed, baseline, threshold} (schema.ts:42-64), currently unread at queries.ts:230
and apps/mac/Sources/Vole/DB.swift:227

**Limit** — Reach is only what the ledger recorded — unresolved shell redirect targets and Bash-
mediated writes on tools without command capture appear as 'n calls with unresolved target', never
as zero.

### 10. Four-state authority on every tool call (denied / pre-authorised / posture-waived / no record)

`Tool ledger` · `CISO` · **M** · exact · 5/5

Adds authority TEXT and authority_evidence TEXT to each tool_calls row: 'denied' when the entry
carries a top-level toolDenialKind (re-counted today: automode-blocked 22, user-rejected 14,
automode-unavailable 2) or a tool_result whose text matches the versioned denial-phrase list;
'pre_authorised' when the tool name matches the allowedTools set in the nearest preceding
attachment.type='command_permissions' (43 attachments here, e.g. {"allowedTools":["Read"]}) or a
settings allow rule;

**In the app** — Session-detail tool list gains an authority chip per call (red 'denied', amber
'waived by posture', blue 'pre-authorised', grey 'no record'); a Behaviour header stat 'N of M
calls reached no permission decision' filters the table when clicked;

**Source** — ~/.claude/projects/**/*.jsonl top-level toolDenialKind on user entries;
message.content[].tool_result.content denial phrasing with is_error=true (739 error results here);

**Limit** — Only Claude Code writes denial records; Codex, OpenCode, Grok, Devin, Cursor and
Antigravity write none, so for those tools authority is 'unknown' on every call and the UI must
render 'not recorded', never '0 denials'.

*Corrects the earlier entry "Guardrail-fired ledger: denials, refusals, hook blocks, denial_streak
(Tier 2)".*

### 11. Behaviour panel with incident-to-ledger jump

`Desktop` · `CISO` · **L** · new instr. · 4/5

The tool-call ledger stays invisible until DB.swift can read it: add a Behaviour section with a
sessions list, the session report card, the tool-call table, the subagent tree and the per-tool
coverage matrix, plus a 'Show calls' action on every incident that opens the ledger filtered to
that anomaly's window and session. Every one of those queries must exist twice (queries.ts and the
DB.swift port) or the app cannot show it, and the drill-down needs text binds since it keys on
session_id — impossible with today's Int-only run(). MenuPanel's top-5 tools also moves off the
49%-NULL usage_events.tools column onto the ledger.

**In the app** — 'Behaviour' section in the Risk sidebar group; a 'Show calls' button on each
incident row;

**Source** — tool_calls, agent_edges and anomaly_context tables via new DB.swift readers; existing
anomalies columns for the jump target.

**Limit** — DB.swift's row loop swallows SQLITE_BUSY and returns partial results, so the panel
must keep prior values when a read fails rather than rendering an empty session and implying no
activity. It can show nothing at all for Cursor, Devin and Antigravity, whose stores record no
tool calls, and the empty view must state that rather than reading as clean;

*Extends the earlier entry "Session behaviour report card and tool-mix breakdown".*

### 12. agent_pushed_data_off_device: scp, rsync and cp into an unmonitored context

`Data exposure` · `CISO` · **M** · exact · unscored

Every DLP feature in the product asks what reached a model; none asks what the agent copied to
another machine. From the same command-shape pass, isolate transfer verbs with a directional
argument pair — `scp <local> <host>:<path>`, `rsync <local> <host>:`, `docker cp <local>
<container>:`, `kubectl cp`, `sshfs` mounts, and `gh codespace cp` — and record the direction plus
the source path class, never the bytes.

**In the app** — Leak Ledger gains an Off-device tab beside the model-egress tabs, with columns
destination, direction, path class and 'joined to finding' — the first screen in the product where
a leak destination is a machine rather than a provider endpoint.

**Source** — Claude Code Bash `input.command` (scp/rsync/sshfs/docker cp/kubectl cp argument
pairs), Codex local_shell_call, OpenCode tool part state.input; joined to the existing
secret_sightings path HMAC and the sensitive-path class table

**Limit** — Vole reads the command, not the transfer: it cannot confirm the copy happened, cannot
know the byte count, and for a directory push it names the directory only — every file inside is
unknown and is reported as unknown rather than expanded. A push to a host that is in fact
monitored still shows as a push;

### 13. agent_self_authorised: the agent changed its own permission surface

`Authority` · `CISO` · **L** · exact · 5/5

Sharpens v1's agent_config_modified from 'a config file changed' to 'a permission-granting key
changed', which is the only version worth a critical. The watched keys are additions to
permissions.allow, hasTrustDialogAccepted flipping true, enableAllProjectMcpServers,
skipDangerousModePermissionPrompt (already true in ~/.claude/settings.json here), any hooks block
gaining an entry, Grok [ui].yolo (config.toml line 14, currently false) and permission_mode (line
16, 'auto'), and Codex approval_policy.

**In the app** — Posture tab 'Permission changes' timeline: one row per key change with the file
class, key, old and new value class, the session that was running at the time (or 'no session'),
and a red dot for grants rather than revocations; a grant made while a bypass session was active
also opens as an incident.

**Source** — ~/.claude/settings.json, ~/.claude/settings.local.json,
<repo>/.claude/settings.local.json, ~/.claude.json projects[*], ~/.codex/config.toml,
~/.grok/config.toml; plus tool_use.input.file_path and Bash command strings targeting those paths

**Limit** — These files are rewritten both by the agent and by a human clicking 'always allow',
and neither writes an author, so attribution to a session holds only when a tool call in that
session named the file within the same poll interval; otherwise actor is 'unknown' and the
incident says so.

*Extends the earlier entry "Out-of-repo write and agent self-modification rules (scope_escape,
agent_config_modified)".*

### 14. agent_edges: the subagent tree from what the metadata actually carries

`Behaviour` · `CISO` · **M** · exact · 4/5

Build the fan-out tree as a table rather than timing it from Agent tool_use blocks:
agent_edges(parent_session, parent_call_key, workflow_id, child_agent_id, agent_type, spawn_depth,
edge_source, source) plus per-session tree size, max depth and max concurrent children. The edge
comes from three exact facts on disk: the directory path
~/.claude/projects/<project>/<parent_session>/subagents/[workflows/<wf_id>/]agent-<id>.jsonl names
both the parent session and the workflow that spawned the child; agent-*.meta.json carries
{agentType, spawnDepth} on all 479 files on this machine and additionally toolUseId on 23 of them,
which is a foreign key straight into the tool_calls ledger;

**In the app** — Behaviour panel tree view: parent session, then children grouped by workflow id
and agent type (456 workflow-subagent, 16 Explore, 4 general-purpose, 2 Plan, 1 claude-code-guide
here), each row linking to its own tool-call list; incident detail names the branch that fired.

**Source** — ~/.claude/projects/**/<session>/subagents/**/agent-*.meta.json {agentType,
spawnDepth, toolUseId} and the sibling agent-*.jsonl; the parent transcript's tool_use.id;

**Limit** — Only 23 of 479 metas here carry toolUseId — the other 456 are workflow-subagents whose
parent is known as a session plus a workflow id and nothing finer, so parent_call_key is stored
NULL and never guessed from timing.

*Extends the earlier entry "Subagent and workflow fan-out monitor (fanout_burst)".*

### 15. Command-shape skeleton and versioned pattern pack (pattern_id + pack_version, not just a hash)

`Tool ledger` · `CISO` · **M** · exact · 5/5

Classify each shell command by splitting on &&, ||, ; and | into segments, dropping leading cd and
VAR=... prefixes, then matching a versioned pattern pack;

**In the app** — Behaviour panel 'Commands' tab: category counts per session with a drill-down
listing skeletons (never raw commands) and a 'pack v1.3' badge; every destructive_command incident
quotes the skeleton and its pattern_id instead of an opaque hash.

**Source** — ~/.claude/projects/**/*.jsonl tool_use.input.command for name='Bash' (11,865 here);
~/.local/share/opencode/opencode.db part.data $.state.input where $.tool='bash' (6,084 rows);

**Limit** — The skeleton is derived from command text and keeps hosts and flag names, so it is
metadata by policy, not by construction — exports ship pattern_id + pack_version only. Heredocs,
$(...) bodies and variable expansions collapse to one opaque token, so a command whose danger
lives in a variable is classified 'unresolved', never 'safe'.

*Corrects the earlier entry "Destructive and outbound command classifier (destructive_command,
destructive_under_bypass) (Tier 2)".*

### 16. Secret-store retrieval ledger: the credential the agent pulled from a remote vault

`Data exposure` · `CISO` · **M** · exact · unscored

A whole class of secret access leaves no filesystem trace, so path-based sensitive-read rules
never fire: `kubectl get secret … -o jsonpath='{.data.GEMINI_API_KEY}' | base64 -d`, `aws
secretsmanager get-secret-value`, `gh secret list/set`, `op read`, `vault kv get`, `wrangler
secret`, `flyctl secrets`, `doctl … --access-token` (39 such commands here across 8 CLIs, 3 of
them decoding a Kubernetes secret from the `do-nyc3-launchsafe` cluster).
`secret_store_reads(call_id, store_kind, target_ref, item_name, field_name,
materialised{yes|unknown})` stores the *name* of the item and field and never the value;

**In the app** — A 'Pulled from a secret store' section on the Data Exposure screen, one row per
store item with field names, the target system, and a link to any later at-rest sighting of the
same fingerprint.

**Source** — Bash/exec command strings joined to action_targets for the cluster/account label;
existing HMAC fingerprint key for the optional sightings join.

**Limit** — A literal credential typed into the command (a `dop_v1_…` DigitalOcean token appears
inline in one command here) is fingerprinted and labelled by provider, never stored — and the
value is a token for the account, so the account label is a claim about the string's shape, not a
verified identity.

### 17. Blast Radius screen: every system outside this laptop that agents touched

`Desktop` · `CISO` · **M** · exact · unscored

The covered screens answer who used which agent (Shadow AI, People), what leaked (Leak Ledger) and
how the agent behaved (Behaviour) — none answers the question a CISO actually asks after Replit
and Nx: which systems beyond this filesystem did our agents act on. One screen over
`action_targets` and its four child ledgers, grouped by target with locality and declared
environment, showing first and last touch, the sessions and people involved, the worst action
class, and the incident count. Every total carries its denominator: resolved targets beside
`target unresolved (n)` and `no target named (n)`, so the screen can never imply coverage it does
not have.

**In the app** — A new sidebar section between Behaviour and Data Exposure. Rows read like the
ground truth on this machine: 'launchsafe-db-do-user-…ondigitalocean.com/launchsafe — remote, env
undeclared, 139 calls, 1 truncate, 4 sessions';

**Source** — action_targets joined to db_actions, remote_exec, secret_store_reads, package_execs
and vcs_actions; written once in queries.ts and ported to DB.swift as a read-only consumer, per
the read-model parity rule.

**Limit** — The screen shows targets Vole could name from local evidence; it is not an inventory
of the company's systems and must not be read as one.

### 18. unattended_full_access and the 'no human was present' evidence chain

`Authority` · `CISO` · **M** · exact · 4/5

Fires on a contiguous stretch where the autonomy interval is full_auto (or Codex
approval_policy='never' AND sandbox_policy.type='danger-full-access') and no entry with
origin.kind='human' appears between window_start and window_end. observed = minutes with no human-
origin entry, threshold configurable through the RuleConfig contract (default 15), and the detail
carries calls, write-class calls and destructive-class calls inside the window. The incident
stores an evidence chain: the posture interval id, the two bounding human-origin entries with
their timestamps, and the first and last raw_ref of the window as <transcript path>#<byte offset>.

**In the app** — Incidents detail renders the chain as a vertical evidence list - last human
input, posture at that moment, each intervening tool call with its authority chip, next human
input - with a copy-as-markdown action for the ticket; the session sheet shades the unattended
window on the posture ribbon.

**Source** — ~/.claude/projects/*/*.jsonl origin.kind and timestamp;
~/.codex/sessions/**/rollout-*.jsonl turn_context.payload.{approval_policy, sandbox_policy} and
user_message rows;

**Limit** — Absence of a human-origin entry is not absence of a human - someone watching the
screen without typing is indistinguishable from an empty room, so the incident text reads 'no
human input recorded for N minutes', never 'unattended'. origin.kind is a Claude-only field;

*Extends the earlier entry "Human intervention, autonomy duration, self-scheduling and idle/zombie
sessions".*

### 19. repeat_call_loop replaces loop_suspected (ledger-native, absolute-rate path, agent-scoped)

`Behaviour` · `Eng mgr` · **M** · exact · 4/5

detect/loop.ts's only baseline is the session's own leave-one-out median bucket, so a session that
spins at a constant rate from turn one (a CI `claude -p`, a bash retry loop) is its own baseline
and never fires — a 12-bucket by 40-call fixture produces zero anomalies, contradicting the
README's 'runaway tool loops'. Replace it with a rule over the tool_calls ledger firing on three
independent signatures: N identical (name, args_sha256) calls in a 5-minute window; an A-B-A-B
cycle of the same two (name, args_sha256) pairs;

**In the app** — Incident detail shows the repeated call skeleton, the repeat count and which
agent branch produced it; the Behaviour panel marks looping windows on the session timeline.

**Source** — tool_calls (name, args_sha256, issued_ts, session_id, agent_id);
usage_events.output_tokens for the flat-output gate;

**Limit** — A genuine loop with a varying argument (an incrementing offset, a new file each turn)
hashes differently every call and is reachable only by the absolute-rate path, which needs per-
call output tokens and so covers only tools with exact usage.

*Corrects the earlier entry "Tool-sequence loop and edit-test-revert thrash rules".*

### 20. Signal provenance on every ledger row: status_source, duration_kind and the per-tool coverage matrix

`Tool ledger` · `DPO` · **M** · exact · 4/5

Every tool_calls row carries status_source ∈ {result_flag, exit_code, log_flag, turn_status, none}
and duration_kind ∈ {execution, transcript_gap, turn_scoped, none} beside the value, and a
per-(tool, tool_name) coverage view aggregates them so no rule or report card can print an
invented zero. The signals genuinely differ, all verified here: OpenCode gives a real
metadata.exit on 6,026 of 6,084 bash parts and state.time.{start,end} on 12,290 of 12,292 tool
parts (status completed 12,201 / error 89 / running 2); Grok gives success + elapsed_ms on 1,402
exec_done;

**In the app** — Behaviour panel header strip renders a coverage matrix (tool × signal) with em
dashes for unavailable signals, mirroring the existing confidence-badge convention, and clicking a
cell filters the call table; the duration column carries a kind chip (exec / gap / turn / —);

**Source** — tool_calls, set at collection time from which field yielded the value: OpenCode
part.data $.state.metadata.exit and $.state.time.{start,end}; Grok shell.tool.exec_done
ctx.{success,elapsed_ms};

**Limit** — transcript_gap may never be reported as tool latency or agent runtime, and durations
of different kinds must never be summed into one KPI; sessions with no permission-mode stamp
(8,700 matched results here) are excluded from any mode comparison.

*Corrects the earlier entry "tool_calls ledger with tool_result error join — its ⚠ names
duration_kind but defines no taxonomy; also corrects 'Session behaviour report card and tool-mix
breakdown'".*

### 21. payload_origin: a screenshot of somebody's screen versus a PNG that was already in git

`Data exposure` · `CISO` · **M** · exact · unscored

Classifies each `payload_sightings` image row by where its bytes came from, using evidence that
already exists rather than any pixel: the row's `tool_use_id` joins the tool-call ledger to
recover the Read's `input.file_path`, and OpenCode preserves the attachment's original `filename`
verbatim in `part.data`. Four classes are stamped at insert — `screen_capture` (the OS screenshot
naming pattern, or a screenshot temp directory), `outside_work_roots` (a path resolving under no
`work_roots` entry), `repo_asset` (under a work root and present in that repo's `.git/index`), and
`unresolved`.

**In the app** — The Leak Ledger's unreadable axis splits by origin class rather than rendering
one grey bar, and the People view gains a 'screen captures sent to a model' count per principal
per week with the counted `unresolved` bucket printed beside it.

**Source** — payload_sightings.tool_use_id joined to the tool_calls ledger's Read input.file_path
(~/.claude/projects/**/*.jsonl content[].tool_use.input.file_path);
~/.local/share/opencode/opencode.db part.data.filename;

**Limit** — A screenshot of a stack trace and a screenshot of a customer record are identical to
this classifier — it says where the bytes came from and never what they show. Screenshot naming is
locale- and tool-dependent, so the patterns ship as a content pack with a version stamp, not as a
name list compiled into the collector.

### 22. What the agent left behind: the envelope receipt and its review packet

`Desktop` · `Eng mgr` · **M** · exact · unscored

One section on Blast Radius, machine side above repo side, each row a classified write carrying
its class chip, posture at the time, authorisation basis, escape state and the diff facts — names
added, install-script keys, PATH position, ignore patterns — as figures, not prose. Per session it
renders an envelope receipt answering the three questions the class list encodes: what this
session changed about what runs, about what is trusted, and about what is hidden.

**In the app** — The section itself, plus a per-session receipt sheet reachable from the session
card and from a vole:// deep link, with the unmonitored-agent count printed beside every total.

**Source** — The change_risk_class ledger, dependency_deltas, grant_deposits and the
persistence/visibility rows, exposed through v_envelope_changes.

**Limit** — This is a receipt of what was observed, not of what changed: a write through a tool
Vole does not ledger, or during an interval when no collector was running, is simply absent, so
the section prints the unmonitored-agent count and round 2's evidence_gaps beside the total or it
will be read as complete.

### 23. MCP server dimension on the ledger and tool_first_seen

`Tool ledger` · `CISO` · **M** · exact · 4/5

Split every tool name of the form `mcp__<server>__<tool>` into separate `server` and `tool_name`
columns on the tool_calls ledger, giving observed-usage counts per MCP server — live here:
playwright 1,994, searxng 548, Claude_Browser 298, github 48, context7 31, ui 13, ccd 2. Rule
`tool_first_seen` fires the first time a `(tool, server, tool_name)` triple is observed for a
principal, which catches a newly added MCP server, a poisoned server that grew a tool, and built-
in tools whose names carry their own risk (`browser_run_code_unsafe`, 214 calls here).

**In the app** — Breakdown pane gains an 'MCP servers' group (calls, failure ratio, first seen);
the first-seen incident appears in the feed with the server name and its transport where the
config inventory knows one.

**Source** — tool_calls.name prefix `mcp__<server>__`; Claude tool_use.name;

**Limit** — Devin collapses every MCP invocation to the single name `mcp_call_tool`, so its server
is unknowable from this source and stays NULL. Transport and command come from the config
inventory, never from the ledger;

*Extends the earlier entry "MCP server inventory, trust posture, usage diff and pin/sign rules".*

### 24. headless_bypass_launch rule (the Nx s1ngularity shape)

`Authority` · `CISO` · **S** · exact · 4/5

Fires when a Claude session's entrypoint is 'cli' or 'sdk-cli' (1,188 and 177 entries here against
44,873 claude-vscode) AND its first observed permissionMode is bypassPermissions AND the
transcript contains zero origin.kind='human' entries AND the session cwd holds a package manifest
whose mtime is within N minutes of the session's first timestamp - that last clause is what
separates a deliberate headless run from a postinstall-triggered one, and it only raises severity,
it never gates the rule. observed = tool calls in the session, threshold = 1, severity critical;
the detail names the entrypoint, version, cwd basename class and manifest filename, never the full
path.

**In the app** — Its own Incidents card style with a red 'headless, no human, full access' banner,
the entrypoint and version strings, and a list of the sensitive-path classes and destructive
classes touched during the run.

**Source** — ~/.claude/projects/*/*.jsonl entrypoint, permissionMode, origin.kind, cwd, version;
tool_use.input.command for the nested-launch string;

**Limit** — Vole sees only the agent leg of the attack: the npm postinstall process, the stealer
payload and any exfiltration outside a tool call are invisible and belong to EDR. A run launched
with CLAUDE_CONFIG_DIR pointed elsewhere writes its transcript outside ~/.claude/projects and is
missed entirely unless alternate-home discovery ships.

### 25. scope_drift: sessions that move to a second repository

`Behaviour` · `CISO` · **M** · exact · 4/5

Claude stamps cwd on every entry and 23 of 81 sessions here touched more than one cwd. The rule
fires when a session's tool calls cross into a second git root, or when the set of distinct
directories written to grows beyond K after the first N calls. This is a different test from v1's
scope_escape, which is per-call (file_path outside entry.cwd);

**In the app** — Behaviour panel session header lists the repos touched with per-repo call counts;
incident detail names both roots and the exact call at which the crossing happened.

**Source** — Claude entry.cwd per assistant line; tool_use.input.file_path;

**Limit** — A cd inside a Bash command does not change entry.cwd, so a parsed cd target is a
labelled second signal and never ground truth. Codex, Grok and Devin record cwd sparsely or not at
all here (all 1,758 Grok rows have project NULL), so the rule covers Claude Code and OpenCode and
must say so rather than reporting zero drift for the rest.

*Related to the earlier entry "Out-of-repo write and agent self-modification rules (scope_escape,
agent_config_modified)".*

### 26. Acting-now panel and live-autonomy tint

`Desktop` · `Developer` · **M** · new instr. · 3/5

Nothing in the app distinguishes a session running unattended under full autonomy from one a human
is typing into. Add two read models — getLivePosture() and getActingNow(), each written twice per
the read-model parity rule — that return, per session, its most recent autonomy_interval, the
tool, minutes since the last human-origin entry and calls since, and drive a third menu-bar tint
from whether any session's current interval is full_auto with its last event inside two poll
intervals. The panel gains an 'Acting now' section above the hero figures, one row per live
session with an autonomy chip, each row clicking through to that session's posture ribbon in the
dashboard.

**In the app** — Menu-bar glyph gains a third tint alongside the existing severity tints, with the
lag stated in its tooltip; MenuPanel gains an 'Acting now' section listing live sessions with
tool, autonomy chip, 'last activity 42s ago' and calls since the last human turn.

**Source** — autonomy_intervals (from the permission-mode/sandbox posture feature) joined to
usage_events.ts; new queries getLivePosture()/getActingNow() in queries.ts plus DB.swift ports;

**Limit** — 'Acting now' means 'wrote a transcript line within the last two poll intervals' — a
session blocked on a long tool call looks idle and one that exited without a final line looks live
until the window lapses, so the row says 'last activity 42s ago' rather than 'running'.

*Extends the earlier entry "Live process map: PID to session".*

### 27. denied_then_achieved and denial_then_reshape: the guardrail-bypass matcher

`Authority` · `CISO` · **M** · exact · 4/5

Gives v1's guardrail_bypass_suspected an actual mechanism, in two branches off one trigger. On a
denial - top-level toolDenialKind (automode-blocked 22, user-rejected 13, automode-unavailable 2
here) joined back to the issuing assistant entry through the sourceToolAssistantUUID field the
denial record already carries - extract the target as a normalised path or verb+path and hash it.
denied_then_achieved fires when a DIFFERENT tool reaches the same target hash within K subsequent
calls in the session (Bash `cat`/`head` after a denied Read, `python3 -c` or `sed -i` after a
denied Edit, `gh api` after a denied MCP call);

**In the app** — Incidents detail renders the pair side by side - denied call and achieving call -
with the shared target class between them, the number of intervening calls and the posture at each
end, plus a standing note that this is expected agent behaviour and not necessarily malicious so
the reviewer triages rather than panics.

**Source** — ~/.claude/projects/*/*.jsonl toolDenialKind, sourceToolAssistantUUID,
tool_result.content denial phrases, subsequent message.content[].tool_use.{name,input};
tool_calls.{pattern_id, args_sha256};

**Limit** — Claude Code is the only tool here that records denials at all - OpenCode's permission
table has 0 rows across 145 sessions - so this is Claude-only and every other tool's panel must
read 'denials not recorded' rather than showing a clean bill.

*Extends the earlier entry "Guardrail-fired ledger: denials, refusals, hook blocks,
denial_streak".*

### 28. Human-interrupt ledger from the interruption marker

`Behaviour` · `Eng mgr` · **S** · exact · 3/5

v1 concludes twice — in the session outcome labels and the waste taxonomy — that interruptions
have almost no local evidence, because toolUseResult.interrupted is false on every one of roughly
6,000 rows. The evidence exists in a different shape: the literal string '[Request interrupted by
user]' appears 262 times across 190 transcript files on this machine right now. Record each as an
intervention row (session, ts, and the tool call it interrupted, resolved via the immediately
preceding unbound tool_use), and expose interrupts per session and interrupts per 100 tool calls.

**In the app** — Behaviour panel session strip marks interrupts as ticks on the autonomy bar,
breaking the continuous bar where a human intervened; the session report card gains a line 'n
human interrupts (text marker)'.

**Source** — ~/.claude/projects/**/*.jsonl user entries containing the literal '[Request
interrupted by user]' (262 occurrences, 190 files here); toolUseResult.interrupted (present,
always false)

**Limit** — This is a text marker, not a structured field: it is version-fragile, it can be
produced by a user pasting the same string into a prompt, and every surface must label it 'text
marker' rather than presenting it as a vendor signal. Only Claude Code emits it — OpenCode, Codex,
Grok and Devin have no interruption record and must render an em dash, never 0.

*Corrects the earlier entry "Session outcome labels (rule-based funnel)".*

### 29. Bash redirect, heredoc and copy write-targets in the file ledger

`Tool ledger` · `CISO` · **M** · exact · 4/5

Parse write targets out of the shell segments produced by the pattern pack (>, >>, tee, cp, mv,
install, sed -i, patch) and record them as file-write rows in the same ledger as Edit/Write,
tagged method='bash_redirect'. This closes the largest blind spot in any edit ledger: 6,321 of
11,865 Bash calls here contain a write-shaped segment and 750 contain a heredoc, against 2,374
structuredPatch results from Edit/Write — so a blast-radius figure built only on Edit/Write
undercounts writes by roughly 2.7x. roadmap-v1 declares redirection writes out of scope under
scope_escape and then admits in the rollback entry that 'Bash edits are invisible to the ledger';

**In the app** — Behaviour panel 'Files' tab: writes split by method (Edit/Write vs bash_redirect
vs unresolved) with an out-of-repo count badge; the rollback flow lists bash_redirect targets as
'cannot be restored from file-history backups' instead of omitting them.

**Source** — ~/.claude/projects/**/*.jsonl tool_use.input.command;
~/.local/share/opencode/opencode.db part.data $.state.input where $.tool='bash';

**Limit** — Targets containing variables, globs or heredoc-generated names cannot be resolved and
are reported as 'N writes with unresolved target' — never dropped and never counted as zero. The
segment parse is a shell-shaped heuristic, not a shell: quoting edge cases and process
substitution degrade to 'unresolved'.

*Corrects the earlier entry "Out-of-repo write and agent self-modification rules (scope_escape,
agent_config_modified) (Tier 2), whose ⚠ declares Bash redirection out of scope".*

### 30. Destructive-command classifier with cwd-relative blast radius

`Authority` · `Platform` · **M** · exact · 4/5

Corrects the v1 classifier, which stores class, hash, outcome and permission mode but never
resolves what the command would actually have destroyed - the difference between the 387 harmless
`rm -f` calls here and a cleanup command that expands to ~/ and takes the Keychain with it. Adds
target_scope in {inside_cwd, outside_cwd, home, root, unresolved}, computed by expanding ~, $HOME
and a leading / against the entry's own cwd, with 'unresolved' whenever the string contains a
variable or command substitution Vole cannot expand - never a guess. Verified classes in the 6,543
command strings on this machine: rm -f 387, rm -rf 77, sudo 68, rm -r 8, base64 -d 1, find -exec
1.

**In the app** — Incidents row shows the class, the masked command (path segments replaced by
their class), the resolved scope and the posture chip; the session sheet's behaviour report card
gains a blast-radius column counting calls per scope.

**Source** — ~/.claude/projects/*/*.jsonl tool_use.input.command with the entry's own cwd;
~/.codex/sessions/**/rollout-*.jsonl function_call.arguments.{cmd, workdir};

**Limit** — Claude records no exit code on success and only 'Exit code N' text on some failures,
so the outcome stays an enum {ok, exit:N, interrupted, timed_out, denied, unknown} and 0 is never
assumed.

*Corrects the earlier entry "Destructive and outbound command classifier (destructive_command,
destructive_under_bypass)".*

### 31. pnpm verify --behaviour: ledger reconciliation and collector shape-drift counter

`Tool ledger` · `Procurement` · **L** · exact · 4/5

Principle 4 requires every new exact dataset to be reconciled, and the ledger is the largest one
yet. verify --behaviour independently recounts tool_use blocks and tool_result joins from the
transcripts (22,687 / 22,683 today), OpenCode tool parts (12,292), Devin toolCallId rows and Grok
exec_done lines, compares them with tool_calls, fails on any shortfall, and reports rows whose
source file has since been pruned as 'source deleted' rather than a failure.

**In the app** — Settings replaces the hard-coded 'Verification: Every stored row reconciled'
caption with the real last-run result per table including the behaviour tables, plus an 'unread
record shapes' line per collector; vole doctor --json carries the same fields for MDM collection.

**Source** — the same artifacts the collectors read, re-counted independently by verify.ts;
~/.vole/vole.db tool_calls;

**Limit** — Reconciliation can only prove Vole stored what was on disk when it ran; it cannot
prove the tool wrote everything it did, and the report must say so.

*Extends the earlier entry "Support and lifecycle policy with collector-format drift detection
(Tier 6) — pulled forward and given a real counter, plus the verify extension principle 4 already
demands".*

### 32. fetch_ingress: untrusted web bytes entering a session, with a size and a status code

`Behaviour` · `CISO` · **S** · exact · unscored

Claude's WebFetch results carry a four-field receipt that nothing currently reads —
`toolUseResult.{bytes, code, codeText, durationMs, url}` — giving the exact number of bytes pulled
from a named host, the HTTP status, and the latency. Adds `fetch_ingress(event_key, session_id,
ts, tool_use_id, host, url_path_hmac, bytes, http_status, duration_ms, source)` with the hostname
stored in clear because the hostname is the finding, and the path HMACed under the existing
Keychain key.

**In the app** — An Ingress band on the Behaviour panel: hosts ranked by bytes with call count and
status mix, non-2xx marked, and a jump from any `install_after_ingress` or `denied_then_achieved`
incident straight to the fetch rows inside its window.

**Source** — ~/.claude/projects/**/*.jsonl: toolUseResult.{bytes,code,codeText,durationMs,url} on
WebFetch results (63 rows, 10,772,168 bytes, 6 distinct hosts)

**Limit** — `bytes` is what the fetcher received, not what entered the model's context — the tool
truncates before injection and the transcript never says by how much, so the row reports received
bytes and marks context-entered as unknown rather than guessing.

*Extends the earlier entry "context_edges: every command that left this machine, by transport and
destination".*

### 33. sensitive_read_unasked: sensitive-path access joined to authority and posture

`Authority` · `CISO` · **M** · partial · 4/5

v1's protected-path ledger records that a sensitive path was touched; this adds the two columns
that turn it into an incident - the call's authorization_basis and the autonomy in force. A
versioned path-class table maps tool arguments to {ssh_private_key, cloud_credentials,
agent_credentials, dotenv, keychain, npm_token, kube_config, browser_profile}, and
sensitive_access stores class + salted sha256 of the normalised path + count, never the path
itself;

**In the app** — The session detail sheet gains a 'Sensitive access' matrix - path class down the
side, authorization_basis across the top, counts in the cells, red cells clicking through to the
individual calls with their timestamps and posture - and the same counts roll up per employee in
Breakdown.

**Source** — ~/.claude/projects/*/*.jsonl message.content[].tool_use.input (Bash.command,
Read.file_path, Glob.pattern); ~/.codex/sessions/**/rollout-*.jsonl function_call.arguments.cmd
and custom_tool_call.input;

**Limit** — Only paths that appear literally in a tool argument are visible: a read performed
inside a script the agent invoked, behind a shell glob Vole cannot expand, or through a variable
is invisible, so every count is a floor and is labelled one.

*Extends the earlier entry "Sensitive-file access ledger and protected_path_access rule".*

### 34. tool_failure_storm, and error_storm narrowed to API errors

`Behaviour` · `Platform` · **M** · exact · 3/5

Split detect/error-storm.ts in two. error_storm keeps only assistant-level API failures and stops
counting activity_only rows: 7 of the 10 live error_storm incidents are Grok 403 spending-limit
rows, which is quota exhaustion misfiled as a failing tool. tool_failure_storm is a new rule over
the tool_calls ledger keyed on (tool, session, tool_name), firing at five or more failed calls of
a single tool name with a failure ratio above 0.2, and it names the tool that is failing rather
than the session.

**In the app** — Incident feed gains a 'failing tool' column and the quota rows move to the quota
surface; the Behaviour panel shows a per-tool-name failure-ratio bar per session with the unknown-
outcome count beside it.

**Source** — tool_calls.{status, exit_code}; usage_events.is_error for the narrowed API rule;

**Limit** — Claude records no exit code on success and only free text on some failures, so a Bash
failure the model does not mark is_error is invisible; the rule must read 'k failures of n calls
with a recorded outcome' and print the unknown-outcome count beside it, never a ratio over all
calls.

*Corrects the earlier entry "tool_calls ledger with tool_result error join".*

### 35. Read completeness on the tool ledger, and the paged_bulk_read rule the per-call view can never see

`Tool ledger` · `CISO` · **M** · exact · unscored

Claude records how much of a file it actually delivered and how big the file was —
`toolUseResult.file.{numLines,startLine,totalLines,truncatedByTokenCap}` — and, when a read
overflows, writes an `attachment` of type `read_truncation_notice` whose banner carries the whole
file's token size against the cap (`95528 tokens, cap 25000`).

**In the app** — Each Read row on the tool-ledger drill-down shows 'lines 1–2 of 67' with a
completeness bar; `paged_bulk_read` incidents land on the Triage queue with the page windows
listed and the covered fraction as the observed figure against the rule's threshold.

**Source** — ~/.claude/projects/**/*.jsonl:
toolUseResult.file.{numLines,startLine,totalLines,truncatedByTokenCap} (1,361 rows; totalLines
486,630 vs numLines 127,213;

**Limit** — This counts lines the tool handed over, not bytes, and not what the model retained
after its own context handling; a file re-read after an edit would inflate coverage, so the rule
keys on distinct line ranges rather than call count.

*Corrects the earlier entry "file_exposure ledger (which file content entered which model
context), including path-only rows".*

### 36. posture_escalated and policy_downgraded within a session

`Authority` · `CISO` · **M** · partial · 4/5

A rule pair over autonomy_intervals that adds no new parsing. posture_escalated fires when a
session's autonomy rank increases (prompt_each < classifier_gated < accept_edits < full_auto) and
at least one tool call executes inside the higher interval; policy_downgraded fires on the Codex-
only confinement axis when a session moves permission_profile managed -> disabled, or
sandbox_policy.type read-only/workspace-write -> danger-full-access, quoting both turn ids and
timestamps.

**In the app** — Incidents pane row carries both mode strings and the transition time inline
('classifier_gated -> bypassPermissions at 08:04:41, 62 calls after');

**Source** — autonomy_intervals (Claude permissionMode / auto_mode attachments, Codex
turn_context.{approval_policy, sandbox_policy.type, permission_profile});
tool_calls.authorization_basis for the preceding denial

**Limit** — A transition proved only by an untimestamped type:"permission-mode" line is placed at
the following timestamped entry, so the escalation time carries up to one entry of error and the
incident text says so. A session launched already in bypass is not an escalation and must not fire
here - that is headless_bypass_launch's job.

*Extends the earlier entry "Permission-mode and sandbox posture per session (normalised autonomy
column)".*

### 37. stuck_tool_call and the per-session concurrency ceiling

`Behaviour` · `Platform` · **S** · exact · 3/5

From the tool_calls ledger, a call with an issued_ts and no bound outcome after N minutes while
the same session kept issuing calls is a stuck_tool_call incident naming the tool and its argument
skeleton. The condition is observable on disk today: OpenCode's part.data holds 2 rows in
state.status='running' with no end time, while Claude has 0 unmatched of 22,018 tool_use ids, so
on Claude the rule fires only on a genuinely hung or killed session rather than as routine noise.

**In the app** — Behaviour panel 'in flight' counter per live session with a high-water mark, and
a stuck-call row in the incident feed carrying the age of the unbound call and the tool that owns
it.

**Source** — tool_calls rows with result_ts IS NULL; opencode part.data $.state.status='running';

**Limit** — A stuck row cannot distinguish 'still running' from 'the process died' without PID
liveness, so the incident reads 'no outcome recorded after N minutes' and offers no cause. A
crashed agent leaves rows unbound forever;

### 38. action_targets: the target-system resolver with an explicit resolution chain

`Tool ledger` · `CISO` · **M** · exact · unscored

One row per ledger call that names a system outside this filesystem, resolved by a target-
extraction rule set added to round-2's versioned pattern pack (same pattern_id/pack_version, not a
second parser). Adds `action_targets(call_id,
target_kind{cloud_account|k8s_context|database|vcs_repo|package_registry|saas|remote_host},
target_label, locality{loopback|remote|unknown}, env_class{prod|staging|dev|unknown},
reversible{yes|no|unknown},
resolution{literal|shell_var_from_file|context_file_default|flag|unresolved}, evidence_path)`.

**In the app** — A Target column on every ledger row in the Behaviour drill-down (label + a
locality dot + an env chip only when declared), and a target inspector popover that prints the
resolution chain verbatim: `$DB_URL ← DATABASE_URL in
<redacted-local-path>`.

**Source** — Claude Code `content[].tool_use.input.command` (Bash) and `input` for MCP calls;
Codex `function_call.arguments.cmd`/`workdir` (exec_command) and `custom_tool_call.input`;

**Limit** — A resolved label is what the string and the local files say, not what a credential
resolved to at the server: an exported AWS_PROFILE/KUBECONFIG or a `--context` flag overrides the
file (only 1 of 18 kubectl commands here carried `--context`, so 17 rows are tagged
`context_file_default`, flag absent).

*Related to the earlier entry "Destructive and outbound command classifier (destructive_command,
destructive_under_bypass)".*

### 39. Autonomy clock: unattended_run rule and the daily exposure rollup

`Behaviour` · `CISO` · **XL** · partial · 5/5

v1 measures autonomy from turn_duration, which exists on 14 entries in the entire store; measure
it from the ledger instead, where it works on all 22,018 matched Claude tool calls plus OpenCode
and Devin. Per session, compute the longest chain of consecutive tool calls with no human-authored
user entry between them, in wall-clock minutes and call count, plus calls_per_human_turn — a
human-authored entry being identified by entry shape (a user entry carrying no tool_result block),
never by reading content.

**In the app** — Behaviour panel per-session strip showing human turns as ticks against a
continuous autonomy bar, plus a menu-bar badge when a live session crosses the threshold;

**Source** — tool_calls.issued_ts; Claude user entries without tool_result blocks;

**Limit** — A human watching silently is indistinguishable from an absent human — the metric is
'no human input recorded' and every surface must word it that way.

*Extends the earlier entry "Human intervention, autonomy duration, self-scheduling and idle/zombie
sessions".*

### 40. Remote-database action ledger and the remote_database_write / destructive_schema_change rules

`Authority` · `CISO` · **M** · exact · unscored

The Replit shape, made local and exact. For every call whose target_kind is `database`, parse the
statement class out of the client's own argument — `psql -c`, `mysql -e`, `mongosh --eval`, plus
migration subcommands (`drizzle-kit push`, `prisma migrate reset`, `alembic downgrade`) — into
`db_actions(call_id, client, statement_class{read|write|ddl|truncate|drop|migrate_reset},
object_names, target_ref)`, storing only the class and the identifier names, never the literal SQL
or any value.

**In the app** — An incident card on the Behaviour screen whose figures row is the target line,
the statement class and the object names, with the resolution chain expanded inline; the same rows
roll into the Blast Radius screen grouped by database.

**Source** — Bash/exec command strings already parsed in-collector, joined to action_targets; the
.env key named by the command, read at the recorded cwd (host/port/dbname only).

**Limit** — Claude Code records no exit code, so the incident says 'ran', never 'deleted', and
never a row count; OpenCode's `part.state.metadata.exit` and Grok's `exec_done.ctx.success` do
carry an outcome, so the wording is driven by round-2's status_source rather than assumed.

*Corrects the earlier entry "Destructive and outbound command classifier (destructive_command,
destructive_under_bypass)".*

### 41. context_edges: every command that left this machine, by transport and destination

`Tool ledger` · `CISO` · **M** · exact · unscored

The inverse of the gap and the strongest signal on this machine: the monitored agent is itself the
vehicle into unmonitored contexts, and every crossing is on this disk in full. Riding the tool-
call ledger's command-shape pass, classify each Bash/shell call by transport verb and record only
the transport and the destination label — never the command body. Measured here across 12,520 Bash
tool_use blocks in 641 transcripts: ssh 631, docker 286, scp 29, kubectl 19, rsync 12, modal 7,
devcontainer 7, colima 5, podman 2, limactl 2, tart 2, runpod 2, gh codespace 1, vagrant 1, sshfs
1, mosh 1;

**In the app** — Behaviour panel gains a Crossings lane on the session timeline: one mark per
edge, coloured by transport, with the destination label and the ledger jump. The Session card
header reads 'this session executed on N hosts Vole does not monitor'.

**Source** — Claude Code transcript `message.content[].tool_use` where name is Bash —
`input.command` parsed in the collector pass only; Codex `response_item` local_shell_call and
custom_tool_call;

**Limit** — Only the skeleton survives: transport, destination label and a pattern id for the
remote verb — Vole cannot know whether the remote command ran, succeeded, what it touched, or
whether an agent was launched there.

*Extends the earlier entry "Command-shape skeleton and versioned pattern pack (pattern_id +
pack_version, not just a hash)".*

### 42. subagent_inherited_bypass: autonomy propagation down the agent tree

`Behaviour` · `CISO` · **XL** · partial · 5/5

A subagent never gets its own permission dialog — it inherits the parent's posture at spawn — so
autonomy_intervals gains autonomy_inherited and depth, populated from the agent_edges tree plus
three vendor facts: Claude's <session>/subagents/**/agent-*.jsonl children (parent session given
by the containing directory), Codex session_meta.payload.source.thread_spawn{parent_thread_id,
depth, agent_nickname} (2 rollouts here), and Grok's 'subagent spawn credentials' log line,
verified on this machine to carry subagent_id, subagent_type, effective_model, base_url,
auth_type, parent_model and context_window, paired with a 'subagent completed' line carrying
tool_calls, turns, success and cancelled.

**In the app** — The session-detail agent tree renders each child with an inherited-posture chip
and a lock icon when its endpoint differs from the parent's; the incident lists the subagent type,
its call count and the parent's posture at the moment of spawn.

**Source** — ~/.claude/projects/**/<session>/subagents/**/agent-*.jsonl and agent-*.meta.json;
~/.codex/sessions/**/rollout-*.jsonl session_meta.payload.source.thread_spawn;

**Limit** — Claude's subagent metadata carries no timestamp, so the child's lifetime is anchored
on its own transcript's first and last line rather than the parent's clock. spawnDepth is 1 on all
479 metas here and no nested subagents directory exists, so depth >= 2 is untested.

*Related to the earlier entry "Subagent and workflow fan-out monitor (fanout_burst)".*

### 43. Remote-execution hop ledger (ssh, docker, kubectl exec) and remote_privileged_exec

`Authority` · `Platform` · **M** · exact · unscored

cwd-relative blast radius is not merely incomplete for these calls, it is meaningless: the command
runs on another machine. `remote_exec(call_id,
transport{ssh|scp_rsync|docker_run|docker_exec|kubectl_exec|fly_ssh}, host_ref, remote_user,
inner_pattern_id, inner_class)` records the hop and re-runs the same pattern pack over the inner
command against the remote target. Host identity is deduped through ~/.ssh/config so an alias and
a literal address collapse to one target: 313 ssh invocations here carry an inner command, 182
resolved by alias and 131 literal, and 195.242.30.141 appears both as itself (128) and as `h200`
(17).

**In the app** — A 'Left this machine' band at the top of the Behaviour screen listing each remote
host with its alias, the count of hops and the worst inner class; clicking a hop shows the outer
and inner commands as two separate masked skeletons.

**Source** — Bash/exec command strings; ~/.ssh/config Host/HostName/User (name-only);

**Limit** — Vole sees the instruction, never the remote result — there is no evidence the remote
host executed anything, so rules read 'sent to', not 'ran on'. A host reached only by IP with no
ssh_config entry stays a bare address with no environment class.

*Related to the earlier entry "Exfil-shaped command detector (possible_exfil,
sensitive_read_then_egress)".*

### 44. Asset resolution chain: stamped at insert, widened only into NULLs

`Tool ledger` · `Platform` · **L** · exact · unscored

One resolver used at insert by secret_sightings, dlp_egress, action_targets, context_edges and the
tool_calls file/command targets, adding asset_id, asset_tier, asset_match and asset_rev to each
ledger. The chain is explicit, first hit wins, and the winning link is stored: (1) repo_remote_log
from Codex session_meta.git.repository_url (present here as launchsafe/engine ×16, openai/codex-
security ×9, launchsafe/vole ×5, launchsafe/platform ×3), normalised by lowercasing the host,
stripping user-info and a trailing `.git` so `…/vole` and `…/platform.git` collapse to one
identity;

**In the app** — An 'Asset' column on Leak Ledger, Blast Radius and the tool-call drill-down: tier
chip plus asset_id, with the chain link in the cell tooltip ('matched by repo remote on disk,
register v7'), an em dash for unresolved and the literal words 'no target' for no_target.

**Source** — ~/.codex/sessions/**/rollout-*.jsonl session_meta.git.repository_url; <cwd
ancestor>/.git/config remote origin url;

**Limit** — Link (2) is time-of-resolution, not time-of-event:
<redacted-local-path> holds 893 stored events and has no .git today, so no
remote link can ever fire for that history — it stays on globs or unresolved. A repo re-pointed at
a new remote changes future rows only;

### 45. install_after_ingress: bounding the ingress-then-action rule so it can actually fire

`Behaviour` · `CISO` · **S** · partial · unscored

v1's `ingress_then_privileged_action` escalates when untrusted ingress is followed by any Bash or
Write in the session, which on this machine means nearly every session — 12,521 Bash calls sit
downstream of some fetched content, so the rule as specified is unusable. The correction is
adjacency plus a closed action set: fire only when a target-bearing action (a package_exec, a
remote_exec hop, a remote_database_write, or a secret_store_read) occurs within N ledger ordinals
of a tool result whose source was an MCP server, a WebFetch, or a read outside the repo — the
exact Agentjacking sequence — and store the ingress call_id and the ordinal distance on the
incident so a reader can check it.

**In the app** — On the incident card, a two-row mini-timeline: the ingress call (server or host
name, never the content) above the action call with its target, and the measured ordinal gap
between them.

**Source** — Round-2's tool_calls ledger ordinals; Claude Code `mcp__*` tool names
(mcp__playwright__*, mcp__searxng__*, mcp__github__* all present here) and WebFetch entries;

**Limit** — Adjacency is correlation, never causation — the incident says 'followed', not 'caused
by'. The window N is a policy threshold stored on the finding, and a slow attack that waits out
the window never fires.

*Corrects the earlier entry "Offline injection-indicator scans: MCP tool descriptions and ingress
content (ingress_then_privileged_action)".*

### 46. VCS action ledger from the agent's own gitOperation record

`Authority` · `Eng mgr` · **M** · exact · unscored

Claude Code writes a structured, vendor-emitted record of what a git command actually did —
`toolUseResult.gitOperation` — and nothing in Vole reads it, though it is not in the 41-field
inventory either: 109 rows here, including `{"push":{"branch":"main"}}` 26 times,
`{"commit":{"branch":…,"kind":"committed","sha":"33326fc"}}`, and
`{"branch":{"action":"merged","ref":…}}`.

**In the app** — A Repositories block on the Blast Radius screen: one row per repo with pushes,
commits with their short shas, merges and any visibility change, each row badged `structured` or
`parsed` so a reader knows which figures came from the agent's own record.

**Source** — Claude Code `toolUseResult.gitOperation` and `returnCodeInterpretation` on user lines
(both currently skipped at claude-code.ts:93); Bash command strings for the gh operations;

**Limit** — gitOperation names the branch and sha but never the remote, so the repository identity
is a join through the cwd and is labelled as such; if the working copy moved or the remote
changed, repo_ref is NULL rather than a guess.

*Related to the earlier entry "Agent-authored commit scan and revert rate".*

### 47. Kiro ACP ledger: tool calls carrying the vendor's own policy verdict and the human's answer

`Tool ledger` · `CISO` · **M** · exact · unscored

Kiro's session.json holds posture but no tool calls; ~/.kiro/logs/<launchStamp>/kiro.log does, as
plain JSONL {timestamp, level, message}. Parse: agent_controller.triggered {agentType,
autonomyMode, modelId};

**In the app** — Behaviour panel gains Kiro executions as intervals with an approval lane beneath
them: each call shows allow / ask, the capability, and for asks the human's answer and how long
they took. Every ungated call names the rule that allowed it.

**Source** — ~/.kiro/logs/<YYYYMMDDThhmmssSSS>/kiro.log; joined to
~/.kiro/sessions/<hash>/sess_<uuid>/session.json and ~/.kiro/session-index/<hash>.jsonl

**Limit** — The log carries no token counts, and 'Request payload: 78987 chars' is characters — it
goes in a payload_chars column and is never divided by four to make tokens. Log directories are
per-launch with no documented rotation contract, so a pruned launch is an evidence gap and must be
counted as one.

*Extends the earlier entry "Four-state authority on every tool call (denied / pre-authorised /
posture-waived / no record)".*

### 48. Posture-weighted severity across every rule

`Behaviour` · `CISO` · **L** · partial · 4/5

v1 lands permission posture as a column and then writes only two dedicated rules on it, leaving
the five existing rules posture-blind — a burn-rate spike during a bypassPermissions run reads
identically to one during a supervised session. Give detect/index.ts a third context argument
postureAt(session, ts) => autonomy and have every rule escalate one severity step when the
incident window overlaps a full_auto interval, writing the reason into detail verbatim
('escalated: session was in bypassPermissions for 100% of this window').

**In the app** — Incident rows gain a posture chip (bypass / auto / default / unknown) and an
upward arrow where severity was raised, whose tooltip names the interval that caused it; Settings
gains a 'raise severity under full autonomy' toggle so the escalation policy is inspectable.

**Source** — autonomy_intervals joined to anomalies.window_start/window_end; Claude permissionMode
entries in ~/.claude/projects/**/*.jsonl;

**Limit** — Escalation applies only where posture is known. A NULL interval must leave severity
untouched and never silently downgrade, and the incident must read 'posture unknown for this
window' so a clean-looking feed is not mistaken for a safe one.

*Corrects the earlier entry "Permission-mode and sandbox posture per session (normalised autonomy
column)".*

### 49. agent_wrote_persistence and the PATH-precedence fact

`Authority` · `CISO` · **M** · exact · unscored

The machine_persistence class plus the one structured fact the class alone misses. When the
changed file is a shell rc, the collector diffs the parsed PATH assignment between pre- and post-
image and records `path_entry`, `position` (prepend or append) and `dir_writable_by_principal`
from a single stat — a prepend of a principal-writable directory is what decides which binary runs
at the next login. The other targets come from the same ledger and the Bash write-target resolver:
`.git/hooks/*`, `~/Library/LaunchAgents|LaunchDaemons`, `/etc/paths.d`, any `.app/Contents/**`
path, `crontab`, and `git config core.hooksPath`.

**In the app** — The machine half of 'what the agent left behind' on Blast Radius, sorted above
the repo half, each row showing target, session, posture at the time, whether a human was present,
and for PATH rows the position and writability verdict.

**Source** — ~/.claude/projects/**/*.jsonl `toolUseResult.{filePath, originalFile, oldString,
newString}`; Bash `input.command` write-target resolver rows (rc appends, `.git/hooks/` and
LaunchAgents paths all present in this machine's 12,879 Bash calls);

**Limit** — This records that the agent wrote the file, not that the line is still there — Vole
does not re-read shell rc files, so a later manual revert is invisible and the row must read
'written on <date>', never 'present'. Persistence installed by a package installer, by `launchctl`
outside a monitored tool, or by a process Vole never sees leaves no row here;

### 50. Grant deposits: the credential the agent handed to something else

`Authority` · `CISO` · **M** · partial · unscored

Round 2 ledgers the credentials an agent pulled out of a vault; nothing ledgers the ones it put
in, which is the direction that permanently widens someone else's authority. A `grant_deposits`
table classifies the command shapes that do it: `gh secret set` / `gh variable set` / `gh workflow
enable|run`, `aws iam attach-*|put-*-policy|create-access-key`, `gcloud * add-iam-policy-binding`,
`kubectl create secret` and RBAC `apply`, `vault kv put`, `wrangler secret put`, `heroku
config:set`, `terraform apply`.

**In the app** — A 'granted to' column on Blast Radius rows whose target is outside this machine,
and a cross-link from the Leak Ledger finding to the deposit that reused the same fingerprint —
one line that says the key in this repo's .env is now also in that repo's Actions secrets.

**Source** — Bash/exec `input.command` strings already in the tool-call ledger (Claude
`content[].tool_use.input.command`, Codex `exec_command.arguments.cmd`, OpenCode `part` tool
`bash` `state.input.command`); fingerprint join to secret_sightings.

**Limit** — Parsed from the command string, so it records an attempt to deposit, not confirmation:
Claude gives an outcome enum from stdout/stderr and interruption but no exit code on success, so
`outcome` stays `unknown` rather than `ok`. A credential passed by file, env var or stdin has no
name to record and `secret_name` is NULL.

### 51. sandbox_claim_violated and network_claim_violated (Codex declared vs observed)

`Authority` · `CISO` · **L** · partial · 3/5

Codex is the only agent here that writes a machine-readable confinement claim per turn -
turn_context.payload.sandbox_policy.type, permission_profile.file_system.entries[].access,
permission_profile.network and workspace_roots (present in 14 rollout files here) - and the
collector discards every one of them today (codex.ts:113-116). The rule falsifies the claim
against the observed call: sandbox_claim_violated fires when function_call.arguments.workdir
(present on 254 lines here, optional per call, falling back to workspace_roots[0]) or a path
resolved out of exec_command.cmd falls outside workspace_roots while sandbox_policy.type is 'read-
only' or 'workspace-write';

**In the app** — The Posture tab gains a per-session 'declared vs observed' strip: declared
sandbox and network policy on the left, counts of conforming and non-conforming calls on the
right, and each non-conforming call listed with its resolved scope and the turn id that declared
the claim.

**Source** — ~/.codex/sessions/**/rollout-*.jsonl turn_context.payload.{sandbox_policy.type,
permission_profile.file_system.entries, permission_profile.network, workspace_roots};
function_call.arguments.{cmd, workdir};

**Limit** — Codex's own sandbox may well have blocked the call: Vole sees the attempt and, from
function_call_output, whether it errored, but never the sandbox's reason, so the incident reads
'attempted outside the declared root' plus the outcome enum and never 'the sandbox failed'.

### 52. cross_scope_read_then_publish rule

`Authority` · `CISO` · **M** · partial · 3/5

The GitHub MCP toxic-agent flow in rule form: within one session, a read-class call whose target
resolves to scope A is followed within a bounded window by a publish-class call to a different
scope B. Scopes come from MCP tool arguments (owner, repo, url, path, host) and from filesystem
paths resolved relative to cwd, reusing the destructive rule's path resolver; publish-class tool
names come from a versioned list covering mcp__*__create_pull_request, create_or_update_file,
push_files, add_issue_comment and mcp__*__send*, plus Bash `git push`, `gh pr create` and `gh
issue comment`.

**In the app** — Incidents detail draws a two-node arrow - read scope, elapsed time, publish scope
- above the list of calls in between, with that window's segment of the posture ribbon rendered
underneath.

**Source** — ~/.claude/projects/*/*.jsonl tool_use.name and tool_use.input for mcp__* tools (the
local MCP census includes github push_files, create_pull_request and add_issue_comment);
~/.codex/sessions/**/rollout-*.jsonl custom_tool_call.input and function_call.arguments.cmd;

**Limit** — Scope resolution is only as good as the server's argument names: an MCP server that
calls its repository argument something else resolves to scope 'unknown' and the rule does not
fire, so this under-reports by design rather than guessing.

*Extends the earlier entry "Exfil-shaped command detector (possible_exfil,
sensitive_read_then_egress)".*


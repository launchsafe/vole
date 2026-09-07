# Tier 4 — Data exposure: what sensitive data reached a model, and what is sitting on disk right now

[← Enterprise roadmap index](../ENTERPRISE-ROADMAP.md) · 25 features

The third leg of the stated vision, and the first tier that consumes the `onEntry` hook cut in
Tier 1. It answers the question a CISO actually asks — is my source code, are my customer records,
are my live credentials going into a model — with an answer that is defensible precisely because
Vole stores none of them. The substrate is a versioned detector pack with offline checksum
validators (keyword prefilter → provider regex → entropy with stopwords → keyed fingerprint
dedupe, the Gitleaks/detect-secrets/Nosey Parker lineage), an out-of-path scan engine with per-
sink byte cursors and a hard byte budget, and `secret_sightings` with a widening upsert. It covers
the at-rest sinks the agents write for you — Claude's spill files, file-history, shell snapshots
and rotating config backups, Codex thread_history, Copilot's own session store,
Cursor/Antigravity/Devin content sinks, and permission-allowlist inline commands — plus direction
tagging normalised across all six content-bearing collectors so 'a key was in a file we read' and
'a key was sent to Anthropic' are never the same row. Cross-sink fingerprint correlation gives
first-origin; a finding lifecycle distinguishes a test fixture from a rotated key from a
credential that reappeared live. It sits after identity because a leak finding with no principal
is a curiosity and a leak finding with a principal is an incident, and after the surfaces census
because the sink registry and the surface registry are the same discovery pass. The honest limits
are stated in the screen, not the footnotes: agents delete their own transcripts after roughly
thirty days, so the evidence has an expiry countdown and a backfill that runs oldest-first, and
the unreadable-bytes denominator prints beside every exposure figure.

Legend: `category` · `buyer` · effort **S**/**M**/**L**/**XL** · feasibility (*exact* =
readable from local data today, *partial*, *new instr.* = needs something written that does
not exist, *network* = crosses the network line) · value 1–5, 5 meaning a security lead blocks
the rollout without it. `unscored` came from a completeness sweep and skipped the verifier.

---

### 1. dlp_detectors: versioned detector pack with offline checksum validators

`Data exposure` · `CISO` · **M** · exact · 4/5

Detectors are rows, not code: dlp_detectors(id, pack_version, class, provider, keyword, regex,
entropy_floor, validator, severity) compiled into the SEA from a Gitleaks/Betterleaks-shaped TOML,
the way data/pricing.json is already frozen in at pricing.ts:55, so the rule set is inspectable
and diffable rather than buried in a parse loop. Validators run entirely offline -- CRC32 tail
check on GitHub gh[pousr]_ tokens, Luhn for PAN, mod-97 for IBAN, structural base64url decode for
JWT keeping only whether alg/iss/exp parse, PEM header plus DER length sanity -- because entropy
alone is a known false-positive engine (gitleaks#1830).

**In the app** — Settings -> Detection: pack version, rule count by class, last pack change date
and a 'rescan queued' badge with the bytes it will replay; every Data Exposure row shows the
detector id and the pack version that produced it.

**Source** — packages/core/data/dlp-detectors.toml (new, bundled into the SEA at build time like
data/pricing.json); dlp_detectors table read once at collector start

**Limit** — No network verification, so a shape that passes a checksum is never claimed to be a
live credential -- the UI says 'matched <detector>, checksum valid', never 'active key'. A rotated
key and a working key are indistinguishable locally.

*Extends the earlier entry "Secret pattern scanner with entropy gate (secret_findings)".*

### 2. Leak Ledger screen

`Desktop` · `CISO` · **L** · new instr. · 5/5

A Risk-group sidebar section listing secret sightings grouped by fingerprint, with columns class /
detector / direction / provider / tool / first-seen / occurrences / status, filter chips for
class, direction and status, and tabs splitting 'Sent to a model' from 'At rest'. The coverage
strip is pinned above the list so an empty result can never be read as 'clean'. Per the read-model
parity constraint the query is written twice — queries.ts and the DB.swift C-API port — and the
app remains a read-only consumer of ~/.vole/vole.db.

**In the app** — The screen itself, plus a critical-sighting count contributed to the menu panel's
security strip so a leak is visible without opening the dashboard.

**Source** — secret_sightings, dlp_coverage and dlp_egress tables via new queries.ts read models
and their DB.swift ports.

**Limit** — The app cannot write to the store (DB.swift opens READONLY with a read-write fallback
but performs no writes), so triage actions — mark fixture, mark rotated — go through the CLI until
a write path exists: the screen shows status but does not set it.

*Extends the earlier entry "Secrets surfaced in MCP, CLIs, digest and the incident-response
evidence bundle".*

### 3. key_residency: naming where else this key lives, so a spend gap stops being a mystery

`FinOps` · `FinOps` · **S** · exact · unscored

Under consented repo roots, read deploy and CI manifests for references to provider key NAMES -
.github/workflows/*.yml (secrets.X and env:), .gitlab-ci.yml, vercel.json, fly.toml, app.yaml,
serverless.yml, docker-compose*.yml environment:, Dockerfile ENV/ARG, Terraform variable blocks
and *.tfvars, and .env.production. Adds key_residency(repo, manifest_path, var_name, target_class
IN ('ci','container','paas','iac'), first_seen, last_seen, source), joined to provider_keys on the
variable name.

**In the app** — Reconciliation screen: a 'possible off-endpoint origins' expander under any gap
or not_comparable cell, listing repo, manifest path and target class. The same list appears as an
'Off this machine' block inside that key's row on the Shadow AI screen.

**Source** — .github/workflows/*.yml, .gitlab-ci.yml, vercel.json, fly.toml, app.yaml,
serverless.yml, docker-compose*.yml, Dockerfile, *.tf / *.tfvars, .env.production

**Limit** — A manifest reference is a reference, not a deployment: it cannot confirm the target
ever received the key, cannot see the value, cannot distinguish a live workflow from one dead for
a year, and cannot enumerate residencies that never touch this disk.

### 4. Exclusion enforced at open(), with a counted skip receipt

`Governance` · `DPO` · **M** · exact · unscored

The covered exclusion floor defines what is out of scope; this defines where the decision is taken
— before the first open() on a root, so an excluded root is never read rather than read and then
filtered. Every repo read routes through one openRootFile(root, relPath) chokepoint that refuses
an excluded root and refuses any relPath the manifest does not declare, with a self-check
asserting the sweep opened nothing outside the manifest and nothing under an excluded root.

**In the app** — The Repos band splits roots into readable / skipped-by-policy / unreadable with
counts on each, and every skipped row names the clause that excluded it; the Privacy Center's
path-receipt list gains the same rows, so a developer can prove their personal repo was never
opened.

**Source** — ~/.vole/policy/scope.json, ~/.vole/exclude.json; work_roots.origin_slug derived from
<root>/.git/config [remote "origin"] url and ~/.codex/state_5.sqlite threads.git_origin_url

**Limit** — Classification needs an origin. Here 34 of 58 roots no longer exist and 13 of the 24
survivors resolve to no git root, so 'unclassifiable' is the majority state;

*Extends the earlier entry "Inalienable exclusion floor for personal work on a corporate device".*

### 5. answerable_from: the horizon that makes "not seen" an answer instead of a shrug

`Platform` · `CISO` · **M** · exact · unscored

Computes, per (source × indicator_kind), the earliest timestamp at which a hunt over that ledger
can return a truthful negative, plus the basis that produced the bound. Bases are read, never
assumed: Claude Code's `cleanupPeriodDays` from settings.json/managed-settings.json (default 30 —
the vendor's own on-disk `~/.claude/cache/changelog.md` records the sweep covering
`~/.claude/projects`, `~/.claude/tasks/`, `~/.claude/shell-snapshots/`, `~/.claude/backups/`)
checked against the real mtime span of the retained transcripts (655 files spanning 23 days on
this machine); `npm config get logs-max` (10 here) bounding `~/.npm/_logs`;

**In the app** — A horizon bar pinned above every hunt result and mirrored as a band on the
Coverage strip: "answerable back to 15 Aug (23 d) — Claude transcripts 655 files; npm logs 10;

**Source** — ~/.claude/settings.json + managed-settings.json cleanupPeriodDays; mtime span of
~/.claude/projects/**/*.jsonl;

**Limit** — A horizon is the earliest evidence that still exists, not proof the evidence was
complete then — a collector that was down inside the window is a separate evidence_gaps fact and
the two must be read together. It also cannot see evidence a user deleted by hand, so the floor is
a floor on answerability, never a guarantee of coverage above it.

### 6. Out-of-path scan engine: dlp_scan_state cursors, keyword prefilter and byte budget

`Data exposure` · `Platform` · **L** · exact · 5/5

A DLP scanner cannot reuse collector_state.last_offset: claude-code.ts:85 reads from that offset
and commit() advances it after insert, so the day DLP ships the offset is already at EOF and zero
history is ever scanned. New table dlp_scan_state(sink_id PK, kind, cursor_kind, cursor_text,
cursor_int, inode, size_bytes, bytes_scanned, scan_debt_bytes, backfill_done, pack_version,
last_run_at) with a cursor shape per sink: byte-offset+inode for JSONL, `id < :cursor` for
OpenCode `part` (its ids are DESCENDING ULIDs, so an id cursor is a time cursor), (thread_id,
updated_at_ordinal) for ~/.codex/thread_history_1.sqlite, (mtime,size) for config sinks;

**In the app** — Settings -> Data sources gains one row per sink: cursor position, bytes scanned,
backfill progress bar, scan debt with estimated catch-up time, and an explicit 'never scanned'
state; a persistent banner appears when debt grows for three consecutive passes.

**Source** — ~/.vole/vole.db collector_state (existing, left untouched);
~/.claude/projects/**/*.jsonl byte offsets plus inode;

**Limit** — An in-place rewrite that preserves both size and inode is missed until the file grows.
The OpenCode id cursor breaks if OpenCode ever changes its id scheme, so the scanner must compare
id order against time_created each pass and fall back to a full scan flagged in coverage.

*Corrects the earlier entry "Secret pattern scanner with entropy gate (secret_findings)".*

### 7. Coverage and denominators: what Vole did not read

`Governance` · `CISO` · **L** · partial · 5/5

One shipped screen that refuses to let a partial number read as a complete one, on two axes.
Structural blind spots become a versioned table with a live status probed cheaply at scan time: no
Endpoint Security entitlement means no process-exec, per-process network flow or file-open events;
no Full Disk Access means ~/Library/Safari/History.db, other users' homes and TCC-protected
folders read as 'not granted' (one attempted read records which);

**In the app** — A 'Coverage' sidebar screen with two sections — blind spots (granted / not
granted / n-a, expandable to the reason and the remediation such as grant FDA or deploy the PPPC
profile) and per-sink scanned-versus-available bars; a coverage strip pinned above the Leak
Ledger;

**Source** — Probe results (attempted reads of ~/Library/Safari/History.db, /Users/*,
~/Library/Application Support/com.openai.chat); the shipped catalog of 22 tool profiles from
market-extracts local_artifacts_by_tool as the surface denominator;

**Limit** — The surface denominator is 'surfaces in Vole's catalog', not 'AI tools that exist',
and the screen must say so or it becomes the overclaim it exists to prevent. 'granted' means one
read succeeded at scan time, not that it will succeed later.

*Extends the earlier entry "Collector self-health: collector_runs, vole doctor, coverage matrix,
freshness attestation".*

### 8. 'Where it landed' chain panel: six hops, each badged with its evidence rank

`Desktop` · `DPO` · **M** · partial · unscored

The brief asks for a jurisdiction column; a column cannot show that the answer was inferred four
hops away. This draws one horizontal chain per selected leak or surface — session → principal →
account/plan → endpoint/recipient → region → terms — with each hop carrying the badge of the
evidence that produced it (measured / route-declared / pack-asserted / admin-authored / unknown),
and drawing an explicit visual break where a hop is NULL rather than closing the line.

**In the app** — A panel on the Leak Ledger detail and on each Shadow AI surface card, plus the
same chain rendered inline in an incident evidence bundle; hovering a hop shows the exact field
name and file path, and a global 'show only chains with a break' filter on the Processing
Register.

**Source** — joins terms_basis, recipient_state, residency_rank, processing_terms and
terms_overrides; every hop's evidence_ref points at an existing raw_ref path plus byte offset

**Limit** — The chain is only as honest as its weakest badge, and a chain rendered entirely in
pack-asserted badges tells the reader nothing was measured — the UI must make that visually
obvious rather than uniform. Requires the read-model to be written twice (queries.ts and DB.swift)
or the app cannot draw it, and DB.swift must stay a read-only consumer.

### 9. secret_sightings ledger with a widening upsert, and the Data Exposure screen

`Data exposure` · `CISO` · **XL** · exact · 5/5

v1's secret_findings would inherit Vole's INSERT OR IGNORE habit and freeze last_seen, occurrences
and status at first sight exactly as db.ts:137 freezes anomaly severity today.

**In the app** — A new Data Exposure screen in the sidebar: coverage strip along the top, 'Sent to
a model' and 'At rest' tabs, findings grouped by detector class with a severity rail, filter chips
per direction.

**Source** — packages/core/src/schema.ts (new table via the add-nullable-column migration path at
db.ts:41-53); usage_events.raw_ref for the evidence pointer;

**Limit** — occurrences counts appearances in transcripts, not API requests: Claude Code writes
each assistant message 2-3 times as it streams, so the figure is an upper bound on transcript
copies and says nothing about how many requests carried the value.

*Corrects the earlier entry "Secret pattern scanner with entropy gate (secret_findings); also the
surface half of 'Secrets surfaced in MCP, CLIs, digest and the incident-response evidence
bundle'".*

### 10. Keychain-held fingerprint key with epoch rotation

`Data exposure` · `DPO` · **M** · partial · 3/5

v1 puts the HMAC key in ~/.vole/hmac.key, inside the home directory of the very agents Vole
watches -- Claude Code Bash and Codex custom_tool_call demonstrably read dotfiles, and a stolen
key turns fingerprints of low-entropy secrets into a brute-forceable rainbow set. Store 32 random
bytes as a generic password item (security add-generic-password -a vole -s computer.vole.dlp -w)
and read it once per collector start by spawning /usr/bin/security through node:child_process,
which keeps the SEA zero-dependency and native-module-free as the bundling constraint requires. A
key_epoch integer is stored alongside every fingerprint;

**In the app** — Settings -> Privacy: 'Fingerprint key: login keychain (epoch 1)', a Rotate
button, and the count of sighting rows that would become uncorrelatable if rotated; the badge
reads 'file (0600)' in red on any host where the keychain path was unavailable.

**Source** — macOS login keychain via /usr/bin/security (spawn, no native module); ~/.vole/ holds
the epoch integer only, never the key

**Limit** — Any process running as the same user can read the item once the ACL is granted, so
this defends against file-scraping agents and repo scanners, not against malware already running
as the user. On a non-macOS host the collector falls back to a 0600 file and records
key_store='file' on every sighting so the weaker guarantee is visible rather than silent.

*Corrects the earlier entry "Secret pattern scanner with entropy gate (secret_findings)".*

### 11. Pre-match normalisation layer with a provenance badge

`Data exposure` · `CISO` · **S** · exact · 4/5

Everything Vole scans is JSON, so a value arrives as \"sk-...\" with escaped quotes and newlines,
and agents routinely percent-encode a token into a URL or base64 a file to move it -- naive
regexes miss all three. Before matching, each candidate string passes through JSON unescape (free
via JSON.parse), percent-decode, one level of base64 decode when a run of >=40 base64 characters
decodes to printable ASCII, a zero-width and bidi character strip, and a homoglyph fold (the Rules
File Backdoor class of hiding).

**In the app** — Data Exposure row badge: 'found after base64 decode' / 'found after URL decode' /
'found after zero-width strip' -- a strong signal on its own, and a filter chip so a CISO can list
only encoded sightings.

**Source** — claude-code.ts user-line content and content[].tool_use.input, codex
custom_tool_call.input and function_call.arguments, opencode part.data.state.input -- all
currently read into memory and discarded

**Limit** — One decode level only. A double-encoded, gzipped, encrypted, or split-across-two-
messages value is not found;

### 12. Direction tagging normalised across all six content-bearing collectors

`Data exposure` · `CISO` · **M** · exact · 5/5

v1 tags direction from Claude entry shapes only, so every non-Claude sighting would be direction-
NULL. The mapping table: Claude last-prompt.lastPrompt, user.message.content[].text and
history.jsonl pastedContents -> human_pasted; assistant.message.content[].tool_use.input ->
agent_typed;

**In the app** — Filter chips per direction on Data Exposure, and a direction breakdown in the
digest so the monthly figure a CISO benchmarks is split by who did it rather than being one
aggregate number.

**Source** — claude-code.ts:93 skipped user/last-prompt lines (56% of transcript bytes here);
~/.claude/history.jsonl (18 pastedContents entries verified);

**Limit** — Cursor and Antigravity expose no per-message direction at all, so their sightings
carry direction = NULL rather than a guess. Claude's model_echoed is indistinguishable from a
mirror-write of the same message, so echoes are deduped by message id and counted once.

*Extends the earlier entry "Secret flow direction, in-context incident and secret_to_mcp_server".*

### 13. Claude's own at-rest sinks: spill files, file-history, shell snapshots and config backups

`Data exposure` · `CISO` · **M** · exact · 5/5

Claude Code writes tool output over its inline limit to a side file and points at it with
toolUseResult.persistedOutputPath / persistedOutputSize -- 148 such files totalling ~20 MB exist
under ~/.claude/projects/*/*/tool-results/*.txt on this machine right now.

**In the app** — The 'At rest' tab of Data Exposure, separate from 'Sent to a model', with per-
sink size, mode and world-readable columns and an age histogram; a posture card counting
credential-bearing config backups with a Reveal in Finder action per file.

**Source** — ~/.claude/projects/*/*/tool-results/*.txt (148 files, ~20 MB verified);
~/.claude/file-history (1,263 files, 11 MB verified);

**Limit** — For file-history copies and config backups Vole cannot tell whether the content ever
entered a prompt; those rows are at-rest-only by construction and reached_model is 0 or NULL,
never 1, for any sink not referenced from a request-bearing entry.

*Extends the earlier entry "Transcript-at-rest exposure inventory (vole secrets scan)".*

### 14. Codex thread_history content sink with an ordinal watermark

`Data exposure` · `CISO` · **S** · exact · 3/5

~/.codex/thread_history_1.sqlite is a second, fully structured copy of every Codex conversation
that no collector touches: thread_items(thread_id, turn_id, item_id, rollout_ordinal,
created_at_ms, item_json, item_type, updated_at_ordinal) where item_type is verified today as
agentMessage, commandExecution, mcpToolCall, reasoning, subAgentActivity, userMessage and
webSearch -- direction tagging for free with no shape inference -- and the monotone per-thread
updated_at_ordinal is exactly the incremental cursor the rollout JSONL files lack. Scanning it
also covers turns whose rollout file has rotated or whose parent/child session ids collide under
the codex.ts:197 key bug.

**In the app** — Its own sink row in the coverage strip; its sightings carry direction values with
zero inference, so they render with an 'exact direction' badge and are the highest-confidence
Codex rows in the ledger.

**Source** — ~/.codex/thread_history_1.sqlite (verified: 72 thread_items rows, item_type
distribution agentMessage 7 / commandExecution 20 / mcpToolCall 1 / reasoning 16 /
subAgentActivity 6 / userMessage 4 / webSearch 18; indexes idx_thread_items_updated_page and
idx_thread_items_user_messages already present, plus a 4.1 MB -wal)

**Limit** — Only 72 rows on this machine -- the store is new in this Codex build, so it must be
version-probed and treated as supplementary; if the table is absent the sink reports
bytes_available = NULL rather than being silently skipped.

### 15. Cross-sink fingerprint correlation and first-origin

`Data exposure` · `CISO` · **S** · exact · 4/5

One roll-up row per fingerprint across every sighting: the distinct tools, sessions, providers and
sinks that saw it, the earliest sighting with its direction and sink (the origin), whether it also
sits at rest in a config file or backup, and whether it crossed a provider boundary. This answers
the question a responder actually has -- 'this key: where did it come from, who sent it where, is
it still on disk' -- entirely from rows that never contain the value, and it is what makes the
HMAC fingerprint worth having rather than a per-file finding list.

**In the app** — Data Exposure's primary grouping switches from file to fingerprint: one row
expands into a timeline of sightings across tools and sinks with the origin marked and an 'also at
rest in N files' sub-line.

**Source** — secret_sightings roll-up view; no new parsing and no new source files

**Limit** — Identical fingerprints prove identical bytes after normalisation and nothing more -- a
truncated copy and a full copy of the same key are two different fingerprints, so every count is a
floor, never a total. Fingerprints computed under a previous key epoch are excluded from
correlation and flagged as uncorrelatable, never silently merged.

### 16. Evidence-expiry countdown and oldest-first backfill order

`Data exposure` · `CISO` · **S** · exact · 3/5

Claude Code deletes transcripts after cleanupPeriodDays (unset in ~/.claude/settings.json on this
machine, so the tool default applies) and stamps ~/.claude/.last-cleanup, which reads exactly
2026-09-07T05:13:50.752Z here. Vole reads the setting and that timestamp, computes
days_until_deletion per transcript file from its mtime, orders the DLP backfill oldest-first
instead of newest-first, and fires an evidence_expiring info incident when unscanned bytes sit
within three days of deletion.

**In the app** — The Data Exposure coverage strip gains an amber 'expiring' segment with a day
countdown; the incident feed carries evidence_expiring quoting the file count, byte count and the
exact deletion date derived from .last-cleanup plus the effective retention period.

**Source** — ~/.claude/settings.json cleanupPeriodDays (absent here -> labelled 'unset (tool
default applies)'); ~/.claude/.last-cleanup (verified 2026-09-07T05:13:50.752Z);

**Limit** — Vole must not copy or delete the evidence -- the constraints forbid writing outside
~/.vole and modifying third-party stores -- so it can warn but not preserve. A machine whose
collector was off for a month has that history gone permanently.

*Extends the earlier entry "History horizon and retention-loss disclosure".*

### 17. Copilot's own session store: a free file-to-tool ledger, and 227 prompts sitting on disk

`Data exposure` · `DPO` · **L** · exact · unscored

github.copilot-chat/session-store.db is a plain SQLite file opened read-only via node:sqlite.
sessions(id, cwd, repository, host_type, branch, agent_name, created_at, updated_at) — 8 here,
each carrying a real git remote such as https://github.com/<org>/<repo>.git, so work_roots gets
repositories the agent recorded itself with no repo sweep. session_files(session_id, file_path,
tool_name, turn_index, first_seen_at) is the file-to-tool ledger Vole assembles by hand everywhere
else, already normalised by the vendor, and lands in tool_calls with status_source='vendor_table'.

**In the app** — Data Exposure gains a Copilot sink card with its own retention line — rows here
start 2026-07-19, older than the 30 days Claude Code prunes at — plus the repositories on Blast
Radius and the file/tool rows on the Behaviour drill-down.

**Source** — <editor root>/User/globalStorage/github.copilot-chat/session-store.db (tables
sessions, turns, session_files, session_refs, checkpoints, search_index) and chatSessions
requests[].result.metadata.renderedUserMessage[].text

**Limit** — FTS5's default unicode61 tokenizer splits on '_' and '-', so sk_live_-shaped tokens
fragment: the index is a prefilter only, never the verdict, and any detector not expressible as a
token prefix falls back to the budgeted row scan. turns holds prompt and response but no tool
arguments, so a secret pasted into a tool input and not into the prompt is not here.

### 18. context_imports: one vendor's entire session handed to another, proved by a receipt that outlived the file

`Data exposure` · `CISO` · **S** · exact · unscored

Reads `~/.codex/external_agent_session_imports.json`, which Codex writes when it ingests a foreign
agent's transcript into an OpenAI thread: `{source_path, content_sha256, imported_thread_id,
imported_at}`, 50 records on this machine, every single `source_path` pointing into
`~/.claude/projects/`. Adds `context_imports(event_key='codex:import:'||content_sha256,
source_tool, source_path_hmac, source_dir_prefix, content_sha256, dest_tool, dest_thread_id,
imported_at, source_bytes, source_present)` and the rule `cross_vendor_context_import`.

**In the app** — A Cross-vendor transfers row on the Leak Ledger and on Blast Radius, each entry
naming source tool → destination tool, the destination thread id, the date, and a 'source no
longer on disk' state chip; clicking through offers the sha256 for evidence-bundle export rather
than any content.

**Source** — ~/.codex/external_agent_session_imports.json → records[].{source_path,
content_sha256, imported_thread_id, imported_at} (50 records; 50/50 source files no longer present
on disk)

**Limit** — The receipt proves a file was imported and names its hash; it says nothing about what
the file contained, and once the source is gone — 50 out of 50 here — `source_bytes` is NULL and
the content can never be re-derived, so this is a transfer record and never a leak verdict.

### 19. payload_sightings: the opaque-payload ledger, with on-disk and at-wire bytes kept apart

`Data exposure` · `CISO` · **L** · exact · unscored

Five parse sites across two collectors emit one row per payload that no regex can read: Claude
`message.content[].type=='image'` (`source.media_type`, exact decoded bytes from base64 length
arithmetic — never decoded, never stored), counted separately where it sits directly in a human
turn versus nested inside `tool_result.content[]`;
`toolUseResult.file.{base64,originalSize,dimensions}` for images the agent read off disk itself;
`toolUseResult.{persistedOutputPath,persistedOutputSize}` for Bash output too large for context;

**In the app** — Leak Ledger gains a second axis beside the finding count — 'bytes Vole read and
cleared' next to 'bytes Vole cannot read' — stacked per provider per principal, with a drill-down
list of payload rows (kind, media type, both byte columns, session) and no thumbnail, because no
content exists to render.

**Source** — ~/.claude/projects/**/*.jsonl:
message.content[].{type=='image'}.source.{media_type,data} (963 blocks: 911 inside
tool_result.content[], 52 direct human turns), toolUseResult.file.{base64,originalSize,dimensions}
(670 rows), toolUseResult.{persistedOutputPath,persistedOutputSize} (28 rows);

**Limit** — An image of a stack trace and an image of a customer record are indistinguishable —
this is exposure volume, never a leak verdict. 241 of the 911 tool-result image blocks came from
browser/MCP tools with no file behind them, so `bytes_on_disk` is NULL and the surface prints 'N
rows with no on-disk size', never 0.

*Extends the earlier entry "file_exposure ledger (which file content entered which model context),
including path-only rows".*

### 20. The unreadable denominator: no exposure figure renders without the bytes Vole could not read

`Data exposure` · `DPO` · **M** · exact · unscored

Adds `v_exposure_coverage(window, principal, provider, tool, scanned_bytes, unscannable_bytes,
unscannable_rows, rows_without_byte_count)` built from `payload_sightings.scannable` joined to the
text sinks the detector pack actually covered, and makes it a contract rather than a panel: every
Leak Ledger and Data Exposure aggregate joins it, and a read-model parity test in CI fails any
query that selects a scanned-bytes sum without also selecting the companion columns.

**In the app** — A coverage strip pinned to the top of the Leak Ledger and Data Exposure screens
reading 'cleared 12.4 MB of text · 182.8 MB structurally unreadable · 125 rows with no recorded
size', and a matching rung on the Evidence-ladder card so a surface with detectors but no readable
bytes can never be mistaken for a surface with nothing to find.

**Source** — Derived: payload_sightings (this round) joined to dlp_scan_state cursors and the
dlp_detectors pack coverage list; no new artifact read

**Limit** — 'Unscannable' means unscannable by the detector pack loaded on this machine at this
version, not unscannable in principle — a pack bump moves the line, so the view stamps
`pack_version` and the numbers are not comparable across bumps without saying so. It cannot tell
you whether the unreadable bytes contained anything sensitive;

### 21. Finding lifecycle: fixture auto-classification, rotation, and at-rest vs live reappearance

`Data exposure` · `Developer` · **M** · partial · 4/5

Without triage the ledger drowns in test data and gets ignored, which is how secret scanners die.
Before a sighting is promoted it is classified status='fixture' with a stored fixture_reason when
any of: the path matches **/{test,tests,fixtures,__mocks__,examples,docs}/**; the value matches a
known public example (AKIAIOSFODNN7EXAMPLE, RFC test IBANs, Stripe sk_test_/pk_test_,
4111111111111111);

**In the app** — Status chip transitions new -> fixture / rotated -> reappeared on every Data
Exposure row, with the fixture reason always displayed rather than the row being hidden; fixtures
collapse behind an 'N classified as fixtures' disclosure, and a rotated row carries an 'also still
on disk in N places' sub-line listing paths.

**Source** — secret_sightings.raw_ref path globs; the detector validator outcome from
dlp_detectors;

**Limit** — Fixture classification is heuristic, not proof: a real key living under tests/ is
downgraded to info, which is why the reason is always shown and the row is retained rather than
dropped. Public-remote detection reads git config only, so a private repo mirrored publicly
elsewhere is invisible.

*Corrects the earlier entry "Secret fixture allowlist, mark-rotated and
secret_reappeared_after_rotation".*

### 22. Cursor, Antigravity and Devin content sinks

`Data exposure` · `CISO` · **M** · partial · 4/5

v1's file_exposure ledger states outright that 'Antigravity and Devin contribute nothing'. All
three of these activity_only tools do carry content on disk. Cursor's tracked_file_content.content
holds raw source and ai_code_hashes.{fileName, fileExtension, hash} gives path provenance for AI-
written code;

**In the app** — These three tools currently show a 'no tokens' badge on every screen in the app;
the Data Exposure ledger gives them their first substantive rows, tagged 'no model attribution' so
the blank provider column reads as a known gap rather than an error.

**Source** — ~/.cursor/ai-tracking/ai-code-tracking.db tracked_file_content.content and
ai_code_hashes; ~/.gemini/antigravity-ide/brain/<id>/*.md;

**Limit** — None of the three records tokens or a model per message, so a sighting can name the
tool, the session and the file but not the model or endpoint that received it -- provider stays
NULL and the ledger must not infer one.

*Corrects the earlier entry "file_exposure ledger (which file content entered which model
context), including path-only rows".*

### 23. Non-Claude prompt-sink and credential-store registry

`Data exposure` · `CISO` · **L** · partial · 4/5

Agents Vole collects no usage from still write prompts and credentials to disk, and those files
are pure leak surface that no repo scanner opens. A sink registry inventories and then scans:
~/.gemini/settings.json telemetry.logPrompts (documented default true) and its outfile; Goose
~/.local/state/goose/logs/llm_request.*.jsonl (raw prompts and responses, last 10 kept);

**In the app** — A 'Prompt sinks' table on the Data Exposure At-rest tab: tool, path, size, mode,
prompt-logging flag, findings count, last scanned; a warning row when a tool's own configuration
is logging prompts, and a distinct grey row for 'installed, store empty'.

**Source** — ~/.gemini (33 MB present here; settings.json ABSENT so the logPrompts default is
documented, not observed);

**Limit** — Presence of a store proves the tool was installed, not that it is in use; an empty
file reports size 0, never 'no usage', and an absent config file means the vendor default applies
rather than that logging is off.

*Extends the earlier entry "Agent-config credential-at-rest and file-mode audit".*

### 24. Permission-allowlist inline-command secret scan with git-tracked escalation

`Data exposure` · `CISO` · **S** · partial · 3/5

Permission allow rules are command strings, not config values, so a token pasted into Bash(curl -H
"Authorization: Bearer ...") is invisible to every field-walking config auditor including v1's
credential-at-rest audit. Vole scans the string bodies of permissions.allow/deny/ask in
~/.claude/settings.json (verified today: 9 allow rules, 5 of them inline curl commands carrying
full raw.githubusercontent.com URLs and flags, 0 deny, 0 ask), every .claude/settings.local.json,
~/.claude.json projects[].allowedTools, and the Codex/Grok equivalents; then runs git check-ignore
and git ls-files read-only against the settings file itself.

**In the app** — Posture card 'Allowlist rules containing credentials: N (M in git-tracked
files)', drilling into the rule index, the file and the detector -- never the value; a critical
incident row when the carrying file is tracked, with the repo and the ls-files output quoted.

**Source** — ~/.claude/settings.json permissions.allow (verified 9 entries);
~/.claude/settings.local.json (77 bytes here);

**Limit** — allowedTools is present but empty on all 23 projects here, so that code path ships
unexercised against real rules. When the settings file lies outside any git repository,
tracked_state is NULL and never 'safe'.

*Extends the earlier entry "Agent-config credential-at-rest and file-mode audit".*

### 25. Just-in-time evidence viewer

`Data exposure` · `CISO` · **M** · new instr. · 4/5

The no-content constraint means a finding is a pointer, and a pointer alone cannot be triaged — a
responder needs to know whether that AKIA-shaped string sat in a fixture or in a production
terraform file. Selecting a sighting makes the app re-open the agent's own file at raw_ref and
byte_offset, in memory only, render plus-or-minus 200 characters with the matched span replaced by
[detector_id], and discard the buffer on deselect: nothing is written, cached, exported or sent to
the collector, and the ~/.vole store still holds no content. Opening it writes an info-severity
incident naming the viewer and the fingerprint, so the audit trail is the price of the capability.

**In the app** — A slide-over inspector on the Leak Ledger behind an explicit 'Show context'
action per row, disabled entirely in pseudonymous mode and when the finding came from a source the
viewer has no read grant for.

**Source** — secret_sightings.raw_ref + byte_offset resolved against the original agent transcript
on disk (~/.claude/projects/**, ~/.codex/rollouts, OpenCode parts); ~/.claude/.last-cleanup for
the expiry date.

**Limit** — This is the one place a human sees text adjacent to a secret, and it fails by design
once the source file is deleted or rewritten — a shifted byte offset renders 'context no longer
matches' rather than showing the wrong lines. It cannot prove the value was ever sent to a model;


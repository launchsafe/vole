/** Tools we can observe from purely local, on-device logs. */
export type Tool =
  | 'claude_code'
  | 'codex'
  | 'cursor'
  | 'antigravity'
  | 'opencode'
  | 'grok'
  | 'devin'
  | 'gemini'
  | 'copilot_cli'
  | 'goose'
  | 'amp'
  | 'continue'
  | 'aider'
  | 'vscode_chat'
  | 'clines'
  | 'ollama_local'
  | 'kiro'
  /** Machine-level rows (content_stale, export_drop, log_source_stopped, reconcile_gap): Vole itself, not an agent. */
  | 'vole';

/**
 * How much we actually know about a row's numbers. Only two states — there is no
 * "estimated" tier, by policy: a token count is either read verbatim from the tool's
 * own logs, or it does not exist.
 *
 * - `exact`         Token counts come verbatim from the tool's own logs. `total_tokens`
 *                   is a plain sum (or, for Codex, a delta) of real fields.
 * - `activity_only` The tool records that a call happened but persists NO token data.
 *                   These rows carry NULL tokens and are excluded from every token and
 *                   cost aggregate, so they can never inflate a total.
 */
export type Confidence = 'exact' | 'activity_only';

/** `seed` rows are demo data. Collectors only ever write `live`; the seeder only ever writes `seed`. */
export type Source = 'live' | 'seed';

export interface UsageEvent {
  event_key: string;
  tool: Tool;
  model: string | null;
  session_id: string | null;
  project: string | null;
  git_branch: string | null;
  ts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  cache_read_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  /** NULL when we hold no published rate for the model. Renders as an em dash, never $0. */
  cost_usd: number | null;
  confidence: Confidence;
  is_error: 0 | 1;
  stop_reason: string | null;
  source: Source;
  raw_ref: string | null;
  /** Comma-joined names of the tools this response invoked, when the source records them. */
  tools: string | null;
  /**
   * Which agent within the session made the call: NULL for the main thread, the tool's
   * own subagent id otherwise (Claude Code `agentId`, OpenCode child session). Subagent
   * calls share the parent's `session_id` so a session's spend is one tree.
   */
  agent_id: string | null;
  /** The model's context window as the tool itself reported it (Codex); NULL means "look it up". */
  context_window: number | null;
  /**
   * The response's own duration (ms), where the source states one — OpenCode's
   * time.created → time.completed. NULL means the source carries no duration:
   * an unknown, and generation-speed figures must say which rows they cover.
   */
  duration_ms: number | null;
  /**
   * Provenance of duration_ms: 'measured' = the source states the span;
   * 'turn_scoped' = estimated from inter-event gaps (includes queue and
   * permission time — the derived speed is a lower bound); NULL = unknown.
   */
  duration_kind: 'measured' | 'turn_scoped' | null;
  /** Insert-time origin stamps (ORIGIN spread in db.ts) — present on stored rows. */
  user?: string | null;
  machine?: string | null;
  subject_id?: string | null;
  execution_context_id?: string | null;
  /** When the collector observed the row — the observation-lag read model's numerator. */
  observed_at?: number | null;
  /** Why a cost_usd figure means what it means (see pricing.ts). */
  cost_basis?: import('./pricing').CostBasis | null;
  /** The pricing pack revision that priced this row. */
  pricing_rev?: number | null;
}

export type AnomalyRule =
  | 'billable_burn_spike'
  | 'repeat_call_loop'
  | 'error_storm'
  | 'rate_limit_pressure'
  | 'context_pressure'
  | 'unsanctioned_surface'
  | 'new_ai_surface'
  | 'rerouted_model'
  | 'denied_then_achieved'
  | 'denial_then_reshape'
  | 'remote_execution'
  | 'remote_database'
  | 'destructive_command'
  | 'tool_failure_storm'
  | 'stuck_tool_call'
  | 'headless_bypass_launch'
  | 'sensitive_read_unasked'
  | 'agent_wrote_persistence'
  | 'agent_self_authorised'
  | 'scope_drift'
  | 'install_after_ingress'
  | 'unattended_run'
  | 'context_edges'
  | 'subagent_inherited_bypass'
  | 'cross_scope_read_then_publish'
  | 'vcs_action'
  | 'fetch_ingress'
  | 'human_interrupt'
  | 'hidden_unicode_instruction'
  | 'mcp_endpoint_alias'
  | 'agent_pushed_data_off_device'
  | 'remote_privileged_exec'
  | 'destructive_schema_change'
  | 'paged_bulk_read'
  | 'daily_exposure_rollup'
  | 'tool_first_seen'
  | 'posture_escalated'
  // ── foundation additions: rule ids the roadmap features reference. A builder
  // whose rule is not here must widen this union in the same change — the
  // `as never` casts that landed rows under wrong ids are exactly the debt
  // these literals retire.
  | 'coverage_degraded' // tier2: readable root went unreadable (ok → eperm only)
  | 'agent_home_moved' // tier2: session under no known agent root
  | 'foreign_root_transcript' // tier2: event's project path missing on disk
  | 'ai_gateway_persistent' // tier2: launchd-declared AI gateway
  | 'provider_key_without_sanctioned_surface' // tier2
  | 'exposed_local_bind' // tier2: local model runtime bound off-loopback
  | 'shadow_account_on_corporate_repo' // tier3
  | 'account_switched' // tier3: session_identity account change mid-history
  | 'principal_conflict' // tier3: one machine, multiple OS users (or inverse)
  | 'secret_at_rest' // tier4: the DLP ledger's own rule id
  | 'cross_vendor_context_import' // tier4
  | 'unattended_full_access' // tier5
  | 'policy_downgraded' // tier5
  | 'shadow_mcp_server' // tier6: called, present in no local config
  | 'crown_jewel_read_unasked' // tier6
  | 'crown_jewel_egress' // tier6
  | 'tier1_remote_write' // tier6
  | 'crown_jewel_left_device' // tier6
  | 'content_stale' // tier6: pack older than its kind's floor
  | 'envelope_change_escaped' // tier6: write reached committed/pushed state
  | 'write_then_hide' // tier6: change made unreviewable (.gitignore &c)
  | 'repo_carried_grant' // tier6: committed permission allowlist
  | 'agent_config_with_dependency' // tier6: config whose lockfile-sha moved
  | 'install_hook_added' // tier6: lifecycle script planted at install
  | 'root_not_present' // tier6: tombstoned work root
  | 'mcp_instructions_changed' // tier6: server-instruction rug pull
  | 'untrusted_execution' // tier6: workspace-trust flip
  | 'security_envelope_changed' // tier6
  | 'noise_budget_exceeded' // tier7
  | 'source_rewritten' // tier7: chained prefix digest mismatch
  | 'log_source_stopped' // tier7: dead-man's switch
  | 'export_drop' // tier7: outbox dropped a document
  | 'clock_suspect' // tier7: wall clock vs boot-anchored uptime
  | 'shadow_account_spend' // tier8: console-blind spend
  | 'reconcile_gap' // tier8
  | 'activity_after_departure' // tier8
  | 'budget_exceeded' // tier8
  | 'budget_indeterminate' // tier8: budget verdict cannot be computed
  | 'sandbox_claim_violated' // tier5: a call wrote outside its declared sandbox roots
  | 'network_claim_violated' // tier5: a fetch-shaped call under a no-network claim
  | 'evidence_expiring' // tier4: retained sighting near the vendor's deletion horizon
  | 'secret_reappeared_after_rotation'; // tier4: a rotated key's fingerprint sighted again

export type Severity = 'info' | 'warn' | 'critical';

export interface Anomaly {
  anomaly_key: string;
  rule: AnomalyRule;
  severity: Severity;
  tool: Tool;
  session_id: string | null;
  model: string | null;
  window_start: number;
  window_end: number;
  title: string;
  detail: string;
  observed: number;
  baseline: number | null;
  threshold: number | null;
  confidence: Confidence;
  source: Source;
  detected_at: number;
  /** Origin quarantine stamp (migration 21); anomalies normally inherit their session's context. */
  execution_context_id?: string | null;
}

/** Codex is the only source exposing its own rate-limit headroom. Fuels `rate_limit_pressure`. */
export interface RateLimitObservation {
  tool: Tool;
  session_id: string | null;
  ts: number;
  used_percent: number;
  window_minutes: number;
}

/** What a collector found when it looked — the difference between "no tool installed", "ran fine", and "ran and failed". */
export type SourceState = 'ok' | 'no_source' | 'error';

export interface CollectorResult {
  tool: Tool;
  events: UsageEvent[];
  filesScanned: number;
  /** Non-fatal problems worth surfacing, e.g. a source directory that does not exist. */
  notes: string[];
  /**
   * Structured outcome of the look itself, so a screen can say "not installed"
   * instead of guessing from note strings. `no_source` means the tool's artifacts
   * do not exist on this machine — absence of evidence, never "zero usage".
   */
  sourceState?: SourceState;
  /** Wall-clock cost of this collector's pass, filled in by collectAll. */
  durationMs?: number;
  rateLimits?: RateLimitObservation[];
  /** Tier 5: per-invocation ledger rows for this pass (two-phase bind). */
  toolCalls?: import('./toolcalls/bind').ToolCallRow[];
  /**
   * Persists read offsets. Called by the CLI only after `events` were stored, so a
   * failed insert never advances past lines that were consumed but not kept.
   */
  commit?: () => void;
}

// ── Foundation domain types ───────────────────────────────────────────────────
//
// The vocabularies the remaining features stamp into the nullable columns the
// foundation migrations added. Every value is read from a source or declared by
// an admin — never inferred silently — and every column stays NULL until one of
// those two things happens.

/** Why a cost_usd figure means what it means (tier 8: cost_basis) — see pricing.ts. */
export type { CostBasis } from './pricing';

/** Account class resolved from the auth path (tier 3) — never from model names. */
export type AccountClass =
  | 'org_oauth'
  | 'personal_oauth'
  | 'api_key'
  | 'cloud_provider'
  | 'team_seat'
  | 'unknown';

/**
 * How strongly a session is bound to its principal (tier 3). Ranked:
 * session_proved > store_origin > ambient > unbound.
 */
export type BindingEvidence =
  | 'session_proved' // the session's own records name the account
  | 'store_origin' // inferred from which store produced the row
  | 'ambient' // only the ambient environment implies it
  | 'unbound';

/** The gate a tool call actually had (tier 5: authorization_basis). */
export type AuthorizationBasis =
  | 'bypass_no_gate' // bypassPermissions interval / danger-full-access turn
  | 'mode_auto' // an auto-approval mode answered, no human in the loop
  | 'rule_matched' // an allow entry matched
  | 'human_denied' // a human refused it
  | 'unknown'; // no record — never 'gated'

/** Trust class of a content pack (tier 6: two trust classes, one builtin floor). */
export type TrustClass = 'vendor_signed' | 'admin_authored';

/** Suppression register mode (tier 6): evaluate-and-hide vs skip-and-unknown. */
export type SuppressionMode = 'mute_report' | 'mute_scan';

/** Kind of system an action targeted (tier 5: action_targets). */
export type TargetKind =
  | 'cloud_account'
  | 'k8s_context'
  | 'database'
  | 'vcs_repo'
  | 'package_registry'
  | 'saas'
  | 'remote_host';

/** Where a targeted system lives (tier 5). */
export type Locality = 'loopback' | 'remote' | 'unknown';

/** Declared environment of a targeted system (tier 5) — a declaration, never a guess. */
export type EnvClass = 'prod' | 'staging' | 'dev' | 'unknown';

/** Declared principal state (tier 8) — written from declarations only, never observation. */
export type PrincipalState = 'active' | 'departing' | 'departed' | 'scope_changed' | 'suspended';

/** Direction a secret or payload moved (tier 4/5). */
export type Direction = 'at_rest' | 'at_wire' | 'human_pasted' | 'agent_typed' | 'off_device';

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
  | 'ollama_local';

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
  | 'context_edges';

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

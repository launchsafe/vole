/** Tools we can observe from purely local, on-device logs. */
export type Tool =
  | 'claude_code'
  | 'codex'
  | 'cursor'
  | 'antigravity'
  | 'opencode'
  | 'grok'
  | 'devin';

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
}

export type AnomalyRule =
  | 'burn_rate_spike'
  | 'loop_suspected'
  | 'error_storm'
  | 'rate_limit_pressure'
  | 'context_pressure';

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

export interface CollectorResult {
  tool: Tool;
  events: UsageEvent[];
  filesScanned: number;
  /** Non-fatal problems worth surfacing, e.g. a source directory that does not exist. */
  notes: string[];
  rateLimits?: RateLimitObservation[];
  /**
   * Persists read offsets. Called by the CLI only after `events` were stored, so a
   * failed insert never advances past lines that were consumed but not kept.
   */
  commit?: () => void;
}

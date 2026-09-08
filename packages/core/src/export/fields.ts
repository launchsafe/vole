/**
 * The export field registry (Tier 7 core): the one table that says which
 * columns can leave this machine, under which wire name, and through which
 * transform. Deny-by-default: a column not listed here is never serialized,
 * and an entry marked `never` documents the refusal where it can be tested.
 *
 * Every payload builder — JSON export, OTLP attributes, syslog SD-PARAMs, CEF
 * extensions, Sentinel DCR — iterates this table; none of them builds from an
 * object literal or a SELECT * spread.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How a column value becomes a wire value. */
export type FieldTransform =
  | 'passthrough'
  /** sha256 digest — the value (a path, an identity) never leaves in the clear. */
  | 'digest'
  /** project path -> the repo's basename slug (e.g. 'vole'); the full path stays home. */
  | 'repo_slug'
  /** user/machine -> cleartext or digest per the identity policy mode. */
  | 'identity';

/**
 * The three-state export class (feature 36): tier travels by default, names
 * are opt-in per sink, basis never leaves at any setting. Unlisted = never
 * (deny-by-default), so `never` entries exist to document and test refusals.
 */
export type ExportClass = 'always' | 'optin' | 'never';

export interface FieldSpec {
  table: string;
  column: string;
  /** The name on the wire (JSON key, OTLP/syslog/CEF attribute name). */
  wire_name: string;
  transform: FieldTransform;
  justification: string;
  export: ExportClass;
}

const F = (
  table: string,
  column: string,
  wire_name: string,
  transform: FieldTransform,
  justification: string,
  exportClass: ExportClass = 'always',
): FieldSpec => ({ table, column, wire_name, transform, justification, export: exportClass });

/**
 * The registry. Adding a field requires adding it here, by name, with its
 * justification — the same review discipline as the content allowlist in
 * verify.ts. Anything not on this list is structurally unable to leave.
 */
export const REGISTRY: readonly FieldSpec[] = [
  // ── usage_events → vole.event.v1 ────────────────────────────────────────
  F('usage_events', 'event_key', 'event_key', 'passthrough', 'the device-scoped sync key half'),
  F('usage_events', 'ts', 'ts', 'passthrough', 'when the call happened (source clock)'),
  F('usage_events', 'observed_at', 'observed_at', 'passthrough', 'when Vole read the row (collector clock)'),
  F('usage_events', 'tool', 'tool', 'passthrough', 'which agent'),
  F('usage_events', 'model', 'model', 'passthrough', 'which model answered'),
  F('usage_events', 'session_id', 'session_id', 'passthrough', 'session grouping'),
  F('usage_events', 'agent_id', 'agent_id', 'passthrough', 'which subagent made the call'),
  F('usage_events', 'cli_version', 'cli_version', 'passthrough', 'agent version'),
  F('usage_events', 'project', 'project_repo', 'repo_slug', 'repo identity, never the full path'),
  F('usage_events', 'git_branch', 'git_branch', 'passthrough', 'branch (can carry ticket ids)', 'optin'),
  F('usage_events', 'input_tokens', 'input_tokens', 'passthrough', 'usage figure'),
  F('usage_events', 'output_tokens', 'output_tokens', 'passthrough', 'usage figure'),
  F('usage_events', 'cache_read_tokens', 'cache_read_tokens', 'passthrough', 'usage figure'),
  F('usage_events', 'cache_write_5m_tokens', 'cache_write_5m_tokens', 'passthrough', 'usage figure'),
  F('usage_events', 'cache_write_1h_tokens', 'cache_write_1h_tokens', 'passthrough', 'usage figure'),
  F('usage_events', 'reasoning_tokens', 'reasoning_tokens', 'passthrough', 'usage figure'),
  F('usage_events', 'total_tokens', 'total_tokens', 'passthrough', 'usage figure'),
  F('usage_events', 'cost_usd', 'cost_usd', 'passthrough', 'cost figure'),
  F('usage_events', 'cost_basis', 'cost_basis', 'passthrough', 'which definition of a dollar'),
  F('usage_events', 'pricing_rev', 'pricing_rev', 'passthrough', 'which rate table priced it'),
  F('usage_events', 'confidence', 'confidence', 'passthrough', 'data quality'),
  F('usage_events', 'is_error', 'is_error', 'passthrough', 'error state'),
  F('usage_events', 'duration_ms', 'duration_ms', 'passthrough', 'response span'),
  F('usage_events', 'duration_kind', 'duration_kind', 'passthrough', 'span provenance'),
  F('usage_events', 'user', 'user', 'identity', 'pseudonymous principal'),
  F('usage_events', 'machine', 'machine', 'identity', 'pseudonymous host'),
  F('usage_events', 'raw_ref', 'raw_ref', 'passthrough', 'pointer into a plaintext source file', 'never'),

  // ── anomalies → vole.incident.v1 ────────────────────────────────────────
  F('anomalies', 'anomaly_key', 'anomaly_key', 'passthrough', 'the device-scoped sync key half'),
  F('anomalies', 'case_key', 'case_key', 'passthrough', 'the stable case beneath the time bucket'),
  F('anomalies', 'rule', 'rule', 'passthrough', 'which rule fired'),
  F('anomalies', 'severity', 'severity', 'passthrough', 'incident severity'),
  F('anomalies', 'tool', 'tool', 'passthrough', 'which agent'),
  F('anomalies', 'session_id', 'session_id', 'passthrough', 'triage grouping'),
  F('anomalies', 'model', 'model', 'passthrough', 'which model'),
  F('anomalies', 'window_start', 'window_start', 'passthrough', 'when'),
  F('anomalies', 'window_end', 'window_end', 'passthrough', 'when'),
  F('anomalies', 'title', 'title', 'passthrough', 'incident title (rule-rendered, no content)'),
  F('anomalies', 'detail_key', 'detail_key', 'passthrough', 'the template key — render locally'),
  F('anomalies', 'detail', 'detail', 'passthrough', 'free text; detail_key travels instead', 'never'),
  F('anomalies', 'detail_params', 'detail_params', 'passthrough', 'may embed session ids in params', 'never'),
  F('anomalies', 'observed', 'observed', 'passthrough', 'the figure that fired'),
  F('anomalies', 'baseline', 'baseline', 'passthrough', 'what normal was'),
  F('anomalies', 'threshold', 'threshold', 'passthrough', 'what it had to beat'),
  F('anomalies', 'confidence', 'confidence', 'passthrough', 'data quality'),
  F('anomalies', 'detected_at', 'detected_at', 'passthrough', 'when Vole saw it'),
  F('anomalies', 'content_rev', 'content_rev', 'passthrough', 'which pack rev scored it'),
  // Asset labels, three ways (feature 36): tier and the register-rev link
  // travel so a SIEM can prioritise; asset_id is opt-in per sink; basis and
  // raw match strings are the asset register's own policy file and never
  // have a column here at all — the `never` entries below name that refusal.
  F('anomalies', 'asset_tier', 'asset_tier', 'passthrough', 'crown-jewel tier: travels so a SIEM can prioritise'),
  F('anomalies', 'asset_rev', 'asset_rev', 'passthrough', 'which register revision matched (the chain link)'),
  F('anomalies', 'asset_id', 'asset_id', 'passthrough', 'which asset: names are opt-in per sink', 'optin'),
  F('anomalies', 'state', 'state', 'passthrough', 'triage state'),
  F('anomalies', 'user', 'user', 'identity', 'pseudonymous principal'),
  F('anomalies', 'machine', 'machine', 'identity', 'pseudonymous host'),
  F('anomalies', 'raw_ref', 'raw_ref', 'passthrough', 'pointer into a plaintext source file', 'never'),
  // The register's own match strings (declared hosts, DSNs, path globs,
  // salted literals) are policy-file data, never columns — listed so the
  // three-state panel and the encoder test can name the refusal.
  F('asset_register', 'basis', 'basis', 'passthrough', 'the basis cannot leave: it is the crown-jewel list itself', 'never'),
  F('asset_register', 'match', 'match', 'passthrough', 'raw match strings name the jewels', 'never'),

  // ── tool_calls → vole.tool_call.v1 ───────────────────────────────────────
  F('tool_calls', 'tool_call_key', 'tool_call_key', 'passthrough', 'the device-scoped sync key half'),
  F('tool_calls', 'tool', 'tool', 'passthrough', 'which agent'),
  F('tool_calls', 'name', 'name', 'passthrough', 'tool name'),
  F('tool_calls', 'tool_name', 'tool_name', 'passthrough', 'resolved tool name'),
  F('tool_calls', 'server', 'server', 'passthrough', 'MCP server, when the call went through one'),
  F('tool_calls', 'shape', 'shape', 'passthrough', 'command shape (structure, never content)'),
  F('tool_calls', 'session_id', 'session_id', 'passthrough', 'session grouping'),
  F('tool_calls', 'agent_id', 'agent_id', 'passthrough', 'which subagent'),
  F('tool_calls', 'ts', 'ts', 'passthrough', 'when'),
  F('tool_calls', 'status', 'status', 'passthrough', 'outcome'),
  F('tool_calls', 'status_source', 'status_source', 'passthrough', 'outcome provenance'),
  F('tool_calls', 'duration_ms', 'duration_ms', 'passthrough', 'real execute_tool span'),
  F('tool_calls', 'duration_kind', 'duration_kind', 'passthrough', 'span provenance'),
  F('tool_calls', 'authority', 'authority', 'passthrough', 'authority state'),
  F('tool_calls', 'authority_evidence', 'authority_evidence', 'passthrough', 'evidence strings can carry paths', 'optin'),
  F('tool_calls', 'authorization_basis', 'authorization_basis', 'passthrough', 'why the call was allowed', 'optin'),
  F('tool_calls', 'pattern_id', 'pattern_id', 'passthrough', 'which path-class pattern matched'),
  F('tool_calls', 'pack_version', 'pack_version', 'passthrough', 'which pack classified it'),
  F('tool_calls', 'target_scope', 'target_scope', 'passthrough', 'declared target scope', 'optin'),
  F('tool_calls', 'origin_kind', 'origin_kind', 'passthrough', 'human- or agent-originated'),
  F('tool_calls', 'permission_mode', 'permission_mode', 'passthrough', 'bypass/ask/plan mode'),
  F('tool_calls', 'autonomy_rank', 'autonomy_rank', 'passthrough', 'how much authority the call used'),
  F('tool_calls', 'execution_context_id', 'execution_context_id', 'passthrough', 'join into execution contexts'),
  F('tool_calls', 'args_digest', 'args_digest', 'passthrough', 'a digest of small inputs can be brute-forced', 'never'),
  F('tool_calls', 'raw_ref', 'raw_ref', 'passthrough', 'pointer into a plaintext source file', 'never'),

  // ── secret_sightings → vole.secret_sighting.v1 ──────────────────────────
  F('secret_sightings', 'fingerprint', 'fingerprint', 'passthrough', 'the HMAC — the only form a secret takes'),
  F('secret_sightings', 'detector', 'detector_id', 'passthrough', 'which detector fired'),
  F('secret_sightings', 'class_entry_id', 'class', 'passthrough', 'detector-class entry id'),
  F('secret_sightings', 'provider', 'provider_key', 'passthrough', 'provider key name census'),
  F('secret_sightings', 'direction', 'direction', 'passthrough', 'at_rest / outbound / …'),
  F('secret_sightings', 'status', 'status', 'passthrough', 'candidate / confirmed / fixture'),
  F('secret_sightings', 'occurrences', 'occurrences', 'passthrough', 'count, never content'),
  F('secret_sightings', 'validator_checked', 'validator_checked', 'passthrough', 'whether a validator confirmed'),
  F('secret_sightings', 'fixture_reason', 'fixture_reason', 'passthrough', 'why this is a known fixture', 'optin'),
  F('secret_sightings', 'execution_context_id', 'execution_context_id', 'passthrough', 'join into execution contexts'),
  F('secret_sightings', 'first_seen', 'first_seen', 'passthrough', 'when first sighted'),
  F('secret_sightings', 'last_seen', 'last_seen', 'passthrough', 'when last sighted'),
  F('secret_sightings', 'path', 'path_hmac', 'digest', 'the file name, as a digest the SIEM cannot invert'),
  F('secret_sightings', 'sink_key', 'sink_key', 'passthrough', 'internal sighting identity', 'never'),
  F('secret_sightings', 'byte_offset', 'byte_offset', 'passthrough', 'a pointer into a plaintext file still on the endpoint — a map to the secret', 'never'),
  F('secret_sightings', 'byte_length', 'byte_length', 'passthrough', 'bounds the secret size; travels with the offset or not at all', 'never'),

  // ── ai_surfaces ──────────────────────────────────────────────────────────
  F('ai_surfaces', 'kind', 'kind', 'passthrough', 'surface type'),
  F('ai_surfaces', 'name', 'name', 'passthrough', 'surface name'),
  F('ai_surfaces', 'sanctioned', 'sanctioned', 'passthrough', 'policy verdict'),
  F('ai_surfaces', 'first_seen', 'first_seen', 'passthrough', 'when it appeared'),
  F('ai_surfaces', 'path', 'path', 'digest', 'local install path', 'never'),
  F('ai_surfaces', 'evidence', 'evidence', 'passthrough', 'local evidence strings', 'never'),
  F('ai_surfaces', 'extra', 'extra', 'passthrough', 'unstructured local data', 'never'),
];

export function fieldsFor(table: string): FieldSpec[] {
  return REGISTRY.filter((f) => f.table === table);
}

/** The columns a SELECT may project for one table: everything not refused. */
export function selectColumns(table: string): string[] {
  return fieldsFor(table).filter((f) => f.export !== 'never').map((f) => f.column);
}

export interface EncodeCtx {
  device_id: string;
  /** Identity policy mode: 'pseudonymous' (digest) or 'named' (cleartext). */
  identity_mode: 'pseudonymous' | 'named';
  /** Opt-in wire names the caller has enabled for this sink. */
  opt_in: ReadonlySet<string>;
}

export function digestOf(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

/** Coarse, public vocabulary: the top-level dir under $HOME (.claude, .codex, …). */
export function dirPrefixOf(path: string): string | null {
  const m = path.match(/\/(\.[\w.@-]+)\//); // the first dot-dir (.claude, .codex, …)
  return m?.[1] ?? null;
}

function repoSlug(project: string | null): string | null {
  if (!project) return null;
  const base = project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return base.replace(/\.git$/, '') || null;
}

function applyTransform(spec: FieldSpec, value: unknown, ctx: EncodeCtx): string | number | null {
  switch (spec.transform) {
    case 'passthrough':
      return (value as string | number | null) ?? null;
    case 'digest':
      return value == null ? null : digestOf(String(value));
    case 'repo_slug':
      return repoSlug(value as string | null);
    case 'identity':
      if (value == null) return null;
      return ctx.identity_mode === 'named' ? String(value) : digestOf(String(value));
  }
}

/**
 * The NULL-omitting encoder: iterates the registry for one table, applies the
 * transform, and omits NULL/undefined — absence is honest, never zero. Opt-in
 * fields appear only when the sink enabled them; `never` fields never appear.
 */
export function encodeFields(
  table: string,
  row: Record<string, unknown>,
  ctx: EncodeCtx,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const spec of fieldsFor(table)) {
    if (spec.export === 'never') continue;
    if (spec.export === 'optin' && !ctx.opt_in.has(spec.wire_name)) continue;
    const v = applyTransform(spec, row[spec.column], ctx);
    if (v !== null && v !== undefined) out[spec.wire_name] = v;
  }
  return out;
}

// ── gen_ai.provider.name normalisation (feature 26) ──────────────────────

/** The semconv closed enum, verbatim from the vendored snapshot. */
export type ProviderName =
  | 'openai' | 'gcp.gen_ai' | 'gcp.vertex_ai' | 'gcp.gemini' | 'anthropic' | 'cohere'
  | 'azure.ai.inference' | 'azure.ai.openai' | 'ibm.watsonx.ai' | 'aws.bedrock'
  | 'perplexity' | 'x_ai' | 'deepseek' | 'groq' | 'mistral_ai' | 'moonshot_ai';

/**
 * Model id -> provider enum member, with an explicit 'unknown' bucket. The
 * provider is the one declared locally, not the one that served the request:
 * a gateway or ANTHROPIC_BASE_URL override can route an anthropic-shaped id
 * anywhere, and the transcript records no evidence of the hop — which is why
 * gateways (github-copilot/, litellm) land in 'unknown' rather than guessing.
 */
export function providerForModel(model: string | null): ProviderName | 'unknown' {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.startsWith('github-copilot/') || m.includes('litellm')) return 'unknown'; // a gateway, not a provider
  if (m.startsWith('claude') || m.startsWith('anthropic/')) return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')
    || m.startsWith('openai/') || m.startsWith('chatgpt') || m.startsWith('codex-') && m.includes('gpt')) return 'openai';
  if (m.startsWith('grok') || m.startsWith('x-ai') || m.startsWith('xai')) return 'x_ai';
  if (m.startsWith('gemini')) return 'gcp.gemini';
  if (m.startsWith('vertex') || m.startsWith('gcp/')) return 'gcp.vertex_ai';
  if (m.startsWith('bedrock') || m.includes('.bedrock.')) return 'aws.bedrock';
  if (m.startsWith('azure/')) return 'azure.ai.inference';
  if (m.startsWith('mistral') || m.startsWith('codestral')) return 'mistral_ai';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.startsWith('groq')) return 'groq';
  if (m.startsWith('moonshot') || m.startsWith('kimi')) return 'moonshot_ai';
  if (m.startsWith('command-') || m.startsWith('cohere')) return 'cohere';
  if (m.startsWith('ibm') || m.startsWith('granite')) return 'ibm.watsonx.ai';
  if (m.startsWith('perplexity') || m.startsWith('sonar')) return 'perplexity';
  if (m.startsWith('ollama')) return 'unknown'; // a local runtime, not a cloud provider
  return 'unknown';
}

// ── vendored semconv snapshots ───────────────────────────────────────────

export interface SemconvSnapshot {
  name: string;
  version: string;
  upstream: string;
  upstream_commit: string;
  snapshot_date: string;
  stability: string;
  schema_url: string;
  attributes: Record<string, { type: string; members?: string[] }>;
  legacy_attributes?: Record<string, { type: string; deprecated: boolean; note: string }>;
}

const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'semconv');

/** `--semconv=<version>` selects among vendored snapshots. */
export const SEMCONV_VERSIONS = ['2026-09-01'] as const;

export function loadSemconv(version: string = '2026-09-01'): SemconvSnapshot {
  if (!(SEMCONV_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(`Unknown semconv snapshot ${version}; vendored: ${SEMCONV_VERSIONS.join(', ')}`);
  }
  return JSON.parse(readFileSync(join(SNAPSHOTS_DIR, `genai-${version}.json`), 'utf8')) as SemconvSnapshot;
}

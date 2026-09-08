import { existsSync } from 'node:fs';
import type { DB } from '../db';
import { decodeHexAlias } from '../detect/rerouted-model';
import { Database } from '../sqlite';

/**
 * Recipient resolution (tier 6 #30): the model name is a ROUTE, not a
 * recipient. `github-copilot/claude-opus-4.6` names an Anthropic model whose
 * recipient is GitHub/Microsoft with Anthropic as a downstream sub-processor;
 * a hex alias names a qwen model served from a raw IP. Where no route record
 * exists the state stays `unattributable` — Vole will not name a vendor from a
 * model string, and a broker's downstream provider is chosen per request
 * server-side, so `broker_truncated` is a permanent ceiling, not backlog.
 */

export type RecipientState = 'first_party' | 'broker_truncated' | 'rerouted' | 'unattributable';

export interface RecipientChainHop {
  hop: number;
  label: string;
  state: RecipientState | 'truncated';
  evidence_ref: string;
}

export interface ResolvedRecipient {
  state: RecipientState;
  /** Vendor identity or the api_base host; NULL when unattributable. */
  recipient_id: string | null;
  evidence_ref: string;
  chain: RecipientChainHop[];
}

export interface RouteRow {
  alias: string;
  target_model: string | null;
  api_base: string | null;
}

/** Broker prefixes: the string names a broker, the recipient is the broker. */
const BROKERS: Array<[RegExp, string]> = [
  [/^github-copilot\//i, 'github'],
  [/^openrouter\//i, 'openrouter'],
];

/** First-party shapes — the vendor the model id itself belongs to. */
const FIRST_PARTY: Array<[RegExp, string]> = [
  [/^(anthropic\/|claude-)/i, 'anthropic'],
  [/^(openai\/|gpt-)/i, 'openai'],
  [/^(google\/|gemini-)/i, 'google'],
  [/^(xai\/|grok-)/i, 'xai'],
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Resolves where output actually landed. Order matters: a hex alias proves a
 * router rewrote the id before anything else is believed; then broker
 * prefixes; then first-party shapes; everything else is unattributable.
 */
export function resolveRecipient(model: string | null, routes: RouteRow[] = []): ResolvedRecipient {
  if (model === null || model === '') {
    return { state: 'unattributable', recipient_id: null, evidence_ref: 'no model recorded', chain: [] };
  }
  const alias = decodeHexAlias(model);
  if (alias !== null) {
    const route =
      routes.find((r) => r.alias === model) ?? routes.find((r) => r.target_model === alias) ?? null;
    const host = route?.api_base ? hostOf(route.api_base) : null;
    return {
      state: 'rerouted',
      recipient_id: host,
      evidence_ref: route?.api_base
        ? `model_routes alias → api_base ${route.api_base}`
        : 'hex alias decodes, api_base unknown',
      chain: [
        {
          hop: 1,
          label: route?.api_base ?? 'router (api_base unknown)',
          state: 'rerouted',
          evidence_ref: `hex alias decodes to "${alias}"`,
        },
        {
          hop: 2,
          label: alias,
          state: 'truncated',
          evidence_ref: "the router's own model id; the serving host is not on disk",
        },
      ],
    };
  }
  for (const [re, broker] of BROKERS) {
    if (re.test(model)) {
      return {
        state: 'broker_truncated',
        recipient_id: broker,
        evidence_ref: `model prefix "${model.split('/')[0]}/"`,
        chain: [
          { hop: 1, label: broker, state: 'broker_truncated', evidence_ref: `model string "${model}"` },
          {
            hop: 2,
            label: 'downstream provider',
            state: 'truncated',
            evidence_ref: 'chain truncated at hop 1 — downstream provider chosen per request by the broker',
          },
        ],
      };
    }
  }
  for (const [re, vendor] of FIRST_PARTY) {
    if (re.test(model)) {
      return {
        state: 'first_party',
        recipient_id: vendor,
        evidence_ref: `model id matches the ${vendor} first-party shape`,
        chain: [{ hop: 1, label: vendor, state: 'first_party', evidence_ref: `model string "${model}"` }],
      };
    }
  }
  return { state: 'unattributable', recipient_id: null, evidence_ref: 'no route record exists', chain: [] };
}

/**
 * Reads the claude-code-router config: base URLs only, never key values.
 * A missing file, missing table or unreadable row yields [] — absence of
 * evidence, never an invented route.
 */
export function readCcrRoutes(configSqlitePath: string): Array<{ provider: string | null; api_base: string }> {
  if (!existsSync(configSqlitePath)) return [];
  try {
    const db = new Database(configSqlitePath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT value_json FROM app_config').all() as Array<{ value_json: unknown }>;
      const out: Array<{ provider: string | null; api_base: string }> = [];
      for (const r of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(r.value_json));
        } catch {
          continue;
        }
        collectBaseUrls(parsed, null, out);
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function collectBaseUrls(
  node: unknown,
  provider: string | null,
  out: Array<{ provider: string | null; api_base: string }>,
): void {
  if (Array.isArray(node)) {
    for (const v of node) collectBaseUrls(v, provider, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name : typeof o.provider === 'string' ? o.provider : provider;
  for (const key of ['base_url', 'api_base', 'apiBase', 'BASE_URL']) {
    const v = o[key];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) out.push({ provider: name ?? null, api_base: v });
  }
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') continue;
    collectBaseUrls(v, k, out);
  }
}

// ── recipient_state upsert ──────────────────────────────────────────────────

export interface RecipientStateRow {
  surface_key: string;
  state: RecipientState;
  evidence_ref: string;
  now?: number;
}

const INSERT_RECIPIENT = `
INSERT INTO recipient_state (surface_key, state, evidence_ref, first_seen, last_seen)
VALUES (@surface_key, @state, @evidence_ref, @now, @now)
ON CONFLICT(surface_key, state) DO UPDATE SET
  evidence_ref = COALESCE(recipient_state.evidence_ref, excluded.evidence_ref),
  last_seen    = MAX(recipient_state.last_seen, excluded.last_seen)`;

/** Idempotent NULL-only widening upsert into recipient_state. */
export function recordRecipientState(db: DB, rows: RecipientStateRow[]): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(INSERT_RECIPIENT);
  const run = db.transaction((rs: RecipientStateRow[]) => {
    let changed = 0;
    const now = rs[0]?.now ?? Date.now();
    for (const r of rs) {
      changed += stmt.run({ ...r, now: r.now ?? now }).changes;
    }
    return changed;
  });
  return run(rows);
}

// ── residency_evidence: the ranked inference-geo chain (tier 6 #46) ──────────

export interface ResidencyEvidence {
  /** 1 vendor_stated, 2 route_declared, 3 pack_default, 4 unknown. */
  rank: number;
  /** The fact itself, named — never just a flag. */
  evidence: string;
  /** Where the fact came from, named per rank. */
  source: string;
}

const BEDROCK_PREFIX = /^(us|eu|apac|us-gov)\./;

/**
 * The ranked chain. The honest headline (verified on the reference machine):
 * usage.inference_geo is present but says "not_available" or "" on almost every
 * line, so the top rank is usually unreachable — the chain ships visibly empty
 * at rank 1 rather than falling back to a guess. Rank 4 exists only when no
 * higher rank does; its `source` names the absence that put it there.
 */
export function rankResidencyChain(input: {
  inference_geo?: string | null;
  model?: string | null;
  settings_region?: string | null;
  pack_regions?: string[] | null;
}): ResidencyEvidence[] {
  const out: ResidencyEvidence[] = [];
  const geo = input.inference_geo ?? null;
  if (geo !== null && geo !== '' && geo !== 'not_available') {
    out.push({ rank: 1, evidence: `inference_geo=${geo}`, source: 'claude_transcript:usage.inference_geo' });
  }
  const prefix = input.model?.match(BEDROCK_PREFIX)?.[0];
  if (prefix) {
    out.push({
      rank: 2,
      evidence: `model prefix "${prefix}" (Bedrock cross-region inference profile)`,
      source: 'usage_events.model',
    });
  } else if (input.settings_region) {
    out.push({ rank: 2, evidence: `settings region ${input.settings_region}`, source: 'settings_env_snapshot' });
  }
  if (input.pack_regions?.length) {
    out.push({
      rank: 3,
      evidence: `pack default ${input.pack_regions.join(',')}`,
      source: 'processing_terms',
    });
  }
  if (!out.length) {
    out.push({
      rank: 4,
      evidence: 'unknown',
      source: geo !== null ? `claude_transcript:usage.inference_geo=${geo}` : 'no residency evidence',
    });
  }
  return out;
}

export interface ResidencyEvidenceWrite {
  surface_key: string;
  chain: ResidencyEvidence[];
  now?: number;
}

const INSERT_RESIDENCY = `
INSERT INTO residency_evidence (surface_key, rank, evidence, source, first_seen, last_seen)
VALUES (@surface_key, @rank, @evidence, @source, @now, @now)
ON CONFLICT(surface_key, evidence) DO UPDATE SET
  rank      = CASE WHEN residency_evidence.rank IS NULL THEN excluded.rank ELSE residency_evidence.rank END,
  source    = COALESCE(residency_evidence.source, excluded.source),
  last_seen = MAX(residency_evidence.last_seen, excluded.last_seen)`;

/** Idempotent upsert into residency_evidence (rank is set once, never re-derived). */
export function recordResidencyEvidence(db: DB, rows: ResidencyEvidenceWrite[]): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(INSERT_RESIDENCY);
  const run = db.transaction((rs: ResidencyEvidenceWrite[]) => {
    let changed = 0;
    const now = rs[0]?.now ?? Date.now();
    for (const r of rs) {
      for (const e of r.chain) {
        changed += stmt.run({ surface_key: r.surface_key, ...e, now: r.now ?? now }).changes;
      }
    }
    return changed;
  });
  return run(rows);
}

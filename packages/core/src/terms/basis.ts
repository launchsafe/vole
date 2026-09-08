import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import type { TermsPackEntry } from './as-of';

/**
 * terms_basis — the contract tier that selects the terms, measured per surface
 * (tier 6 #36). A plan token is what the CLIENT last cached, quoted verbatim:
 * the basis column holds the token exactly as the source wrote it, never a
 * derived tier, and `source` names the file+field so the drill-down can cite it.
 * NULL means the source carried no token — an honest unknown, never 'free'.
 */

export interface TermsBasisRow {
  surface_key: string;
  /** The plan token verbatim, as the client cached it. */
  basis: string;
  /** File + field the token came from, e.g. `~/.claude.json oauthAccount.organizationType`. */
  source: string;
  now?: number;
}

const INSERT_BASIS = `
INSERT INTO terms_basis (surface_key, basis, source, first_seen, last_seen)
VALUES (@surface_key, @basis, @source, @now, @now)
ON CONFLICT(surface_key, basis) DO UPDATE SET
  source    = COALESCE(terms_basis.source, excluded.source),
  last_seen = MAX(terms_basis.last_seen, excluded.last_seen)`;

/**
 * Idempotent upsert on the UNIQUE(surface_key, basis) key. A stored source is
 * never overwritten (the bind.ts pattern): only a NULL source may be filled.
 */
export function recordTermsBasis(db: DB, rows: TermsBasisRow[]): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(INSERT_BASIS);
  const run = db.transaction((rs: TermsBasisRow[]) => {
    let changed = 0;
    const now = rows[0]?.now ?? Date.now();
    for (const r of rs) {
      changed += stmt.run({ surface_key: r.surface_key, basis: r.basis, source: r.source, now: r.now ?? now })
        .changes;
    }
    return changed;
  });
  return run(rows);
}

// ── Plan-token readers (pure: text in, token out, NULL when absent) ─────────

/** ~/.claude.json → oauthAccount.organizationType (tier 6 #36/#44). */
export function planTokenFromClaudeJson(text: string): string | null {
  try {
    const oauth = (JSON.parse(text) as { oauthAccount?: { organizationType?: unknown } }).oauthAccount;
    const t = oauth?.organizationType;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

/** A ~/.codex/sessions rollout line → rate_limits.plan_type (nested under token_count on some builds). */
export function planTokenFromCodexLine(line: string): string | null {
  try {
    const o = JSON.parse(line) as {
      rate_limits?: { plan_type?: unknown };
      token_count?: { rate_limits?: { plan_type?: unknown } };
    };
    const t = o.rate_limits?.plan_type ?? o.token_count?.rate_limits?.plan_type;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

/** A ~/.grok/logs/unified.jsonl line → paywall_check_result.ctx.subscription_tier. */
export function planTokenFromGrokLine(line: string): string | null {
  try {
    const o = JSON.parse(line) as { paywall_check_result?: { ctx?: { subscription_tier?: unknown } } };
    const t = o.paywall_check_result?.ctx?.subscription_tier;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

/** ~/.local/share/opencode/account.json → the first account's serviceID. */
export function planTokenFromOpencodeAccount(text: string): string | null {
  try {
    const accounts = (JSON.parse(text) as { accounts?: Array<{ serviceID?: unknown }> }).accounts;
    const t = accounts?.find((a) => typeof a.serviceID === 'string' && a.serviceID)?.serviceID;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

// ── declared_dpa_scope_mismatch (tier 6 #44) ─────────────────────────────────

/** An admin-authored DPA override: a declaration, never a measurement. */
export interface DpaOverride {
  vendor: string;
  /** The contract scope the admin declared the DPA covers. */
  contract_scope: string;
  /** HMAC of the org identifier, where the vendor exposes one (never the id itself). */
  org_id_hmac?: string | null;
  asserted_by: string;
  asserted_at: number;
}

export interface DpaOverrideFile {
  version?: number;
  overrides: DpaOverride[];
}

/** Managed root first, per-user second — the same precedence every policy uses. */
export function termsOverridePaths(home: string): string[] {
  return [
    join('/Library', 'Application Support', 'Vole', 'terms_overrides.json'),
    join(home, '.vole', 'policy', 'terms_overrides.json'),
  ];
}

export function loadTermsOverrides(
  pathsToCheck: string[],
): { path: string; overrides: DpaOverride[] } | null {
  for (const p of [...pathsToCheck].reverse()) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as DpaOverrideFile;
      if (Array.isArray(parsed.overrides)) return { path: p, overrides: parsed.overrides };
    } catch {
      // A malformed override is ignored, never fatal — same rule as pricing.
    }
  }
  return null;
}

/** One measured surface scope: what the plan token actually resolves to. */
export interface MeasuredScope {
  surface_key: string;
  vendor: string;
  plan_token: string | null;
}

export interface DpaMismatch {
  surface_key: string;
  vendor: string;
  declared_scope: string;
  /** NULL = the pack could not resolve this surface's scope — unknown, not 'outside'. */
  measured_scope: string | null;
  plan_token: string | null;
  byline: string;
}

/**
 * Compares the admin's declaration against the measured plan tokens via the
 * pack's contract_scope for the plan condition — Vole never reads the contract,
 * so it can only report the two adjacent figures (the spec's limit).
 */
export function dpaScopeMismatches(
  overrides: DpaOverride[],
  measured: MeasuredScope[],
  packEntries: TermsPackEntry[],
): DpaMismatch[] {
  const out: DpaMismatch[] = [];
  for (const o of overrides) {
    const byline = `admin-authored by ${o.asserted_by} on ${new Date(o.asserted_at).toISOString().slice(0, 10)}`;
    for (const m of measured) {
      if (m.vendor !== o.vendor) continue;
      const entry = packEntries.find(
        (e) =>
          e.recipient_id === m.vendor &&
          (e.plan_condition === m.plan_token || (e.plan_condition === null && m.plan_token === null)),
      );
      const measured_scope = entry?.contract_scope ?? null;
      if (measured_scope !== null && measured_scope !== o.contract_scope) {
        out.push({
          surface_key: m.surface_key,
          vendor: m.vendor,
          declared_scope: o.contract_scope,
          measured_scope,
          plan_token: m.plan_token,
          byline,
        });
      }
    }
  }
  return out;
}

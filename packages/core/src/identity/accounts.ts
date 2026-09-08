/**
 * Tier 3 — the account-class classifier (features 19/25/1), the
 * session_identity binding ladder (17), account_switched (36),
 * shadow_account_on_corporate_repo (35) and seat-value reconciliation (3).
 *
 * The classifier maps OBSERVED auth-path fields to exactly one class from the
 * spec vocabulary — org_oauth | personal_oauth | api_key | cloud_provider |
 * team_seat | unknown — and writes the literal deciding field and value into
 * class_evidence so an incident can quote it. A model name alone never decides
 * an account class; model-id SHAPE only ever decides the cloud_provider arm,
 * which is a routing fact, not an account fact.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../db';
import type { AccountClass, Anomaly, Tool } from '../types';

// ── the classifier ───────────────────────────────────────────────────────────

/** Everything the classifier is allowed to look at. Opaque ids only — never a token, never an email. */
export interface AuthPathInput {
  tool?: Tool;
  model?: string | null;
  /** ~/.claude/settings.json env block + apiKeyHelper, names and routing values only. */
  env?: Record<string, string | undefined>;
  apiKeyHelper?: string | null;
  /** ~/.claude.json oauthAccount — the plan/org fields, never emailAddress/fullName. */
  oauthAccount?: {
    organizationType?: string | null;
    organizationRole?: string | null;
    workspaceRole?: string | null;
    billingType?: string | null;
    seatTier?: string | number | null;
    organizationRateLimitTier?: string | null;
    organizationUuid?: string | null;
  } | null;
  /** ~/.codex/auth.json shape: auth_mode and key presence, never the tokens. */
  codexAuthMode?: string | null;
  codexApiKeyPresent?: boolean | null;
  codexPlan?: string | null; // rollout rate_limits.plan_type — per-session, not auth.json
  /** ~/.grok/auth.json shape. */
  grokAuthMode?: string | null;
  grokTeamIdPresent?: boolean | null;
  grokPrincipalIdPresent?: boolean | null;
  /** A local router is present (claude-code-router config detected). */
  routerConfigPresent?: boolean;
}

export interface AccountClassification {
  account_class: AccountClass;
  /** The literal deciding field and value, quoted verbatim. */
  class_evidence: string;
  /**
   * True when no vendor console can ever show this traffic: Bedrock/Vertex,
   * a base-URL override, or a local router. A LOWER BOUND — an exported env
   * var leaves no trace on disk, so this is configuration evidence only.
   */
  console_invisible: boolean;
  /** Which cloud provider routed the session, when the shape says so. */
  cloud_provider: 'bedrock' | 'vertex' | 'foundry' | null;
}

const BEDROCK_SHAPE = /^(us\.)?anthropic\.claude-/;
const VERTEX_SHAPE = /^publishers\/anthropic\/models\//;
const FOUNDRY_SHAPE = /\/deployments\//;

function cloudProviderFromModel(model: string | null): 'bedrock' | 'vertex' | 'foundry' | null {
  if (!model) return null;
  if (BEDROCK_SHAPE.test(model)) return 'bedrock';
  if (VERTEX_SHAPE.test(model)) return 'vertex';
  if (FOUNDRY_SHAPE.test(model)) return 'foundry';
  return null;
}

const truthy = (v: string | undefined): boolean => !!v && v !== '0' && v.toLowerCase() !== 'false';

/** The pure classifier. Verified against the observed fields on the reference machine. */
export function classifyAccount(input: AuthPathInput): AccountClassification {
  const env = input.env ?? {};
  // 1. Cloud provider: explicit env flags first, then model-id shape.
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) {
    return { account_class: 'cloud_provider', class_evidence: `env.CLAUDE_CODE_USE_BEDROCK=${env.CLAUDE_CODE_USE_BEDROCK}`, console_invisible: true, cloud_provider: 'bedrock' };
  }
  if (truthy(env.CLAUDE_CODE_USE_VERTEX)) {
    return { account_class: 'cloud_provider', class_evidence: `env.CLAUDE_CODE_USE_VERTEX=${env.CLAUDE_CODE_USE_VERTEX}`, console_invisible: true, cloud_provider: 'vertex' };
  }
  const provider = cloudProviderFromModel(input.model ?? null);
  if (provider) {
    return { account_class: 'cloud_provider', class_evidence: `model=${input.model}`, console_invisible: true, cloud_provider: provider };
  }
  // 2. Base-URL override / router: traffic leaves the vendor billing relationship.
  const override =
    (env.ANTHROPIC_BASE_URL ? `env.ANTHROPIC_BASE_URL` : null) ??
    (env.ANTHROPIC_AUTH_TOKEN ? 'env.ANTHROPIC_AUTH_TOKEN' : null) ??
    (input.apiKeyHelper ? 'settings.apiKeyHelper' : null) ??
    (input.routerConfigPresent ? 'claude-code-router config' : null);
  if (override) {
    const klass: AccountClass = env.ANTHROPIC_API_KEY ? 'api_key' : 'unknown';
    return { account_class: klass, class_evidence: `${override} (configuration evidence — a lower bound)`, console_invisible: true, cloud_provider: null };
  }
  if (env.ANTHROPIC_API_KEY) {
    return { account_class: 'api_key', class_evidence: 'env.ANTHROPIC_API_KEY present', console_invisible: false, cloud_provider: null };
  }
  // 3. Claude oauthAccount plan fields.
  const oa = input.oauthAccount ?? null;
  if (oa) {
    if (oa.seatTier !== null && oa.seatTier !== undefined && oa.seatTier !== '') {
      return { account_class: 'team_seat', class_evidence: `oauthAccount.seatTier=${String(oa.seatTier)}`, console_invisible: false, cloud_provider: null };
    }
    if (oa.organizationType === 'claude_max' || oa.organizationType === 'claude_pro') {
      // A personal Max/Pro subscription, not a company seat — the verified case.
      return { account_class: 'personal_oauth', class_evidence: `oauthAccount.organizationType=${oa.organizationType} (seatTier null)`, console_invisible: false, cloud_provider: null };
    }
    if (oa.organizationUuid && (oa.organizationType === 'enterprise' || oa.organizationType === 'team' || oa.organizationRole || oa.workspaceRole)) {
      return { account_class: 'org_oauth', class_evidence: `oauthAccount.organizationUuid present (organizationType=${oa.organizationType ?? 'null'}, role=${oa.organizationRole ?? oa.workspaceRole ?? 'null'})`, console_invisible: false, cloud_provider: null };
    }
  }
  // 4. Codex: rollout plan_type outranks the ambient auth shape.
  if (input.codexPlan === 'team' || input.codexPlan === 'enterprise' || input.codexPlan === 'business' || input.codexPlan === 'edu') {
    return { account_class: 'team_seat', class_evidence: `rate_limits.plan_type=${input.codexPlan}`, console_invisible: false, cloud_provider: null };
  }
  if (input.codexPlan === 'free' || input.codexPlan === 'plus' || input.codexPlan === 'pro') {
    return { account_class: 'personal_oauth', class_evidence: `rate_limits.plan_type=${input.codexPlan}`, console_invisible: false, cloud_provider: null };
  }
  if (input.codexApiKeyPresent) {
    return { account_class: 'api_key', class_evidence: 'auth.json OPENAI_API_KEY present', console_invisible: false, cloud_provider: null };
  }
  if (input.codexAuthMode === 'chatgpt') {
    return { account_class: 'personal_oauth', class_evidence: 'auth.json auth_mode=chatgpt, OPENAI_API_KEY=null', console_invisible: false, cloud_provider: null };
  }
  // 5. Grok.
  if (input.grokTeamIdPresent) {
    return { account_class: 'team_seat', class_evidence: 'auth.json team_id present (auth_mode=oidc)', console_invisible: false, cloud_provider: null };
  }
  if (input.grokPrincipalIdPresent || input.grokAuthMode === 'oidc') {
    return { account_class: 'personal_oauth', class_evidence: `auth.json auth_mode=${input.grokAuthMode ?? 'null'}, principal_id present`, console_invisible: false, cloud_provider: null };
  }
  return { account_class: 'unknown', class_evidence: 'no identity-bearing field observed', console_invisible: false, cloud_provider: null };
}

// ── the auth-path shape readers (no credential VALUE ever survives these) ─────

export interface ClaudeOauthShape {
  oauthAccount: AuthPathInput['oauthAccount'];
  /** The email DOMAIN only, plus its HMAC — the address itself is never returned or stored. */
  emailDomain: string | null;
  emailHmac: string | null;
  githubRepoPaths: Record<string, { owner?: string; repo?: string }>;
  firstStartTime: number | null;
  claudeCodeFirstTokenDate: number | null;
}

/** Reads ~/.claude.json oauthAccount plan fields. emailAddress is consumed in-memory to produce domain+HMAC, then discarded. */
export function readClaudeJson(home = homedir()): ClaudeOauthShape | null {
  const file = join(home, '.claude.json');
  if (!existsSync(file)) return null;
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const oa = (cfg.oauthAccount ?? null) as Record<string, unknown> | null;
    let emailDomain: string | null = null;
    let emailHmac: string | null = null;
    if (typeof oa?.emailAddress === 'string' && oa.emailAddress.includes('@')) {
      emailDomain = oa.emailAddress.split('@')[1]!.toLowerCase();
      emailHmac = hmacIdentity(oa.emailAddress.toLowerCase());
    }
    const repoPaths: ClaudeOauthShape['githubRepoPaths'] = {};
    const grp = cfg.githubRepoPaths as Record<string, Record<string, unknown>> | undefined;
    if (grp && typeof grp === 'object') {
      for (const [path, v] of Object.entries(grp)) {
        if (v && typeof v === 'object') repoPaths[path] = { owner: typeof v.owner === 'string' ? v.owner : undefined, repo: typeof v.repo === 'string' ? v.repo : undefined };
      }
    }
    return {
      oauthAccount: oa
        ? {
            organizationType: str(oa.organizationType),
            organizationRole: str(oa.organizationRole),
            workspaceRole: str(oa.workspaceRole),
            billingType: str(oa.billingType),
            seatTier: (oa.seatTier ?? null) as string | number | null,
            organizationRateLimitTier: str(oa.organizationRateLimitTier),
            organizationUuid: str(oa.organizationUuid),
          }
        : null,
      emailDomain,
      emailHmac,
      githubRepoPaths: repoPaths,
      firstStartTime: num(cfg.firstStartTime),
      claudeCodeFirstTokenDate: num(cfg.claudeCodeFirstTokenDate),
    };
  } catch {
    return null;
  }
}

export function readClaudeSettingsEnv(home = homedir()): { env: Record<string, string>; apiKeyHelper: string | null; source: string | null } {
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const file = join(home, rel);
    if (!existsSync(file)) continue;
    try {
      const cfg = JSON.parse(readFileSync(file, 'utf8')) as { env?: Record<string, string>; apiKeyHelper?: string };
      const env: Record<string, string> = {};
      for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'OPENAI_API_KEY']) {
        if (cfg.env?.[k] !== undefined) env[k] = String(cfg.env[k]);
      }
      if (Object.keys(env).length || cfg.apiKeyHelper) return { env, apiKeyHelper: cfg.apiKeyHelper ?? null, source: file };
    } catch {
      /* malformed */
    }
  }
  return { env: {}, apiKeyHelper: null, source: null };
}

/** Codex auth.json: shape only — auth_mode, key/account presence, last_refresh. Never the tokens. */
export function readCodexAuthShape(home = homedir()): { auth_mode: string | null; apiKeyPresent: boolean | null; accountIdPresent: boolean | null; lastRefresh: number | null } | null {
  const file = join(home, '.codex', 'auth.json');
  if (!existsSync(file)) return null;
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const tokens = cfg.tokens as Record<string, unknown> | undefined;
    return {
      auth_mode: str(cfg.auth_mode),
      apiKeyPresent: cfg.OPENAI_API_KEY !== undefined && cfg.OPENAI_API_KEY !== null,
      accountIdPresent: tokens?.account_id !== undefined,
      lastRefresh: num(cfg.last_refresh),
    };
  } catch {
    return null;
  }
}

/** Grok auth.json: the issuer host from the object key, mode and id presence. Never .key/.email/.first_name. */
export function readGrokAuthShape(home = homedir()): { auth_mode: string | null; teamIdPresent: boolean | null; principalIdPresent: boolean | null; issuerHost: string | null } | null {
  const file = join(home, '.grok', 'auth.json');
  if (!existsSync(file)) return null;
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    const issuerKey = Object.keys(cfg).find((k) => k.startsWith('https://'));
    const inner = issuerKey ? cfg[issuerKey] : undefined;
    const flat = (inner ?? {}) as Record<string, unknown>;
    return {
      auth_mode: str(flat.auth_mode) ?? str(cfg.auth_mode),
      teamIdPresent: flat.team_id !== undefined,
      principalIdPresent: flat.principal_id !== undefined,
      issuerHost: issuerKey ? new URL(issuerKey).host : null,
    };
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

// ponytail: identityKey is duplicated from identity.ts to avoid a circular
// import (identity.ts → ./identity/chain.ts → identity.ts). If a third module
// needs it, lift it into its own key.ts.
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
let keyCache: string | null = null;
function hmacKey(): string {
  if (keyCache) return keyCache;
  let k: string | null = null;
  try {
    k = execFileSync('security', ['find-generic-password', '-s', 'vole-dlp-fingerprint', '-a', 'epoch-0', '-w'], { encoding: 'utf8', timeout: 4000 }).trim();
  } catch {
    k = null;
  }
  let uuid = '';
  try {
    uuid = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 4000 }).match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? '';
  } catch {
    /* linux/CI */
  }
  keyCache = k || uuid.slice(0, 32) || 'vole-identity-fallback';
  return keyCache;
}
/** HMAC-SHA256 of a lowercased identity value under the per-install key. The digest is all that is ever stored. */
export function hmacIdentity(value: string): string {
  return createHmac('sha256', hmacKey()).update(value).digest('hex');
}

// ── session_identity upsert: the binding ladder (feature 17) ────────────────

export type SessionIdentityRow = {
  session_id: string;
  principal_key?: string | null;
  device_key?: string | null;
  tool?: Tool | null;
  account_id?: string | null;
  org_id?: string | null;
  account_class?: AccountClass | null;
  class_evidence?: string | null;
  plan?: string | null;
  seat_role?: string | null;
  surface?: string | null;
  binding_evidence?: 'session_proved' | 'ambient' | 'unbound';
  first_seen?: number;
  last_seen?: number;
  source?: 'live' | 'seed';
};

const BIND_RANK: Record<string, number> = { session_proved: 3, store_origin: 2, ambient: 1, unbound: 0, none: 0 };

/**
 * Upsert through the session's own PRIMARY KEY. Widening is NULL-only for every
 * identity column (a stored fact is never replaced by a re-derived one) and
 * rank-monotone for binding_evidence: session_proved > store_origin > ambient
 * > unbound. A session with no identity-bearing line keeps account_class NULL
 * and binding 'unbound' — never a guess.
 */
export function upsertSessionIdentity(db: DB, rows: SessionIdentityRow[]): number {
  if (rows.length === 0) return 0;
  const upsert = db.prepare(`
    INSERT INTO session_identity
      (session_id, principal_key, device_key, binding_evidence, first_seen, last_seen,
       tool, account_id, org_id, account_class, class_evidence, plan, seat_role, surface, source)
    VALUES
      (@session_id, @principal_key, @device_key, @binding_evidence, @first_seen, @last_seen,
       @tool, @account_id, @org_id, @account_class, @class_evidence, @plan, @seat_role, @surface, @source)
    ON CONFLICT(session_id) DO UPDATE SET
      last_seen = excluded.last_seen,
      tool = COALESCE(session_identity.tool, excluded.tool),
      account_id = COALESCE(session_identity.account_id, excluded.account_id),
      org_id = COALESCE(session_identity.org_id, excluded.org_id),
      account_class = COALESCE(session_identity.account_class, excluded.account_class),
      class_evidence = COALESCE(session_identity.class_evidence, excluded.class_evidence),
      plan = COALESCE(session_identity.plan, excluded.plan),
      seat_role = COALESCE(session_identity.seat_role, excluded.seat_role),
      surface = COALESCE(session_identity.surface, excluded.surface),
      source = COALESCE(session_identity.source, excluded.source)`);
  const upgradeRank = db.prepare(
    `UPDATE session_identity SET binding_evidence = ?
     WHERE session_id = ? AND (CASE binding_evidence WHEN 'session_proved' THEN 3 WHEN 'store_origin' THEN 2 WHEN 'ambient' THEN 1 ELSE 0 END) < ?`,
  );
  let n = 0;
  const now = Date.now();
  for (const r of rows) {
    upsert.run({
      session_id: r.session_id,
      principal_key: r.principal_key ?? null,
      device_key: r.device_key ?? null,
      binding_evidence: r.binding_evidence ?? 'unbound',
      first_seen: r.first_seen ?? now,
      last_seen: r.last_seen ?? now,
      tool: r.tool ?? null,
      account_id: r.account_id ?? null,
      org_id: r.org_id ?? null,
      account_class: r.account_class ?? null,
      class_evidence: r.class_evidence ?? null,
      plan: r.plan ?? null,
      seat_role: r.seat_role ?? null,
      surface: r.surface ?? null,
      source: r.source ?? 'live',
    });
    const incRank = BIND_RANK[r.binding_evidence ?? 'unbound'] ?? 0;
    upgradeRank.run(r.binding_evidence ?? 'unbound', r.session_id, incRank);
    n++;
  }
  return n;
}

// ── feature 36: account_switched ──────────────────────────────────────────────

interface SiRow { session_id: string; tool: Tool | null; device_key: string | null; account_id: string | null; org_id: string | null; plan: string | null; principal_key: string | null; first_seen: number }

/**
 * Fires when account_id, org_id or plan for one tool on one machine changes
 * between sessions. The key is anchored on the OBSERVED session's UTC bucket,
 * never detection time, so re-running collect cannot produce a second incident.
 * The detail quotes both literal values.
 */
export function detectAccountSwitched(db: DB, now = Date.now()): Anomaly[] {
  const out: Anomaly[] = [];
  for (const source of ['live', 'seed'] as const) {
    const rows = db
      .prepare(`SELECT session_id, tool, device_key, account_id, org_id, plan, principal_key, first_seen
                FROM session_identity WHERE source = ? ORDER BY first_seen`)
      .all(source) as SiRow[];
    const groups = new Map<string, SiRow[]>();
    for (const r of rows) {
      const g = `${r.tool ?? '?'}:${r.device_key ?? '?'}`;
      groups.set(g, [...(groups.get(g) ?? []), r]);
    }
    for (const [group, rs] of groups) {
      let prev: SiRow | null = null;
      for (const r of rs) {
        if (prev) {
          for (const field of ['account_id', 'org_id', 'plan'] as const) {
            const from = prev[field];
            const to = r[field];
            if (from !== null && from !== undefined && to !== null && to !== undefined && from !== to) {
              const bucket = Math.floor(r.first_seen / 86_400_000);
              const machine = r.device_key ?? 'unknown-device';
              const a: Anomaly = {
                anomaly_key: `identity:account_switch:${r.tool ?? '?'}:${machine}:${from}:${to}:${bucket}`,
                rule: 'account_switched',
                severity: 'info',
                tool: (r.tool ?? 'claude_code') as Anomaly['tool'],
                session_id: r.session_id,
                model: null,
                window_start: prev.first_seen,
                window_end: r.first_seen,
                title: `${r.tool ?? 'tool'} switched ${field === 'plan' ? 'plan' : field === 'org_id' ? 'organization' : 'account'} from ${from} to ${to}`,
                detail: `The same binary on one machine produced sessions under two values of ${field}: '${from}' then '${to}'. Dated to between the two sessions, not to the moment of the switch — a switch that happened and reverted between collection passes is invisible. Cannot distinguish a deliberate account change from a token refresh returning different plan metadata.`,
                observed: 1, baseline: null, threshold: null,
                confidence: 'activity_only', source, detected_at: now,
              };
              out.push({ ...a, anomaly_key: `${source}:${a.anomaly_key}` });
            }
          }
        }
        // Only advance the comparison cursor on rows that carry a value.
        if (r.account_id !== null || r.org_id !== null || r.plan !== null) prev = r;
      }
      void group;
    }
  }
  return out;
}

// ── feature 35: shadow_account_on_corporate_repo ─────────────────────────────

export interface IdentityPolicyLike {
  corporate_org_uuids?: string[];
  corporate_repo_owners?: string[];
  git_remote_hosts?: string[];
  repo_globs?: string[];
  sanctioned_account_classes?: string[];
  sha256?: string;
}

/** Reads <cwd>/.git/config [remote "origin"] — a file read, no git spawn. */
export function repoRemoteOrigin(cwd: string): string | null {
  const file = join(cwd, '.git', 'config');
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf8');
    const section = text.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/);
    if (!section) return null;
    const url = section[1].match(/url\s*=\s*(\S+)/);
    return url?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Splits a remote URL into host/owner/repo, ssh or https shape. */
export function parseRemote(url: string): { host: string | null; owner: string | null; repo: string | null } {
  const m = url.match(/^(?:https?:\/\/|git@)([^:/]+)[/:](.+?)(?:\.git)?$/);
  if (!m) return { host: null, owner: null, repo: null };
  const [, host, path] = m;
  const [owner, repo] = path.split('/');
  return { host: host ?? null, owner: owner ?? null, repo: repo ?? null };
}

/** 'corporate' is a policy declaration, never a path-name guess. */
export function isCorporateRepo(policy: IdentityPolicyLike, remote: { host: string | null; owner: string | null; repo: string | null }): boolean {
  if (remote.owner && policy.corporate_repo_owners?.includes(remote.owner)) return true;
  if (remote.host && policy.git_remote_hosts?.includes(remote.host)) return true;
  const slug = remote.owner && remote.repo ? `${remote.owner}/${remote.repo}` : null;
  if (slug && policy.repo_globs?.some((g) => glob(g, slug))) return true;
  return false;
}

function glob(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  const parts = pattern.split('*');
  if (parts.length === 1) return false;
  const [first, ...tail] = parts;
  let rest = value;
  if (first && !rest.startsWith(first)) return false;
  rest = rest.slice(first!.length);
  const last = tail.pop()!;
  for (const mid of tail) {
    const i = rest.indexOf(mid);
    if (i === -1) return false;
    rest = rest.slice(i + mid.length);
  }
  return !last || rest.endsWith(last);
}

/**
 * Inert without a populated policy block — and says so. Renders NULL, not a
 * pass, when the repo has no remote, the cwd no longer exists, or the class
 * came only from the current-account snapshot (binding_evidence !== 'session_proved').
 */
export function detectShadowAccountOnCorporateRepo(
  db: DB,
  policy: IdentityPolicyLike | null,
  now = Date.now(),
): { anomalies: Anomaly[]; inertReason: string | null } {
  if (!policy || (!policy.corporate_repo_owners?.length && !policy.git_remote_hosts?.length && !policy.repo_globs?.length && !policy.corporate_org_uuids?.length)) {
    return { anomalies: [], inertReason: 'no identity policy loaded — shadow_account_on_corporate_repo is disabled by design' };
  }
  const out: Anomaly[] = [];
  const sanctioned = new Set(policy.sanctioned_account_classes ?? []);
  const rows = db
    .prepare(`SELECT si.session_id, si.tool, si.account_class, si.class_evidence, si.org_id, si.principal_key, si.binding_evidence, si.first_seen
              FROM session_identity si WHERE si.source = 'live'
                AND si.account_class IS NOT NULL AND si.binding_evidence = 'session_proved'`)
    .all() as (SiRow & { account_class: string; class_evidence: string | null; binding_evidence: string })[];
  for (const r of rows) {
    if (sanctioned.has(r.account_class)) continue;
    if (r.org_id && policy.corporate_org_uuids?.includes(r.org_id)) continue; // a corporate org id under any class is sanctioned
    const cwdRow = db
      .prepare('SELECT project FROM usage_events WHERE session_id = ? AND project IS NOT NULL ORDER BY ts LIMIT 1')
      .get(r.session_id) as { project: string } | undefined;
    let remote: { host: string | null; owner: string | null; repo: string | null } | null = null;
    let slug = '';
    if (cwdRow?.project && existsSync(cwdRow.project)) {
      const url = repoRemoteOrigin(cwdRow.project);
      if (url) remote = parseRemote(url);
    }
    if (!remote) {
      // Fall back to ~/.claude.json githubRepoPaths for this cwd.
      const claude = readClaudeJson();
      const hit = claude?.githubRepoPaths[cwdRow?.project ?? ''];
      if (hit?.owner) remote = { host: null, owner: hit.owner, repo: hit.repo ?? null };
    }
    if (!remote || !isCorporateRepo(policy, remote)) continue; // NULL, not a pass: no remote / cwd gone
    slug = remote.owner && remote.repo ? `${remote.owner}/${remote.repo}` : (remote.owner ?? 'unknown repo');
    const a: Anomaly = {
      anomaly_key: `identity:shadow_account:${r.principal_key ?? 'unknown'}:${r.session_id}`,
      rule: 'shadow_account_on_corporate_repo',
      severity: 'warn',
      tool: (r.tool ?? 'claude_code') as Anomaly['tool'],
      session_id: r.session_id,
      model: null,
      window_start: r.first_seen,
      window_end: r.first_seen,
      title: `Non-sanctioned account class ${r.account_class} on corporate repo ${slug}`,
      detail: `Session ${r.session_id} ran under account_class='${r.account_class}' (evidence: ${r.class_evidence ?? 'null'}) while its working directory resolved to corporate repo ${slug}. Policy clause: corporate_repo_owners/git_remote_hosts/repo_globs from identity policy ${policy.sha256 ?? 'sha unknown'}. Classification is configuration evidence — a lower bound.`,
      observed: 1, baseline: null, threshold: null,
      confidence: 'activity_only', source: 'live', detected_at: now,
    };
    out.push(a);
  }
  return { anomalies: out, inertReason: null };
}

// ── feature 3: seat inventory and seat-value reconciliation ─────────────────

export interface SeatBucket {
  tool: string;
  purchased_plan: string | null;
  purchased_seats: number | null;
  price_usd: number | null;
  observed_plans: { plan: string | null; principals: number; sessions: number }[];
  /** seats paid for with no usage observed BY VOLE — never 'unused'. */
  no_usage_observed: number | null;
  /** sessions on a plan the company never bought (shadow spend). */
  shadow_sessions: number;
  matched: boolean;
}

/**
 * Reconciles observed plans (session_identity.plan, oauthAccount) against the
 * plain `seats_purchased` block in the identity policy. The plan string is
 * what the client was told at runtime, not the billing record — buckets are
 * labelled accordingly by the caller.
 */
export function seatInventory(db: DB, purchased: Record<string, { plan?: string; seats: number; price_usd?: number }> | null | undefined): SeatBucket[] {
  const observed = db
    .prepare(`SELECT tool, plan, COUNT(DISTINCT principal_key) AS principals, COUNT(DISTINCT session_id) AS sessions
              FROM session_identity WHERE source = 'live' AND plan IS NOT NULL GROUP BY tool, plan`)
    .all() as { tool: string; plan: string; principals: number; sessions: number }[];
  const tools = new Set<string>([...Object.keys(purchased ?? {}), ...observed.map((o) => o.tool)]);
  const out: SeatBucket[] = [];
  for (const tool of tools) {
    const p = purchased?.[tool] ?? null;
    const plans = observed.filter((o) => o.tool === tool);
    const shadow = p ? plans.filter((o) => p.plan && o.plan !== p.plan) : plans;
    const principalsOnTool = db
      .prepare(`SELECT COUNT(DISTINCT principal_key) AS n FROM session_identity WHERE source = 'live' AND tool = ?`)
      .get(tool) as { n: number };
    out.push({
      tool,
      purchased_plan: p?.plan ?? null,
      purchased_seats: p?.seats ?? null,
      price_usd: p?.price_usd ?? null,
      observed_plans: plans.map((o) => ({ plan: o.plan, principals: o.principals, sessions: o.sessions })),
      no_usage_observed: p ? Math.max(0, p.seats - principalsOnTool.n) : null,
      shadow_sessions: shadow.reduce((s, o) => s + o.sessions, 0),
      matched: !!p && plans.length > 0 && plans.some((o) => !p.plan || o.plan === p.plan),
    });
  }
  return out;
}

/**
 * The oauthAccount plan census, landed in vendor_identities (names and HMACs
 * only): one row per vendor identity the local files attest to.
 */
export function recordVendorIdentities(db: DB, now = Date.now()): number {
  const claude = readClaudeJson();
  const codex = readCodexAuthShape();
  const grok = readGrokAuthShape();
  const upsert = db.prepare(`
    INSERT INTO vendor_identities (vendor, local_key_kind, local_key, vendor_id_kind, vendor_id_hmac, plan, org_id_hmac, auth_path, evidence_artifact, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vendor, local_key_kind, local_key) DO UPDATE SET
      last_seen = excluded.last_seen,
      plan = COALESCE(vendor_identities.plan, excluded.plan),
      org_id_hmac = COALESCE(vendor_identities.org_id_hmac, excluded.org_id_hmac),
      auth_path = COALESCE(vendor_identities.auth_path, excluded.auth_path)`);
  let n = 0;
  const home = homedir();
  if (claude?.oauthAccount) {
    const oa = claude.oauthAccount;
    const planBits = [oa.organizationType, oa.organizationRateLimitTier, oa.billingType].filter(Boolean).join('/');
    upsert.run('anthropic', 'oauthAccount', 'claude_code', 'organizationUuid', oa.organizationUuid ? hmacIdentity(oa.organizationUuid) : null,
      planBits || null, oa.organizationUuid ? hmacIdentity(oa.organizationUuid) : null, 'oauth', join(home, '.claude.json'), now, now);
    n++;
  }
  if (codex) {
    upsert.run('openai', 'auth_mode', 'codex', 'tokens.account_id', null, null, null,
      codex.auth_mode === 'chatgpt' ? 'oauth' : 'api_key', join(home, '.codex', 'auth.json'), now, now);
    n++;
  }
  if (grok) {
    upsert.run('xai', 'oidc', 'grok', 'principal_id', null, null, null, 'oidc', join(home, '.grok', 'auth.json'), now, now);
    n++;
  }
  return n;
}

/** feature 25's Settings line: the env key NAMES observed (names only, never values). */
export function envKeyNamesObserved(): string[] {
  const { env } = readClaudeSettingsEnv();
  return Object.keys(env);
}

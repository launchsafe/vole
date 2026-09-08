import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Source locations default to the standard per-user install paths of each tool, resolved
 * at runtime against whoever runs Vole — no absolute paths are baked into the code.
 *
 * Configuration, in priority order:
 *   1. A per-source env var (VOLE_CLAUDE_PROJECTS, VOLE_CODEX_SESSIONS, …) points that
 *      one source at a non-standard location.
 *   2. VOLE_HOME_OVERRIDE relocates the entire default layout under one root (tests use
 *      it to point every source at fixtures instead of the real home directory).
 */
export const home = () => process.env.VOLE_HOME_OVERRIDE ?? homedir();

export const paths = {
  /** Where Vole stores its own database. */
  db: () => process.env.VOLE_DB ?? join(home(), '.vole', 'vole.db'),

  /** Per-installation pricing override merged over the built-in rate table. */
  pricingOverride: () => process.env.VOLE_PRICING ?? join(home(), '.vole', 'pricing.json'),

  /**
   * The sanctioned-surface declaration, in precedence order (later wins, the
   * same precedence pricing.json already uses): an admin-owned machine policy
   * first, a per-user declaration second. Absent everywhere = no policy, and
   * 'unsanctioned' stays inert — it is a company decision, not a technical fact.
   */
  surfacePolicyPaths: (): string[] => [
    '/Library/Application Support/Vole/surfaces.json',
    join(home(), '.vole', 'policy', 'surfaces.json'),
  ],

  /** Claude Code session transcripts: ~/.claude/projects/<slug>/<session-id>.jsonl */
  claudeCodeProjects: () => process.env.VOLE_CLAUDE_PROJECTS ?? join(home(), '.claude', 'projects'),

  /** Gemini CLI home (stats + the prompt cache Vole deliberately never reads). */
  geminiHome: () => process.env.VOLE_GEMINI_HOME ?? join(home(), '.gemini'),

  /** Codex rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl */
  codexSessions: () => process.env.VOLE_CODEX_SESSIONS ?? join(home(), '.codex', 'sessions'),

  /** Cursor AI attribution DB. Contains models and sessions but no token counts. */
  cursorTrackingDb: () =>
    process.env.VOLE_CURSOR_DB ?? join(home(), '.cursor', 'ai-tracking', 'ai-code-tracking.db'),

  /** Antigravity conversation payloads (encrypted) and their readable sibling artifacts. */
  antigravityConversations: () =>
    process.env.VOLE_ANTIGRAVITY_CONVERSATIONS ??
    join(home(), '.gemini', 'antigravity-ide', 'conversations'),
  antigravityBrain: () =>
    process.env.VOLE_ANTIGRAVITY_BRAIN ?? join(home(), '.gemini', 'antigravity-ide', 'brain'),

  /** OpenCode's SQLite store. `message` rows carry exact per-response tokens and cost. */
  opencodeDb: () =>
    process.env.VOLE_OPENCODE_DB ?? join(home(), '.local', 'share', 'opencode', 'opencode.db'),

  /** Grok CLI (xAI): unified log with per-turn token usage, plus per-session summaries. */
  grokUnifiedLog: () => process.env.VOLE_GROK_LOG ?? join(home(), '.grok', 'logs', 'unified.jsonl'),
  grokSessionsDir: () => process.env.VOLE_GROK_SESSIONS ?? join(home(), '.grok', 'sessions'),

  /** Devin editor ACP conversation stores. Content only — no token data. */
  devinAcpMessages: () =>
    process.env.VOLE_DEVIN_MESSAGES ??
    join(home(), 'Library', 'Application Support', 'Devin', 'User', 'acp-messages'),

  // ── Foundation path constants ────────────────────────────────────────────
  //
  // The admin-authored policy/pack layout and the per-source env overrides the
  // remaining features read. Everything under the managed root wins over the
  // per-user file, mirroring the surfacePolicyPaths precedence. All of these are
  // LOCAL disk reads; nothing here phones home (the network adapters remain
  // opt-in and default-off under their own flags).

  /** Managed pack/policy root — admin-owned, read-only to the user. */
  managedRoot: () => join('/Library', 'Application Support', 'Vole'),

  /** Versioned content packs (DLP detectors, pricing, assets, terms, noise). */
  packPaths: (): string[] => [
    join('/Library', 'Application Support', 'Vole', 'packs'),
    join(home(), '.vole', 'packs'),
  ],

  /** Identity policy: org UUIDs, repo owners, sanctioned account classes, lifecycle[]. */
  identityPolicyPaths: (): string[] => [
    join('/Library', 'Application Support', 'Vole', 'identity.json'),
    join(home(), '.vole', 'policy', 'identity.json'),
  ],

  /** The admin-authored asset register (tier 6 crown jewels). */
  assetsPolicyPaths: (): string[] => [
    join('/Library', 'Application Support', 'Vole', 'assets.json'),
    join(home(), '.vole', 'policy', 'assets.json'),
  ],

  /** The inalienable exclusion floor for personal work (tier 3). */
  exclusionPaths: (): string[] => [
    join('/Library', 'Application Support', 'Vole', 'exclude.json'),
    join(home(), '.vole', 'policy', 'exclude.json'),
  ],

  /** Rule-threshold and retention policy (tier 6 Policy screen, tier 8 retention). */
  rulePolicyPaths: (): string[] => [
    join('/Library', 'Application Support', 'Vole', 'policy.json'),
    join(home(), '.vole', 'policy', 'policy.json'),
  ],

  /** Declared lawful-basis / pilot-mode record (tier 3 first-run gate, tier 3 pilot). */
  basisRecord: () => process.env.VOLE_BASIS ?? join(home(), '.vole', 'basis.json'),

  /** Approved-baseline snapshot (tier 6: `vole posture baseline`). */
  baseline: () => process.env.VOLE_BASELINE ?? join(home(), '.vole', 'baseline.json'),

  /** Declared billing-unit bridge (tier 8: credits, seats, premium requests). */
  unitsOverride: () => process.env.VOLE_UNITS ?? join(home(), '.vole', 'units.json'),

  /** Budget declarations (tier 8: budget burn-down). */
  budgetPaths: (): string[] => [
    join('/Library', 'Application Support', 'Vole', 'budgets.json'),
    join(home(), '.vole', 'budgets.json'),
  ],

  /**
   * Agent home override: CLAUDE_CONFIG_DIR / CODEX_HOME redirect where an agent
   * keeps its state. The collectors honor these (the evidence text already
   * claimed they did); a home resolving outside every known agent_root is the
   * agent_home_moved signal.
   */
  claudeConfigDir: () => process.env.CLAUDE_CONFIG_DIR ?? join(home(), '.claude'),
  kiroHome: () => process.env.VOLE_KIRO_HOME ?? join(process.env.VOLE_HOME_OVERRIDE ?? homedir(), '.kiro'),
  /**
   * Every Claude Code transcript root — always a list, because every caller walks
   * it. Returning a bare string made `for (const root of roots)` iterate the path's
   * CHARACTERS, and `existsSync('/')` is true, so the vendor pass walked the whole
   * filesystem. VOLE_CLAUDE_PROJECT_ROOTS may name several, separated as PATH is.
   */
  claudeCodeProjectRoots: (): string[] =>
    process.env.VOLE_CLAUDE_PROJECT_ROOTS?.split(delimiter).filter(Boolean) ?? [paths.claudeCodeProjects()],
  codexHome: () => process.env.CODEX_HOME ?? join(home(), '.codex'),
};

// ── Agent-home resolution (tier 2 deep) ──────────────────────────────────────

/** Env vars that redirect an agent's home — re-checked every pass. */
export const AGENT_HOME_ENV_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_HOME'] as const;

export interface AgentHomeRoot {
  root: string;
  app: string;
  path: string;
  tool: string;
  granted_by: string;
  envVar?: string;
}

/** All agent homes in play: the defaults plus every redirected one. */
export function agentHomes(): AgentHomeRoot[] {
  const defaults: Record<string, string> = {
    CLAUDE_CONFIG_DIR: join(process.env.VOLE_HOME_OVERRIDE ?? homedir(), '.claude'),
    CODEX_HOME: join(process.env.VOLE_HOME_OVERRIDE ?? homedir(), '.codex'),
    GEMINI_HOME: join(process.env.VOLE_HOME_OVERRIDE ?? homedir(), '.gemini'),
  };
  const out: AgentHomeRoot[] = [];
  for (const [env, def] of Object.entries(defaults)) {
    const val = process.env[env] ?? def;
    if (existsSync(val)) {
      const app = env.replace('_HOME', '').replace('_CONFIG_DIR', '').toLowerCase();
      out.push({ root: val, app, path: val, tool: app, granted_by: process.env[env] ? `env:${env}` : 'default', envVar: env });
    }
  }
  // rc-declared and policy-declared homes join too
  for (const r of shellRcAgentHomes()) {
    if (!out.some((o) => o.path === r.path)) out.push(r);
  }
  for (const e of policyExtraRoots()) {
    const root = typeof e === 'string' ? e : e.root;
    if (root && !out.some((o) => o.path === root)) {
      out.push({ root, app: 'policy', path: root, tool: typeof e === 'object' && e.tool ? e.tool : 'policy', granted_by: 'policy' });
    }
  }
  return out;
}

/** Editor roots: every editor home with globalStorage (marker test, not names). */
export interface EditorRoot { root: string; app: string; marker?: string }

export function editorRoots(): EditorRoot[] {
  const out: { root: string; app: string }[] = [];
  try {
    const as = join(process.env.VOLE_HOME_OVERRIDE ?? homedir(), 'Library', 'Application Support');
    for (const name of readdirSync(as)) {
      if (existsSync(join(as, name, 'User', 'globalStorage', 'storage.json'))) {
        out.push({ root: join(as, name), app: name });
      }
    }
  } catch {
    /* unreadable */
  }
  return out;
}

/** Agent-home paths parsed from shell rc files — the redirect nobody declares. */
export function shellRcAgentHomes(): AgentHomeRoot[] {
  const out: AgentHomeRoot[] = [];
  for (const rc of ['.zshrc', '.bashrc', '.zprofile', '.bash_profile', '.profile']) {
    const p = join(process.env.VOLE_HOME_OVERRIDE ?? homedir(), rc);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf8');
      for (const v of AGENT_HOME_ENV_VARS) {
        const m = text.match(new RegExp(`^(?:export\\s+)?${v}=["']?([^"'#\\s]+)`, 'm'));
        if (m?.[1]) {
          out.push({ root: m[1], app: v.toLowerCase(), path: m[1], tool: v.toLowerCase(), granted_by: 'rc:' + rc, envVar: v });
        }
      }
    } catch {
      /* unreadable */
    }
  }
  return out;
}

import { existsSync, readFileSync, readdirSync } from 'node:fs';

export function policyExtraRoots(): { root: string; tool: string }[] {
  try {
    const policy = join(process.env.VOLE_HOME_OVERRIDE ?? homedir(), '.vole', 'policy', 'policy.json');
    const alt = join(process.env.VOLE_HOME_OVERRIDE ?? homedir(), '.vole', 'policy.json');
    if (!existsSync(policy)) return [];
    const cfg = JSON.parse(readFileSync(policy, 'utf8')) as { extra_roots?: ({ root: string; tool: string } | string)[] };
    return (cfg.extra_roots ?? []).map((e) => typeof e === 'string' ? { root: e, tool: 'policy' } : e);
  } catch {
    return [];
  }
}

import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

  /** Claude Code session transcripts: <claude home>/projects/<slug>/<session-id>.jsonl.
   *  Honors CLAUDE_CONFIG_DIR through claudeConfigDir() — the redirect evidence text
   *  promised collectors follow it every pass, and now they do. */
  claudeCodeProjects: () => process.env.VOLE_CLAUDE_PROJECTS ?? join(paths.claudeConfigDir(), 'projects'),

  /** Gemini CLI home (stats + the prompt cache Vole deliberately never reads). */
  geminiHome: () => process.env.VOLE_GEMINI_HOME ?? join(home(), '.gemini'),

  /** Codex rollouts: <codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl (honors CODEX_HOME). */
  codexSessions: () => process.env.VOLE_CODEX_SESSIONS ?? join(paths.codexHome(), 'sessions'),

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
  codexHome: () => process.env.CODEX_HOME ?? join(home(), '.codex'),

  /** Kiro home (agent sessions + the session-index ledger of removed sessions). */
  kiroHome: () => process.env.VOLE_KIRO_HOME ?? join(home(), '.kiro'),

  /** Every Claude Code project root Vole knows about: every known claude home's
   *  projects dir. A session living under none of them is agent_home_moved. */
  claudeCodeProjectRoots: (): string[] =>
    agentHomes()
      .filter((h) => h.tool === 'claude_code')
      .map((h) => join(h.path, 'projects')),
};

// ── Agent-home and editor-root resolution (tier 2, features 7/31) ─────────────
//
// Marker tests, never name lists: a directory is an editor root because it
// contains User/globalStorage/storage.json, and it is an agent home because it
// is a default, an exported env override, declared in a scanned rc file, an
// Xcode agent path, admin-listed in policy.json, or (claude only) present
// under /Users by stat. A fork nobody has heard of still resolves.

export interface AgentHome {
  label: string;
  path: string;
  tool: string;
  granted_by: string;
}

/** Env names whose value is itself an agent-home redirect. */
export const AGENT_HOME_ENV_VARS: Record<string, { label: string; tool: string; defaultPath: () => string }> = {
  CLAUDE_CONFIG_DIR: { label: 'Claude Code', tool: 'claude_code', defaultPath: () => join(home(), '.claude') },
  CODEX_HOME: { label: 'Codex', tool: 'codex', defaultPath: () => join(home(), '.codex') },
  GEMINI_HOME: { label: 'Gemini CLI', tool: 'gemini', defaultPath: () => join(home(), '.gemini') },
};

/** Shell rc files scanned for exported agent-home env vars (discovery, not truth). */
const RC_FILES = ['.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile'];

export interface RcExport {
  envVar: string;
  value: string;
  file: string;
}

/** Agent-home redirects exported in a shell rc file — a redirect the env of this
 *  process may not carry, discovered from the file that sets it. */
export function shellRcAgentHomes(): RcExport[] {
  const out: RcExport[] = [];
  for (const f of RC_FILES) {
    const p = join(home(), f);
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      // export VAR=value (quoted or bare); not inside an obvious comment.
      const m = line.match(/^\s*(?:export\s+)?(CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_HOME)=(["']?)([^"'#\s]+)\2/);
      if (m && !/^\s*#/.test(line)) {
        out.push({ envVar: m[1]!, value: m[3]!, file: p });
      }
    }
  }
  return out;
}

/** extra_roots[] declared in policy.json — the admin-authored extension of the census. */
export function policyExtraRoots(): { root: string; tool: string }[] {
  for (const p of paths.rulePolicyPaths()) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { extra_roots?: { root: string; tool?: string }[] };
      if (Array.isArray(parsed.extra_roots)) {
        return parsed.extra_roots
          .filter((r) => typeof r?.root === 'string')
          .map((r) => ({ root: r.root, tool: r.tool ?? 'unknown' }));
      }
    } catch {
      /* absent or malformed: this layer contributes nothing */
    }
  }
  return [];
}

/**
 * Every agent home this pass can see: defaults, env redirects (process env AND
 * rc files), Xcode agent paths, admin-declared extra_roots, and /Users/<user>/.claude
 * by stat only. Only roots that are well-known, exported, or admin-listed are
 * discoverable — an inline per-command override leaves no trace and stays invisible,
 * so this widens coverage without ever proving completeness.
 */
export function agentHomes(): AgentHome[] {
  const out: AgentHome[] = [];
  const seen = new Set<string>();
  const add = (h: AgentHome) => {
    if (!seen.has(h.path)) {
      seen.add(h.path);
      out.push(h);
    }
  };
  add({ label: 'Claude Code', path: paths.claudeConfigDir(), tool: 'claude_code', granted_by: 'default-or-env' });
  add({ label: 'Codex', path: paths.codexHome(), tool: 'codex', granted_by: 'default-or-env' });
  for (const rc of shellRcAgentHomes()) {
    const meta = AGENT_HOME_ENV_VARS[rc.envVar]!;
    add({ label: meta.label, path: rc.value, tool: meta.tool, granted_by: `rc:${rc.file}` });
  }
  // Xcode's own agent config (CodingAssistant) and per-Xcode-version agent homes.
  const xcode = join(home(), 'Library', 'Developer', 'Xcode');
  add({ label: 'Xcode CodingAssistant (Claude)', path: join(xcode, 'CodingAssistant', 'ClaudeAgentConfig'), tool: 'claude_code', granted_by: 'xcode' });
  try {
    const versions = join(xcode, 'Agents', 'XcodeVersions');
    for (const v of readdirSync(versions)) {
      add({ label: `Xcode ${v} agent`, path: join(versions, v, 'claude'), tool: 'claude_code', granted_by: 'xcode' });
    }
  } catch {
    /* no Xcode agent versions: nothing to add */
  }
  for (const r of policyExtraRoots()) {
    add({ label: r.root, path: r.root, tool: r.tool, granted_by: 'policy' });
  }
  // /Users/*/.claude by stat only — finding another POSIX user's home needs FDA
  // and usually root; absence of hits is a permission fact, not an absence fact.
  // Skipped under VOLE_HOME_OVERRIDE: a fixture home has nothing to say about /Users.
  if (!process.env.VOLE_HOME_OVERRIDE) {
    try {
      for (const u of readdirSync('/Users')) {
        const p = join('/Users', u, '.claude');
        if (existsSync(p)) add({ label: `~${u}/.claude`, path: p, tool: 'claude_code', granted_by: 'stat:/Users' });
      }
    } catch {
      /* unreadable /Users: skip */
    }
  }
  return out;
}

export interface EditorRoot {
  /** The app-support dir name, e.g. 'Code', 'Cursor', 'Antigravity IDE'. */
  app: string;
  /** <App Support>/<app> — the root everything editor-related hangs off. */
  root: string;
  marker: string;
}

/**
 * Editor roots by MARKER, not name: every directory under Application Support
 * containing User/globalStorage/storage.json. A fork nobody has heard of still
 * resolves; a lookalike without the marker ('ZCode') is correctly rejected.
 */
export function editorRoots(): EditorRoot[] {
  const base = join(home(), 'Library', 'Application Support');
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  const out: EditorRoot[] = [];
  for (const app of entries) {
    const root = join(base, app);
    const marker = join(root, 'User', 'globalStorage', 'storage.json');
    // existsSync, not a read: existence is the marker; whether it is READABLE
    // is a separate fact the scan_access probe owns.
    if (existsSync(marker)) out.push({ app, root, marker });
  }
  return out;
}

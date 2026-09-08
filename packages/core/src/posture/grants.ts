import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DB } from '../db';
import { insertAnomalies } from '../db';
import {
  home, sha, readJson, parseToml, tryReaddir, upsertLever, bumpCounter, parseHost,
  type PostureState,
} from './shared';

/**
 * The grant-and-override ledger: WHO gave the agent this authority, WHICH FILE
 * declared it, and what each wildcard actually authorised. Two halves:
 *
 *  1. Grants — the file that granted the authority is the evidence. Every row
 *     carries the precedence class (managed / user / project / repo_controlled
 *     / unknown), the origin (file / click / xcode_default / per-turn) and a
 *     classification of the entry itself.
 *  2. Overrides — the keys that WEAKEN the guardrails (skip prompts, yolo
 *     modes, permission defaults), with the literal key = value and the file.
 *
 * When no settings file explains an observed posture, granted_by stays 'unknown'
 * — the panel says so rather than guessing a flag.
 */

// ── Entry classification (blanket-approval inventory) ──────────────────────────

export type EntryClass = 'exact' | 'prefix_wildcard' | 'tool_wildcard' | 'mcp_server_wildcard';

/** 'Bash(git *)' is a prefix wildcard; 'Bash' or 'Bash(*)' a tool wildcard;
 *  'mcp__github' (the whole server, every tool on it) an MCP wildcard. */
export function classifyGrantEntry(entry: string): EntryClass {
  const e = entry.trim();
  if (e.startsWith('mcp__')) return 'mcp_server_wildcard';
  const m = e.match(/^(\w+)\((.*)\)$/);
  if (!m) return 'tool_wildcard'; // bare tool name: every call of that tool
  const arg = m[2]!;
  if (arg === '' || arg === '*') return 'tool_wildcard';
  if (/\*$/.test(arg) || arg.endsWith(':*')) return 'prefix_wildcard';
  return 'exact';
}

/**
 * Vole's own re-implementation of the vendor's matcher — it can disagree with
 * what the vendor actually matched, so the printed count carries that caveat.
 * ponytail: name/shape-level attribution; per-argument matching needs the args
 * ledger (args_digest is a hash, not a value).
 */
export function entryMatchesCall(entry: string, name: string, shape: string | null): boolean {
  const e = entry.trim();
  if (e.startsWith('mcp__')) {
    const server = e.replace(/__\*$/, '');
    return name === server || name.startsWith(`${server}__`);
  }
  const m = e.match(/^(\w+)\((.*)\)$/);
  const tool = m?.[1] ?? e;
  const arg = m?.[2] ?? '';
  if (!m) return name === tool;                       // bare 'Read'
  if (arg === '' || arg === '*') return name === tool; // 'Bash(*)'
  if (/\*$/.test(arg)) {
    const prefix = arg.slice(0, -1).trim();
    return name === tool && (shape === null || shape.startsWith(prefix));
  }
  return name === tool; // exact path: attributable at tool level, not arg level
}

// ── Path-class resolution (the precedence chain) ─────────────────────────────

export type PathClass = 'managed' | 'user' | 'project' | 'repo_controlled' | 'unknown';

export function pathClassOf(sourceFile: string): PathClass {
  const h = home();
  if (sourceFile.startsWith('/Library/Application Support/ClaudeCode/')) return 'managed';
  if (sourceFile.startsWith('/Library/Application Support/GeminiCli/')) return 'managed';
  if (sourceFile.startsWith('/Library/Application Support/ampcode/')) return 'managed';
  if (sourceFile.startsWith(join(h, '.codex', 'requirements'))) return 'managed';
  if (sourceFile === join(h, '.claude.json')) return 'user';
  if (sourceFile.startsWith(join(h, '.claude', 'settings'))) return 'user';
  if (sourceFile.startsWith(join(h, '.codex', 'config.toml'))) return 'user';
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(sourceFile)) return 'repo_controlled';
  if (/(^|\/)\.mcp\.json$/.test(sourceFile)) return 'repo_controlled';
  if (sourceFile.startsWith(join(h, '.kiro', ''))) return 'user';
  return 'unknown';
}

/** Widen every grant row that predates the precedence columns — NULL-only,
 *  never overwriting a stored fact with a re-derived one. */
export function widenGrantPrecedence(db: DB, now: number): number {
  const rows = db.prepare(
    'SELECT grant_key, agent, source_file, kind, entry FROM grants WHERE path_class IS NULL',
  ).all() as { grant_key: string; agent: string; source_file: string; kind: string; entry: string }[];
  const update = db.prepare(`
    UPDATE grants SET
      granted_by  = COALESCE(granted_by, ?),
      path_class  = COALESCE(path_class, ?),
      origin      = COALESCE(origin, ?),
      scope       = COALESCE(scope, ?),
      entry_class = COALESCE(entry_class, ?),
      last_seen   = ?
    WHERE grant_key = ?`);
  let n = 0;
  for (const r of rows) {
    const pc = pathClassOf(r.source_file);
    const scope = pc === 'managed' || pc === 'user' ? 'global' : pc === 'repo_controlled' ? 'project' : 'unknown';
    update.run(r.source_file, pc, 'file', scope, r.kind === 'deny' ? null : classifyGrantEntry(r.entry), now, r.grant_key);
    n++;
  }
  return n;
}

/** Per-turn command_permissions snapshots from the transcript walker. */
export function recordPerTurnGrants(db: DB, entries: string[], sourceFile: string, now: number): number {
  const upsert = db.prepare(`
    INSERT INTO grants (grant_key, agent, source_file, kind, entry, granted_by, path_class, origin, scope, entry_class, first_seen, last_seen)
    VALUES (?, 'claude_code', ?, 'allow', ?, ?, 'unknown', 'per_turn', 'per-turn', ?, ?, ?)
    ON CONFLICT(grant_key) DO UPDATE SET last_seen = excluded.last_seen`);
  let n = 0;
  for (const entry of [...new Set(entries)]) {
    upsert.run(`perturn:claude_code:${sha(entry).slice(0, 24)}`, sourceFile, entry, sourceFile, classifyGrantEntry(entry), now, now);
    n++;
  }
  return n;
}

/** The calls-authorised join: how much each wildcard rule let through, and the
 *  calls no entry matched (attributed to posture, never to a rule). */
export function blanketInventory(db: DB, now: number): { entries: number; wildcardCalls: number; postureCalls: number } {
  const grants = db.prepare(
    "SELECT grant_key, entry, entry_class FROM grants WHERE kind = 'allow' AND entry_class IS NOT NULL",
  ).all() as { grant_key: string; entry: string; entry_class: string }[];
  const calls = db.prepare(
    'SELECT name, shape, COUNT(*) AS n FROM tool_calls GROUP BY name, shape',
  ).all() as { name: string; shape: string | null; n: number }[];
  let wildcardCalls = 0;
  for (const g of grants) {
    if (g.entry_class === 'exact') continue;
    let count = 0;
    for (const c of calls) {
      if (entryMatchesCall(g.entry, c.name, c.shape)) count += c.n;
    }
    wildcardCalls += count;
    if (count) bumpCounter(db, `grant:${g.grant_key}`, 'authorised_calls', count, now);
  }
  // A call matched by NO entry — not even at tool level — is posture's doing.
  const postureCalls = calls
    .filter((c) => !grants.some((g) => entryMatchesCall(g.entry, c.name, c.shape)))
    .reduce((a, c) => a + c.n, 0);
  return { entries: grants.length, wildcardCalls, postureCalls };
}

// ── Managed-policy layers (coverage and the precedence chain per agent) ───────

export interface PolicyLayer {
  agent: string;
  layer: string;
  path: string;
  present: boolean | null; // null = unknown (EPERM — absence is only provable for readable paths)
  owner_uid: number | null;
  mode: string | null;
  sha256: string | null;
}

export function policyLayerPaths(): { agent: string; layer: string; path: string }[] {
  return [
    { agent: 'claude_code', layer: 'managed-settings', path: '/Library/Application Support/ClaudeCode/managed-settings.json' },
    { agent: 'claude_code', layer: 'user-settings', path: join(home(), '.claude', 'settings.json') },
    { agent: 'claude_code', layer: 'user-settings-local', path: join(home(), '.claude', 'settings.local.json') },
    { agent: 'codex', layer: 'requirements', path: join(home(), '.codex', 'requirements.toml') },
    { agent: 'codex', layer: 'config', path: join(home(), '.codex', 'config.toml') },
    { agent: 'gemini', layer: 'managed-settings', path: '/Library/Application Support/GeminiCli/settings.json' },
    { agent: 'amp', layer: 'managed-settings', path: '/Library/Application Support/ampcode/managed-settings.json' },
    { agent: 'cursor', layer: 'managed-hooks', path: '/Library/Application Support/Cursor/hooks.json' },
  ];
}

export function probePolicyLayers(): PolicyLayer[] {
  const out = policyLayerPaths().map((l) => {
    try {
      const st = statSync(l.path);
      const text = readFileSync(l.path, 'utf8');
      return { ...l, present: true, owner_uid: st.uid, mode: (st.mode & 0o777).toString(8), sha256: sha(text) };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return { ...l, present: code === 'ENOENT' ? false : null, owner_uid: null, mode: null, sha256: null };
    }
  });
  // The com.anthropic.claudecode defaults domain: the one layer that is not a file.
  try {
    const r = spawnSync('defaults', ['read', 'com.anthropic.claudecode'], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0) {
      out.push({ agent: 'claude_code', layer: 'defaults-domain', path: 'com.anthropic.claudecode', present: true, owner_uid: null, mode: null, sha256: sha(r.stdout ?? '') });
    } else if (/does not exist/i.test(r.stderr ?? '')) {
      out.push({ agent: 'claude_code', layer: 'defaults-domain', path: 'com.anthropic.claudecode', present: false, owner_uid: null, mode: null, sha256: null });
    } else {
      out.push({ agent: 'claude_code', layer: 'defaults-domain', path: 'com.anthropic.claudecode', present: null, owner_uid: null, mode: null, sha256: null });
    }
  } catch {
    out.push({ agent: 'claude_code', layer: 'defaults-domain', path: 'com.anthropic.claudecode', present: null, owner_uid: null, mode: null, sha256: null });
  }
  // /Library/Managed Preferences/<user>/ — the MDM delivery dir as a whole.
  const mp = join('/Library', 'Managed Preferences', process.env.USER ?? '');
  const mpProbe = tryReaddir(mp);
  out.push({
    agent: '*', layer: 'managed-preferences', path: mp,
    present: mpProbe.ok ? true : mpProbe.code === 'ENOENT' ? false : null,
    owner_uid: null, mode: null, sha256: null,
  });
  return out;
}

export function sweepPolicyLayers(db: DB, now: number): { layers: number; managedAgents: number } {
  const layers = probePolicyLayers();
  for (const l of layers) {
    upsertLever(db, l.agent, `policy_layer:${l.layer}`,
      l.present === null ? 'unknown' : l.present ? 'present' : 'absent',
      null, l.path, now);
  }
  const managedAgents = new Set(layers.filter((l) => l.present === true && (l.layer.includes('managed') || l.layer === 'requirements')).map((l) => l.agent));
  return { layers: layers.length, managedAgents: managedAgents.size };
}

// ── The overrides half: what weakens the guardrails, and which file said it ──

const OVERRIDE_KEYS = [
  'skipDangerousModePermissionPrompt', 'remoteControlAtStartup', 'defaultMode',
  'yolo', 'permission_mode', 'sandbox_mode', 'approval_policy', 'dangerouslySkipPermissions',
];

export function sweepOverrides(db: DB, now: number): number {
  const upsert = db.prepare(`
    INSERT INTO overrides (override_key, agent, source_file, kind, entry, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(override_key) DO UPDATE SET last_seen = excluded.last_seen`);
  let n = 0;
  const push = (agent: string, file: string, kind: string, entry: string) => {
    upsert.run(`override:${agent}:${sha(`${file}:${kind}:${entry}`).slice(0, 24)}`, agent, file, kind, entry, now, now);
    n++;
  };
  // Claude settings layers: env KEY NAMES only, never values.
  for (const file of ['/Library/Application Support/ClaudeCode/managed-settings.json', join(home(), '.claude', 'settings.json'), join(home(), '.claude', 'settings.local.json')]) {
    const cfg = readJson(file) as Record<string, unknown> | undefined;
    if (!cfg) continue;
    for (const key of OVERRIDE_KEYS) {
      if (key in cfg) push('claude_code', file, key, `${key} = ${JSON.stringify(cfg[key])}`);
    }
    const env = cfg.env as Record<string, unknown> | undefined;
    for (const name of Object.keys(env ?? {})) push('claude_code', file, `env:${name}`, `env.${name} = <set, value not stored>`);
    const dm = (cfg.permissions as { defaultMode?: string } | undefined)?.defaultMode;
    if (dm) push('claude_code', file, 'permissions.defaultMode', `permissions.defaultMode = ${dm}`);
  }
  // Codex config.toml: sandbox/approval posture keys.
  const codexToml = join(home(), '.codex', 'config.toml');
  if (existsSync(codexToml)) {
    try {
      const doc = parseToml(readFileSync(codexToml, 'utf8'));
      const top = doc.sections.get('')!;
      for (const key of ['sandbox_mode', 'approval_policy']) {
        const v = top.get(key);
        if (v !== undefined) push('codex', codexToml, key, `${key} = ${v}`);
      }
    } catch { /* malformed */ }
  }
  // Grok config.toml: yolo / permission_mode.
  const grokToml = join(home(), '.grok', 'config.toml');
  if (existsSync(grokToml)) {
    try {
      const doc = parseToml(readFileSync(grokToml, 'utf8'));
      const top = doc.sections.get('')!;
      for (const key of ['yolo', 'permission_mode']) {
        const v = top.get(key);
        if (v !== undefined) push('grok', grokToml, key, `${key} = ${v}`);
      }
    } catch { /* malformed */ }
  }
  return n;
}

// ── Kiro: the always-accept click, the yaml, and the admin-says/device-did ────

export interface KiroPersistedRule { pattern: string; scope: string; by_click: boolean; ts: number | null; rule_count: number | null }

export function parseKiroLog(text: string, fallbackTs: number): { rules: KiroPersistedRule[]; governance: Record<string, unknown> | null; autopilot: boolean } {
  const rules: KiroPersistedRule[] = [];
  let governance: Record<string, unknown> | null = null;
  let autopilot = false;
  let pendingClick = false;
  let ruleCount: number | null = null;
  for (const line of text.split('\n')) {
    if (/optionId['"]?\s*[:=]\s*['"]?always-accept/.test(line)) {
      pendingClick = true;
      continue;
    }
    const ts = parseKiroTs(line) ?? fallbackTs;
    const gov = line.match(/\[GovernanceService\] Resolved (\{.*\})/);
    if (gov) {
      try {
        governance = JSON.parse(gov[1]!.replace(/'/g, '"')) as Record<string, unknown>;
      } catch { /* keep null — never a guessed policy */ }
    }
    if (/agent_controller\.triggered/.test(line) && /Autopilot/i.test(line)) autopilot = true;
    const rebuilt = line.match(/rebuild\(\) complete: (\d+) rules parsed/);
    if (rebuilt) ruleCount = Number(rebuilt[1]);
    const m = line.match(/\[PolicySession\] Persisted allow rule for (\S+) matching '([^']+)' at scope=(\w+)/);
    if (m) {
      rules.push({ pattern: m[2]!, scope: m[3]!, by_click: pendingClick, ts, rule_count: ruleCount });
      pendingClick = false;
    }
  }
  return { rules, governance, autopilot };
}

function parseKiroTs(line: string): number | null {
  const m = line.match(/\[?(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)/);
  if (m) {
    const t = Date.parse(m[1]!.replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** A minimal permissions.yaml reader: capability/effect/match triplets. */
export function parseKiroPermissionsYaml(text: string): { capability: string; effect: string; match: string[] }[] {
  const out: { capability: string; effect: string; match: string[] }[] = [];
  let cur: { capability: string; effect: string; match: string[] } | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const cap = line.match(/^capability:\s*(\S+)/);
    if (cap) { cur = { capability: cap[1]!, effect: '', match: [] }; out.push(cur); continue; }
    const eff = line.match(/^effect:\s*(\S+)/);
    if (eff && cur) { cur.effect = eff[1]!; continue; }
    const mat = line.match(/match:\s*\[?\s*['"]?([^'"\]]+)/);
    if (mat && cur) { cur.match.push(mat[1]!.trim()); continue; }
    const matItem = line.match(/^-\s*['"]?([^'"]+)/);
    if (matItem && cur && cur.match.length) { cur.match.push(matItem[1]!.trim()); }
  }
  return out.filter((r) => r.capability && r.effect);
}

export function sweepKiro(db: DB, now: number): { rules: number; governance: boolean } {
  const kiroHome = join(home(), '.kiro');
  if (!existsSync(kiroHome)) return { rules: 0, governance: false };
  const upsert = db.prepare(`
    INSERT INTO grants (grant_key, agent, source_file, kind, entry, granted_by, path_class, origin, scope, entry_class, first_seen, last_seen)
    VALUES (?, 'kiro', ?, 'allow', ?, ?, 'user', ?, ?, ?, ?, ?)
    ON CONFLICT(grant_key) DO UPDATE SET last_seen = excluded.last_seen`);
  let rules = 0;
  let governance: Record<string, unknown> | null = null;
  let autopilot = false;
  // The click evidence: every kiro.log, newest-stamp dir last so first_seen survives.
  const logsDir = join(kiroHome, 'logs');
  const stamps = tryReaddir(logsDir);
  if (stamps.ok) {
    for (const stamp of stamps.entries.sort()) {
      const log = join(logsDir, stamp, 'kiro.log');
      if (!existsSync(log)) continue;
      let mtime = now;
      try { mtime = statSync(log).mtimeMs; } catch { /* keep now */ }
      try {
        const parsed = parseKiroLog(readFileSync(log, 'utf8'), mtime);
        governance ??= parsed.governance;
        autopilot ||= parsed.autopilot;
        for (const r of parsed.rules) {
          upsert.run(
            `kiro:${sha(`${r.scope}:${r.pattern}`)}`, log,
            `capability: shell, match: [${r.pattern}]`,
            r.by_click ? 'click:always-accept' : 'file:permissions.yaml',
            r.by_click ? 'click' : 'file_edit', r.scope, classifyGrantEntry(r.pattern),
            r.ts ?? now, now,
          );
          rules++;
          // Per-log counters (MAX): re-reading the same stamp dir is a no-op.
          if (r.by_click) bumpCounter(db, `kiro:policy_session:${stamp}`, 'click_widened_rules', 1, now);
        }
      } catch { /* unreadable log */ }
    }
  }
  // The still-on-disk results: settings + workspace-root permissions.yaml.
  const yamls = [join(kiroHome, 'settings', 'permissions.yaml')];
  const wr = join(kiroHome, 'workspace-roots');
  const wrd = tryReaddir(wr);
  if (wrd.ok) for (const h of wrd.entries) yamls.push(join(wr, h, 'permissions.yaml'));
  for (const y of yamls) {
    if (!existsSync(y)) continue;
    try {
      for (const r of parseKiroPermissionsYaml(readFileSync(y, 'utf8'))) {
        for (const m of r.match) {
          upsert.run(`kiro_yaml:${sha(`${y}:${r.capability}:${m}`)}`, y,
            `capability: ${r.capability}, effect: ${r.effect}, match: [${m}]`,
            'file:permissions.yaml', 'file_edit', 'user', classifyGrantEntry(m), now, now);
          rules++;
        }
      }
    } catch { /* unreadable yaml */ }
  }
  // Admin-says vs device-did pairs, with the resolved_at that makes staleness visible.
  if (governance) {
    for (const [k, v] of Object.entries(governance)) {
      upsertLever(db, 'kiro', `governance:${k}`, String(v), null, join(kiroHome, 'logs'), now);
    }
    if (autopilot && governance.autonomousAgentsDisabled === true) {
      upsertLever(db, 'kiro', 'governance:autonomousAgentsDisabled', 'admin: true | device: Autopilot ran', null, join(kiroHome, 'logs'), now);
    }
  }
  return { rules, governance: !!governance };
}

// ── Xcode's bundled Claude Code: skip-permissions by default ──────────────────

export function xcodeSkipPermissions(): boolean | null {
  try {
    const r = spawnSync('defaults', ['read', 'com.apple.dt.Xcode', 'IDEChatAgenticChatSkipPermissions'], { encoding: 'utf8', timeout: 4000 });
    if (r.status !== 0) return null; // 'does not exist' — NULL, never false: Xcode's own default may differ from an unset key
    const out = (r.stdout ?? '').trim();
    if (out === '1' || out === 'true' || out === 'YES') return true;
    if (out === '0' || out === 'false' || out === 'NO') return false;
    return null;
  } catch {
    return null;
  }
}

export function sweepXcodePosture(db: DB, now: number): boolean | null {
  const skip = xcodeSkipPermissions();
  if (skip === null) return null;
  const plist = join(home(), 'Library', 'Preferences', 'com.apple.dt.Xcode.plist');
  const sessions = (() => {
    // A cheap existence count of the CodingAssistant home; content is not read here.
    const d = join(home(), 'Library', 'Developer', 'Xcode', 'CodingAssistant', 'ClaudeAgentConfig', 'projects');
    try { return readdirSync(d, { recursive: true }).length; } catch { return null; }
  })();
  upsertLever(db, 'claude_code', 'xcode:IDEChatAgenticChatSkipPermissions', String(skip), 'false', plist, now);
  if (!skip) return skip;
  db.prepare(`
    INSERT INTO grants (grant_key, agent, source_file, kind, entry, granted_by, path_class, origin, scope, first_seen, last_seen)
    VALUES (?, 'claude_code', ?, 'allow', ?, 'xcode_default:IDEChatAgenticChatSkipPermissions', 'unknown', 'xcode_default', 'home', ?, ?)
    ON CONFLICT(grant_key) DO UPDATE SET last_seen = excluded.last_seen`)
    .run('grant:xcode_default:IDEChatAgenticChatSkipPermissions', plist,
      'IDEChatAgenticChatSkipPermissions = true (Xcode default)', now, now);
  insertAnomalies(db, [{
    anomaly_key: 'xcode_skip_permissions:com.apple.dt.Xcode',
    rule: 'unattended_full_access',
    severity: 'info',
    tool: 'claude_code' as never,
    session_id: null,
    model: null,
    window_start: now,
    window_end: now,
    title: 'Xcode bundled Claude Code runs with permissions skipped by default',
    detail:
      `IDEChatAgenticChatSkipPermissions is set, so Xcode's embedded Claude Code launches with ` +
      `--dangerously-skip-permissions — an autonomy grant no human ever clicked` +
      (sessions !== null ? `, covering a ClaudeAgentConfig home of ${sessions} entries` : '') +
      `. NULL would mean the key is absent and Xcode's own default is unknown; here it is explicitly on.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact',
    source: 'live',
    detected_at: now,
  }]);
  return skip;
}

// ── Workspace-trust transitions and the untrusted-execution rule ──────────────

export function sweepWorkspaceTrust(db: DB, state: PostureState, now: number): { untrusted: number; flips: number; incidents: number } {
  const cj = readJson(join(home(), '.claude.json')) as {
    projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
  } | undefined;
  state.workspaceTrust ??= {};
  let untrusted = 0;
  let flips = 0;
  let incidents = 0;
  for (const [cwd, proj] of Object.entries(cj?.projects ?? {})) {
    const trusted = typeof proj.hasTrustDialogAccepted === 'boolean' ? proj.hasTrustDialogAccepted : null;
    const prev = state.workspaceTrust[cwd];
    if (prev && prev.trusted !== trusted) flips++;
    state.workspaceTrust[cwd] = {
      trusted,
      first_seen: prev?.first_seen ?? now,
      last_seen: now,
    };
    if (trusted !== false) continue;
    untrusted++;
    // Activity in the untrusted workspace: usage_events whose project is the cwd.
    const activity = db.prepare(
      "SELECT COUNT(*) AS n FROM usage_events WHERE project = ? AND source = 'live'",
    ).get(cwd) as { n: number };
    if (!activity.n) continue;
    incidents++;
    // A flip inside the fresh-clone window is the critical shape: a .git younger
    // than a day means the clone predates the trust decision by minutes.
    let freshClone = false;
    try {
      freshClone = Date.now() - statSync(join(cwd, '.git')).birthtimeMs < 24 * 3600_000;
    } catch { /* no .git: not a clone shape */ }
    insertAnomalies(db, [{
      anomaly_key: `untrusted_exec:${sha(cwd).slice(0, 16)}`,
      rule: 'untrusted_execution',
      severity: freshClone ? 'critical' : 'warn',
      tool: 'claude_code' as never,
      session_id: null,
      model: null,
      window_start: now,
      window_end: now,
      title: `Agent executed in untrusted workspace ${cwd.replace(home(), '~')}`,
      detail:
        `~/.claude.json records hasTrustDialogAccepted=false for this directory, yet ${activity.n} live ` +
        `usage event(s) were collected under it. The trust key differing between two polls is the ` +
        `transition Vole can see; a flip and flip-back inside one poll interval is invisible` +
        (freshClone ? '. The clone is under 24h old — the fresh-clone shape.' : '.'),
      observed: activity.n,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    }]);
  }
  return { untrusted, flips, incidents };
}

// ── Cross-agent credential and base-URL injection ─────────────────────────────

export interface InjectionCell {
  setBy: string;        // the agent whose config injects
  affects: string;       // the agent the variable steers
  varName: string;      // NAME only
  host: string | null;  // parsed host when the value is a URL — never the value
  credentialShaped: boolean;
  sourceFile: string;
}

const CREDENTIAL_SHAPED = /token|key|secret|password|credential/i;

export function affectsAgent(varName: string): string {
  if (/^ANTHROPIC_|^CLAUDE_/.test(varName)) return 'claude_code';
  if (/^OPENAI_|^CODEX_/.test(varName)) return 'codex';
  if (/^GEMINI_|^GOOGLE_/.test(varName)) return 'gemini';
  if (/^GROK_|^XAI_/.test(varName)) return 'grok';
  return 'unknown';
}

export function parseCodexShellEnvironment(text: string): { inherit: string | null; set: Record<string, string> } {
  const doc = parseToml(text);
  const out = { inherit: null as string | null, set: {} as Record<string, string> };
  const top = doc.sections.get('shell_environment_policy');
  if (top) {
    const inh = top.get('inherit');
    if (typeof inh === 'string') out.inherit = inh;
  }
  // ponytail: only the [shell_environment_policy.set] table form is parsed — a
  // TOML inline table (set = { ... }) is not; the doc form is what Codex writes.
  const sub = doc.sections.get('shell_environment_policy.set');
  if (sub) for (const [k, v] of sub) if (typeof v === 'string') out.set[k] = v;
  return out;
}

/** The set-by × affects matrix. Values stay in memory for the scan; only NAMES,
 *  the parsed host and the config path reach the store. */
export function injectionMatrix(): InjectionCell[] {
  const out: InjectionCell[] = [];
  const codexToml = join(home(), '.codex', 'config.toml');
  if (existsSync(codexToml)) {
    try {
      const { set } = parseCodexShellEnvironment(readFileSync(codexToml, 'utf8'));
      for (const [name, value] of Object.entries(set)) {
        out.push({
          setBy: 'codex',
          affects: affectsAgent(name),
          varName: name,
          host: parseHost(value),
          credentialShaped: CREDENTIAL_SHAPED.test(name),
          sourceFile: codexToml,
        });
      }
    } catch { /* malformed */ }
  }
  // Claude's own env block (empty on most machines — still a matrix cell when set).
  for (const file of [join(home(), '.claude', 'settings.json'), join(home(), '.claude', 'settings.local.json')]) {
    const cfg = readJson(file) as { env?: Record<string, string> } | undefined;
    for (const [name, value] of Object.entries(cfg?.env ?? {})) {
      out.push({
        setBy: 'claude_code',
        affects: affectsAgent(name),
        varName: name,
        host: parseHost(value),
        credentialShaped: CREDENTIAL_SHAPED.test(name),
        sourceFile: file,
      });
    }
  }
  return out;
}

export { parseHost } from './shared';

export function sweepInjections(db: DB, now: number): { cells: number; credentialShaped: number } {
  const cells = injectionMatrix();
  let cred = 0;
  for (const c of cells) {
    if (c.credentialShaped) cred++;
    upsertLever(db, c.setBy, `inject:${c.affects}:${c.varName}`,
      c.host ? `set → ${c.host}` : 'set', 'unset', c.sourceFile, now);
  }
  return { cells: cells.length, credentialShaped: cred };
}

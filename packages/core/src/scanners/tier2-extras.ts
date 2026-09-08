import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { paths } from '../paths';
import { Database } from '../sqlite';
import type { DB } from '../db';
import { openDb, insertAnomalies } from '../db';
import type { Scanner } from '../db';
import type { Anomaly } from '../types';
import type { Surface } from './ai-surfaces';
import { probeDir, fdaCanary } from './scan-access';

/**
 * Tier 2 deep-dive evidence: gateway model routes, home redirects (re-detected
 * every pass), dependency trees, site capabilities, the FDA canary's surface row,
 * ghost extensions, and the foreign-root / agent-home-moved detections. All of it
 * is inventory: paths, names, shapes and dates; never content, never values.
 */

/** Reads a launchd plist's raw XML and extracts Label, ProgramArguments, log paths. */
export function readPlist(p: string): { label: string; argv: string[]; logPaths: string[] } | null {
  try {
    const text = readFileSync(p, 'utf8');
    const label = text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? p;
    const argv = [...text.matchAll(/<key>ProgramArguments<\/key>([\s\S]*?)<\/array>/g)]
      .flatMap((m) => [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]!));
    const logPaths = [
      text.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/)?.[1],
      text.match(/<key>StandardErrorPath<\/key>\s*<string>([^<]+)<\/string>/)?.[1],
    ].filter((x): x is string => !!x);
    return { label, argv, logPaths };
  } catch {
    return null;
  }
}

/** model_routes: the local gateway's own alias map, read from its config file. */
function modelRouteSurfaces(db: DB): Surface[] {
  const out: Surface[] = [];
  for (const dir of [join(homedir(), 'Library/LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons']) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.plist')) continue;
      const plist = readPlist(join(dir, f));
      if (!plist) continue;
      // Find a --config <path> argument, or any .yaml/.yml/.json argument.
      const cfg = plist.argv.find((a) => /\.(ya?ml|json)$/i.test(a));
      if (!cfg || !existsSync(cfg)) continue;
      try {
        const text = readFileSync(cfg, 'utf8');
        // LiteLLM-style: model_name → litellm_params.model. Count the aliases.
        const aliases = [...text.matchAll(/model_name\s*:\s*(\S+)/g)].map((m) => m[1]!);
        if (!aliases.length) continue;
        out.push({
          surface_key: `model_routes:${f.replace(/\.plist$/, '')}`,
          kind: 'gateway',
          name: `${f.replace(/\.plist$/, '')} routes`,
          path: cfg,
          evidence: `${aliases.length} model alias(es) in ${cfg.replace(homedir(), '~')}: ${aliases.slice(0, 6).join(', ')}${aliases.length > 6 ? '…' : ''}`,
          extra: JSON.stringify({ aliases: aliases.slice(0, 20) }),
        });
      } catch {
        /* unreadable config: skip */
      }
    }
  }
  void db;
  return out;
}

/**
 * Agent-home redirects, re-detected EVERY pass (feature 30): the env names are
 * honored through paths.ts (claudeConfigDir/codexHome — owned by the homes batch,
 * consumed here, never re-implemented). A value outside every known agent root is
 * the agent_home_moved signal, checked in agentRootsPass below.
 */
function agentHomeRedirectSurfaces(): Surface[] {
  const out: Surface[] = [];
  const checks: [envVar: string, tool: string, actual: () => string, def: () => string][] = [
    ['CLAUDE_CONFIG_DIR', 'Claude Code', () => paths.claudeConfigDir(), () => join(homedir(), '.claude')],
    ['CODEX_HOME', 'Codex', () => paths.codexHome(), () => join(homedir(), '.codex')],
    ['GEMINI_HOME', 'Gemini CLI', () => paths.geminiHome(), () => join(homedir(), '.gemini')],
  ];
  for (const [envVar, tool, actual, def] of checks) {
    const v = actual();
    if (!process.env[envVar] || v === def()) continue;
    out.push({
      surface_key: `agent-home:${envVar.toLowerCase()}`,
      kind: 'gateway',
      name: `${tool} home redirect`,
      path: v,
      evidence: `${envVar}=${v} — the agent's real home is NOT the default ${def().replace(homedir(), '~')}; collectors follow it every pass`,
      extra: JSON.stringify({ envVar, value: v }),
    });
  }
  return out;
}

/** ai_dependencies: installed AI SDKs in the global trees (npm -g, pipx), not declared manifests. */
function aiDependencySurfaces(): Surface[] {
  const out: Surface[] = [];
  const AI_DEP = /^(ai|gpt|llm|anthropic|openai|claude|gemini|copilot|ollama|llama|mistral|groq|cohere|langchain|llamaindex|litellm)/i;
  let pkgs: { name: string; version: string }[] = [];
  try {
    const raw = execFileSync('npm', ['ls', '-g', '--depth=0', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000,
    });
    const deps = (JSON.parse(raw).dependencies ?? {}) as Record<string, { version?: string }>;
    pkgs = Object.entries(deps).map(([name, d]) => ({ name, version: d.version ?? '?' }));
  } catch {
    /* npm unavailable: the pipx leg may still run */
  }
  const aiPkgs = pkgs.filter((p) => AI_DEP.test(p.name));
  if (aiPkgs.length) {
    out.push({
      surface_key: 'deps:npm-global',
      kind: 'dependency',
      name: 'npm global AI packages',
      path: null,
      evidence: `${aiPkgs.length} AI package(s) installed globally: ${aiPkgs.slice(0, 6).map((p) => `${p.name}@${p.version}`).join(', ')}${aiPkgs.length > 6 ? '…' : ''} — the installed tree, not the manifest`,
      extra: JSON.stringify({ manager: 'npm', packages: aiPkgs }),
    });
  }
  return out;
}

/** site_capabilities: what an AI web extension was allowed to touch, from its manifest. */
function siteCapabilitySurfaces(): Surface[] {
  const out: Surface[] = [];
  const p = join(homedir(), 'Library/Application Support/Google/Chrome/Default/Secure Preferences');
  if (!existsSync(p)) return out;
  try {
    const prefs = JSON.parse(readFileSync(p, 'utf8')) as {
      extensions?: { settings?: Record<string, { manifest?: { name?: string; permissions?: string[]; host_permissions?: string[] } }> };
    };
    for (const [id, ext] of Object.entries(prefs.extensions?.settings ?? {})) {
      const name = ext.manifest?.name;
      if (!name || name.startsWith('__MSG_')) continue;
      const hosts = ext.manifest?.host_permissions ?? [];
      const aiHosts = hosts.filter((h) => /chatgpt|claude|gemini|perplexity|grok|poe|openai|anthropic/i.test(h));
      if (!aiHosts.length) continue;
      out.push({
        surface_key: `site-cap:${id}`,
        kind: 'extension',
        name: `${name} — AI site access`,
        path: null,
        evidence: `extension ${id} holds host permission for ${aiHosts.join(', ')} — permission, never proof of use`,
        extra: JSON.stringify({ id, aiHosts }),
      });
    }
  } catch {
    /* malformed prefs: skip */
  }
  return out;
}

/**
 * The launch context + FDA canary's surface row (feature 11): the probe itself
 * lives in scan-access.ts so the outcome lands in scan_access under root
 * 'tcc_canary'; this row is the human-readable surface that cites it.
 */
function launchContextSurfaces(): Surface[] {
  const canary = fdaCanary();
  return [{
    surface_key: 'launch-context:fda',
    kind: 'context',
    name: 'Full Disk Access',
    path: join(homedir(), 'Library/Application Support/com.apple.TCC/TCC.db'),
    evidence: canary.state === 'ok'
      ? 'this process CAN open the TCC database — Full Disk Access is granted; collection runs with deep reach'
      : canary.state === 'unreadable'
        ? `this process CANNOT open the TCC database (${canary.errno}) — Full Disk Access is NOT granted; sources behind TCC will read as absent, which is a permission fact, not an absence fact`
        : 'the TCC database canary could not be probed — launch context unknown',
  }];
}

/** Ghost extensions: the editor's state remembers extensions that are gone from disk. */
function ghostExtensionSurfaces(): Surface[] {
  const out: Surface[] = [];
  const home = homedir();
  const installed = new Set(
    (() => {
      try {
        return (JSON.parse(readFileSync(join(home, '.vscode/extensions/extensions.json'), 'utf8')) as {
          identifier?: { id?: string };
        }[]).map((e) => e.identifier?.id?.toLowerCase());
      } catch {
        return [];
      }
    })().filter((x): x is string => !!x),
  );
  // The state.vscdb remembers extensions by key prefix even after removal.
  const remembered = new Set<string>();
  try {
    const vscdbPath = join(home, 'Library/Application Support/Code/User/globalStorage/state.vscdb');
    if (existsSync(vscdbPath)) {
      const vscdb = new Database(vscdbPath, { readonly: true, fileMustExist: true });
      for (const { key } of vscdb.prepare('SELECT key FROM ItemTable').all() as { key: string }[]) {
        const m = key.match(/^([a-z0-9-]+\.[a-z0-9-]+)\//i);
        if (m) remembered.add(m[1]!.toLowerCase());
      }
      vscdb.close();
    }
  } catch {
    /* unreadable state: skip */
  }
  const AI_HINT = /(?:^|[^a-z])(ai|gpt|claude|gemini|copilot|llm|cline|kilo|continue|aider|chat)(?:[^a-z]|$)/i;
  for (const id of remembered) {
    if (installed.has(id) || !AI_HINT.test(id)) continue;
    out.push({
      surface_key: `ghost-ext:vscode:${id}`,
      kind: 'ghost_ext',
      name: `${id} (removed)`,
      path: null,
      evidence: `the editor's state remembers ${id}, but it is not in the installed extensions list — it ran here once and was removed`,
    });
  }
  return out;
}

/** VS Code exact model usage: the languageModelStats the editor itself counts. */
function languageModelStats(db: DB): { model: string; tokens: number }[] {
  const home = homedir();
  const vscdbPath = join(home, 'Library/Application Support/Code/User/globalStorage/state.vscdb');
  if (!existsSync(vscdbPath)) return [];
  try {
    const vscdb = new Database(vscdbPath, { readonly: true, fileMustExist: true });
    const rows = vscdb
      .prepare("SELECT value FROM ItemTable WHERE key LIKE '%languageModelStats%' LIMIT 20")
      .all() as { value: string; key?: string }[];
    vscdb.close();
    const out: { model: string; tokens: number }[] = [];
    for (const r of rows) {
      try {
        const stats = JSON.parse(r.value) as Record<string, { tokenCount?: number; count?: number }>;
        for (const [model, s] of Object.entries(stats)) {
          if (s?.tokenCount) out.push({ model, tokens: s.tokenCount });
        }
      } catch {
        /* not the stats shape */
      }
    }
    void db;
    return out;
  } catch {
    return [];
  }
}

// ── agent_roots: the census re-run every pass (feature 30) ──────────────────────

/** Known agent roots BEFORE this pass rewrites them — the baseline for "moved". */
function knownAgentRoots(db: DB): { root_path: string; tool: string; discovered_by: string | null }[] {
  return db
    .prepare('SELECT root_path, tool, discovered_by FROM agent_roots')
    .all() as { root_path: string; tool: string; discovered_by: string | null }[];
}

/**
 * Environment of a same-uid agent process, read straight from ps -E: no hook, no
 * injection, and only at the instant of the pass. Returns env var name→value
 * pairs for the allowlisted redirect names, from any live claude/codex process.
 */
export function agentEnvironmentsFromPs(): { pid: number; env: Record<string, string> }[] {
  const WATCH = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'ANTHROPIC_BASE_URL'];
  let out: string;
  try {
    out = execFileSync('ps', ['-E', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return []; // ps unavailable or refused: no processes readable, an unknown
  }
  const found: { pid: number; env: Record<string, string> }[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidS, rest] = m;
    if (!/\b(claude|codex)\b/i.test(rest)) continue;
    const env: Record<string, string> = {};
    for (const name of WATCH) {
      const em = rest.match(new RegExp(`${name}=([^\\s]+)`));
      if (em) env[name] = em[1]!;
    }
    if (Object.keys(env).length) found.push({ pid: Number(pidS), env });
  }
  return found;
}

/** Upsert the agent-home census; discovered_by is a stored fact, never re-derived over an old one. */
export function upsertAgentRoots(db: DB, now: number): { root: string; tool: string; discoveredBy: string }[] {
  const home = homedir();
  const candidates: { root: string; tool: string; discoveredBy: string }[] = [
    { root: paths.claudeConfigDir(), tool: 'Claude Code', discoveredBy: process.env.CLAUDE_CONFIG_DIR ? 'env:CLAUDE_CONFIG_DIR' : 'default' },
    { root: paths.codexHome(), tool: 'Codex', discoveredBy: process.env.CODEX_HOME ? 'env:CODEX_HOME' : 'default' },
  ];
  for (const { pid, env } of agentEnvironmentsFromPs()) {
    for (const [name, value] of Object.entries(env)) {
      if (!value.startsWith('/')) continue; // relative or flag values are not roots
      candidates.push({ root: value, tool: /CLAUDE/i.test(name) ? 'Claude Code' : 'Codex', discoveredBy: `ps:${pid}:${name}` });
    }
  }
  const upsert = db.prepare(`
    INSERT INTO agent_roots (root_path, tool, discovered_by, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(root_path) DO UPDATE SET last_seen = excluded.last_seen`);
  const seen = new Map<string, { root: string; tool: string; discoveredBy: string }>();
  for (const c of candidates) {
    if (c.root === home || !c.root) continue; // the home dir itself is not an agent root
    upsert.run(c.root, c.tool, c.discoveredBy, now, now);
    if (!seen.has(c.root)) seen.set(c.root, c);
  }
  return [...seen.values()];
}

/** Does any known agent root hold this session's transcript? */
function transcriptUnderAnyRoot(sessionId: string, roots: string[]): boolean {
  for (const root of roots) {
    const projects = join(root, 'projects');
    let slugs: string[];
    try {
      slugs = readdirSync(projects);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      if (existsSync(join(projects, slug, `${sessionId}.jsonl`))) return true;
    }
  }
  return false;
}

/**
 * agent_home_moved: two exact signals. (a) a live session id from
 * ~/.claude/sessions/<pid>.json whose transcript exists under NO known root;
 * (b) a ps-read env name resolving to a path outside every root known BEFORE
 * this pass registered it. Both keys are deterministic — no now().
 */
export function agentHomeMovedCheck(db: DB, now: number): number {
  const priorRoots = knownAgentRoots(db).map((r) => r.root_path);
  const anomalies: Anomaly[] = [];

  // (b) env redirects outside every previously-known root.
  for (const { pid, env } of agentEnvironmentsFromPs()) {
    for (const [name, value] of Object.entries(env)) {
      if (!value.startsWith('/') || priorRoots.includes(value)) continue;
      anomalies.push({
        anomaly_key: `agent_home_moved:env:${name}:${value}`,
        rule: 'agent_home_moved',
        severity: 'warn',
        tool: 'claude_code',
        session_id: null,
        model: null,
        window_start: now,
        window_end: now,
        title: `Agent home redirect: ${name}`,
        detail:
          `a live agent process (pid ${pid}, read via ps -E) runs with ${name}=${value}, a path outside every known agent root. ` +
          `Collectors now follow it; sessions under the old root will read as absent.`,
        observed: 1,
        baseline: null,
        threshold: null,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      });
    }
  }

  // (a) live session ids whose transcripts live under no known root.
  const sessionFiles = join(paths.claudeConfigDir(), 'sessions');
  let files: string[];
  try {
    files = readdirSync(sessionFiles);
  } catch {
    files = [];
  }
  const allRoots = [...new Set([...priorRoots, paths.claudeConfigDir(), paths.codexHome()])];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let session: { pid?: number; sessionId?: string };
    try {
      session = JSON.parse(readFileSync(join(sessionFiles, f), 'utf8')) as { pid?: number; sessionId?: string };
    } catch {
      continue;
    }
    if (!session.sessionId) continue;
    let alive = false;
    try {
      if (typeof session.pid === 'number') process.kill(session.pid, 0);
      alive = true;
    } catch {
      alive = false; // pid dead: an orphan-session trace cannot say where it went
    }
    if (!alive) continue;
    if (transcriptUnderAnyRoot(session.sessionId, allRoots)) continue;
    anomalies.push({
      anomaly_key: `agent_home_moved:session:${session.sessionId}`,
      rule: 'agent_home_moved',
      severity: 'warn',
      tool: 'claude_code',
      session_id: session.sessionId,
      model: null,
      window_start: now,
      window_end: now,
      title: 'Live session under no known agent root',
      detail:
        `session ${session.sessionId} (pid ${session.pid}) is live, but its transcript exists under no known agent root ` +
        `(${allRoots.length} root(s) checked). Its home was moved or redirected somewhere this pass cannot enumerate.`,
      observed: 1,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  if (anomalies.length) insertAnomalies(db, anomalies);
  return anomalies.length;
}

// ── foreign_root_transcript (feature 28) ───────────────────────────────────────

/**
 * A recorded working directory this filesystem cannot have. Routed through the
 * four-state probe, NOT existsSync: a TCC-denied directory exists — calling it
 * "foreign" would turn a permission fact into a wrong claim. Joined against
 * agent_roots: the detail states how many known roots were checked against.
 */
export function foreignRootCheck(db: DB, now: number): number {
  const rows = db
    .prepare(
      "SELECT DISTINCT project FROM usage_events WHERE project IS NOT NULL AND source = 'live' LIMIT 500",
    )
    .all() as { project: string }[];
  const knownRoots = knownAgentRoots(db);
  let foreign = 0;
  const anomalies: Anomaly[] = [];
  for (const { project } of rows) {
    const probe = probeDir(project);
    if (probe.state !== 'absent') continue; // ok / unreadable / exists: this volume may hold it
    foreign++;
    anomalies.push({
      anomaly_key: `foreign_root:${project}`,
      rule: 'foreign_root_transcript',
      severity: 'info',
      tool: 'claude_code',
      session_id: null,
      model: null,
      window_start: now,
      window_end: now,
      title: `Foreign root: ${project}`,
      detail:
        `usage was recorded with cwd ${project}, which does not exist on this filesystem — the transcript came from ` +
        `another machine, a container, or the directory was removed. ${knownRoots.length} known agent root(s) checked; none matches. ` +
        `A foreign root proves the run's filesystem, never the machine or the container it ran on.`,
      observed: 1,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  if (anomalies.length) insertAnomalies(db, anomalies);
  return foreign;
}

export const tier2ExtrasScanner: Scanner = {
  name: 'tier2-extras',
  cadenceMs: 5 * 60_000,
  run: () => {
    const db: DB = openDb();
    const now = Date.now();
    const surfaces = [
      ...modelRouteSurfaces(db),
      ...agentHomeRedirectSurfaces(),
      ...aiDependencySurfaces(),
      ...siteCapabilitySurfaces(),
      ...launchContextSurfaces(),
      ...ghostExtensionSurfaces(),
    ];
    const upsert = db.prepare(`
      INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(surface_key) DO UPDATE SET
        last_seen = excluded.last_seen, evidence = excluded.evidence, extra = excluded.extra`);
    for (const s of surfaces) {
      upsert.run(s.surface_key, s.kind, s.name, s.path, s.evidence, s.version ?? null, s.extra ?? null, now, now);
    }
    const roots = upsertAgentRoots(db, now);
    const moved = agentHomeMovedCheck(db, now);
    const foreign = foreignRootCheck(db, now);
    const lm = languageModelStats(db);
    db.prepare(
      `INSERT INTO column_provenance (table_name, column_name, migration_version, first_populated_ts, unbackfillable_rows)
       VALUES (?, 'discovered_by', 20, ?, 0)
       ON CONFLICT(table_name, column_name) DO UPDATE SET unbackfillable_rows = excluded.unbackfillable_rows`,
    ).run('agent_roots', now);
    return {
      ok: true,
      notes:
        `${surfaces.length} deep-dive surfaces · ${roots.length} agent root(s)` +
        (moved ? ` · ${moved} agent-home MOVED signal(s)` : '') +
        (foreign ? ` · ${foreign} foreign root(s)` : '') +
        (lm.length ? ` · editor-counted models: ${lm.length}` : ''),
    };
  },
};

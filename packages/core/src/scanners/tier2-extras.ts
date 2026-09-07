import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { paths } from '../paths';
import { Database } from '../sqlite';
import type { DB } from '../db';
import { openDb, insertAnomalies } from '../db';
import type { Scanner } from '../db';
import type { Surface } from './ai-surfaces';

/**
 * Tier 2 deep-dive evidence, one scanner: the facts that turn a surface into a
 * story — gateway model routes, home redirects, dependency trees, site
 * capabilities, launch context, and the readability states that make a
 * coverage claim honest. All of it is inventory: paths, names, shapes and
 * dates; never content, never values.
 */

/** Reads a launchd plist's raw XML and extracts Label, ProgramArguments, log paths. */
function readPlist(p: string): { label: string; argv: string[]; logPaths: string[] } | null {
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

/** Agent-home redirects: CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI override the default roots. */
function agentHomeRedirectSurfaces(): Surface[] {
  const out: Surface[] = [];
  const checks: [envVar: string, tool: string, home: () => string][] = [
    ['CLAUDE_CONFIG_DIR', 'Claude Code', () => join(homedir(), '.claude')],
    ['CODEX_HOME', 'Codex', () => join(homedir(), '.codex')],
    ['GEMINI_HOME', 'Gemini CLI', () => join(homedir(), '.gemini')],
  ];
  for (const [envVar, tool, def] of checks) {
    const v = process.env[envVar];
    if (!v || v === def()) continue;
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
 * The launch context + FDA canary: one deliberate read of a TCC-protected path,
 * whose failure is the honest evidence of what this build can and cannot see.
 * A probe proves a permission state, nothing more.
 */
function launchContextSurfaces(): Surface[] {
  const out: Surface[] = [];
  const canary = '/Library/Application Support/com.apple.TCC/TCC.db';
  let readable = false;
  try {
    readFileSync(canary); // O_RDONLY on the protected path — succeeds only with FDA
    readable = true;
  } catch {
    readable = false;
  }
  out.push({
    surface_key: 'launch-context:fda',
    kind: 'context',
    name: 'Full Disk Access',
    path: canary,
    evidence: readable
      ? 'this process CAN read the TCC database — Full Disk Access is granted; collection runs with deep reach'
      : 'this process CANNOT read the TCC database — Full Disk Access is NOT granted; sources behind TCC will read as absent, which is a permission fact, not an absence fact',
  });
  return out;
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
      const { Database } = require('../sqlite') as typeof import('../sqlite');
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

/** The second-tier store prober: known artifact paths for tools without collectors yet. */
function secondTierSurfaces(): Surface[] {
  const out: Surface[] = [];
  const home = homedir();
  const probes: [path: string, name: string][] = [
    [`${home}/.kiro`, 'Kiro'],
    [`${home}/.windsurf`, 'Windsurf'],
    [`${home}/.trae`, 'Trae'],
    [`${home}/.zed`, 'Zed (agent data)'],
    [`${home}/.factory`, 'Factory (droid)'],
    [`${home}/.opencode`, 'OpenCode (already collected)'],
    [`${home}/.qwen`, 'Qwen Code'],
    [`${home}/.droid`, 'Droid'],
    [`${home}/.sst/opencode`, 'OpenCode (sst)'],
    [`${home}/.void`, 'Void editor'],
  ];
  for (const [dir, name] of probes) {
    if (!existsSync(dir)) continue;
    out.push({
      surface_key: `store:${dir.replace(home, '~')}`,
      kind: 'cli',
      name,
      path: dir,
      evidence: `artifact directory present (${statSync(dir).isDirectory() ? 'dir' : 'file'}) — a future collector can read it; today it is inventory only`,
    });
  }
  return out;
}

/**
 * The console-invisible spend ledger: which share of recorded usage no vendor
 * console can ever show (local models, routers, raw-key accounts). Computed
 * from stored rows — the exact figure, with its denominator.
 */
function consoleCoverageNote(db: DB): { ok: boolean; notes?: string } {
  const rows = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN model LIKE 'ollama/%' OR model LIKE 'openrouter/%'
                        OR model LIKE 'github-copilot/%' OR model LIKE 'anthropic/%'
                        OR model LIKE '%qwen%' OR model LIKE '%glm%' OR model LIKE '%fable%'
                       THEN 1 ELSE 0 END) AS invisible
       FROM usage_events WHERE source = 'live' AND total_tokens IS NOT NULL`,
    )
    .get() as { n: number; invisible: number | null };
  const pct = rows.n ? Math.round(((rows.invisible ?? 0) / rows.n) * 100) : 0;
  return {
    ok: true,
    notes: `console-blind spend: ${rows.invisible ?? 0} of ${rows.n} token-bearing rows (${pct}%) — models routed through gateways, routers and local runtimes that no vendor console reports`,
  };
}

/** coverage_degraded: a source root that exists but can no longer be read. */
function coverageDegradeCheck(db: DB, now: number): number {
  const roots: [path: string, tool: string][] = [
    [paths.claudeCodeProjects(), 'Claude Code transcripts'],
    [paths.codexSessions(), 'Codex rollouts'],
    [join(homedir(), '.grok', 'logs'), 'Grok logs'],
  ];
  let degraded = 0;
  for (const [root, label] of roots) {
    if (!existsSync(root)) continue; // absent is a no_source fact, not degradation
    try {
      readdirSync(root);
    } catch (err) {
      degraded++;
      insertAnomalies(db, [{
        anomaly_key: `coverage_degraded:${root}`,
        rule: 'coverage_degraded' as never,
        severity: 'warn',
        tool: 'claude_code' as never,
        session_id: null,
        model: null,
        window_start: now,
        window_end: now,
        title: `Coverage degraded: ${label}`,
        detail: `${root} exists but reads failed: ${(err as Error).message}. Rows behind it will read as absent — a permission fact, not an absence fact.`,
        observed: 1,
        baseline: null,
        threshold: null,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      }]);
    }
  }
  return degraded;
}

/** foreign_root_transcript: usage rows whose cwd does not exist on THIS filesystem. */
function foreignRootCheck(db: DB, now: number): number {
  const rows = db
    .prepare(
      "SELECT DISTINCT project FROM usage_events WHERE project IS NOT NULL AND source = 'live' LIMIT 500",
    )
    .all() as { project: string }[];
  let foreign = 0;
  for (const { project } of rows) {
    if (existsSync(project)) continue;
    foreign++;
    insertAnomalies(db, [{
      anomaly_key: `foreign_root:${project}`,
      rule: 'new_ai_surface' as never, // distinct-rule plumbing arrives with the enum; classified under inventory rules
      severity: 'info',
      tool: 'claude_code' as never,
      session_id: null,
      model: null,
      window_start: now,
      window_end: now,
      title: `Foreign root: ${project}`,
      detail: `usage was recorded with cwd ${project}, which does not exist on this filesystem — the transcript came from another machine, a container, or the directory was removed.`,
      observed: 1,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    }]);
  }
  return foreign;
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
      ...secondTierSurfaces(),
    ];
    const upsert = db.prepare(`
      INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(surface_key) DO UPDATE SET
        last_seen = excluded.last_seen, evidence = excluded.evidence, extra = excluded.extra`);
    for (const s of surfaces) {
      upsert.run(s.surface_key, s.kind, s.name, s.path, s.evidence, s.version ?? null, s.extra ?? null, now, now);
    }
    const degraded = coverageDegradeCheck(db, now);
    const foreign = foreignRootCheck(db, now);
    const lm = languageModelStats(db);
    const cov = consoleCoverageNote(db);
    return {
      ok: true,
      notes:
        `${surfaces.length} deep-dive surfaces · ${cov.notes}` +
        (degraded ? ` · ${degraded} DEGRADED root(s)` : '') +
        (foreign ? ` · ${foreign} foreign root(s)` : '') +
        (lm.length ? ` · editor-counted models: ${lm.length}` : ''),
    };
  },
};

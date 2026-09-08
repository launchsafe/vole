import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { home, paths } from '../paths';
import { openDb } from '../db';
import type { DB, Scanner } from '../db';

/**
 * model_routes (tier 2 features 4/25): the local gateway's alias map — alias →
 * target model, api_base host and scheme, and the PRESENCE (never the value) of
 * an api_key — read from the config files the gateways themselves name. Plus the
 * rewrite evidence: custom-key labels from ~/.claude.json, dated .ccr-* backups,
 * and shell env names whose value is a hostname.
 *
 * The map is what the config says, not what the proxy did: a running gateway may
 * hold an older config in memory, route by wildcard or fall back per request,
 * and Vole never sees a request. It cannot confirm that a single prompt crossed
 * that host, only that the local configuration would have sent it there.
 */

export interface Route {
  alias: string;
  target_model: string | null;
  api_base: string | null;
  api_key_present: number | null;
  source: string;
}

/** Presence of an api_key, never its value. `os.environ/NAME` resolves against
 *  this process's env — the only local evidence of whether that name is set. */
export function keyPresence(value: string): number {
  const m = value.match(/^os\.environ\/([A-Za-z0-9_]+)$/);
  if (m) return process.env[m[1]!] !== undefined ? 1 : 0;
  return 1; // an inline value exists; we record only that it exists
}

function strip(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/**
 * Minimal LiteLLM YAML reader: model_list[].model_name → litellm_params.{model,
 * api_base, api_key}. Line/indentation based — enough for the config shape
 * LiteLLM itself documents, no YAML dependency.
 */
export function parseLiteLLMYaml(text: string): Route[] {
  const out: Route[] = [];
  let inModelList = false;
  let inParams = false;
  let cur: Route | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inModelList = /^model_list:\s*$/.test(t);
      inParams = false;
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (!inModelList) continue;
    if (t.startsWith('- ')) {
      if (cur) out.push(cur);
      cur = { alias: '', target_model: null, api_base: null, api_key_present: null, source: '' };
      inParams = false;
      const m = t.slice(2).match(/^model_name:\s*(.+)$/);
      if (m) cur.alias = strip(m[1]!);
      continue;
    }
    if (!cur) continue;
    if (/^litellm_params:\s*$/.test(t)) {
      inParams = true;
      continue;
    }
    const kv = t.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, vRaw] = kv;
    const v = vRaw ? strip(vRaw) : '';
    if (!inParams && k === 'model_name' && v) cur.alias = v;
    if (inParams && k === 'model' && v) cur.target_model = v;
    if (inParams && k === 'api_base' && v) cur.api_base = v;
    if (inParams && k === 'api_key' && v) cur.api_key_present = keyPresence(v);
  }
  if (cur) out.push(cur);
  return out.filter((r) => r.alias);
}

interface CCRConfig {
  Providers?: { name?: string; api_base_url?: string; api_key?: string; models?: string[] }[];
  Router?: Record<string, string>;
}

/** Claude Code Router config: Providers[].{name, api_base_url, api_key} + Router alias → "provider,model". */
export function parseCCRConfig(text: string): Route[] {
  let cfg: CCRConfig;
  try {
    cfg = JSON.parse(text) as CCRConfig;
  } catch {
    // CCR configs ship with comments / trailing commas; strip both, retry once.
    try {
      cfg = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')) as CCRConfig;
    } catch {
      return [];
    }
  }
  const providers = new Map<string, { api_base: string | null; key: number }>();
  for (const p of cfg.Providers ?? []) {
    if (!p?.name) continue;
    providers.set(p.name, { api_base: p.api_base_url ?? null, key: p.api_key ? keyPresence(p.api_key) : null });
  }
  const out: Route[] = [];
  for (const [alias, value] of Object.entries(cfg.Router ?? {})) {
    const [provider, model] = value.split(',');
    const p = providers.get(provider ?? '');
    if (!p) continue;
    out.push({
      alias,
      target_model: model ? model.replace(/:\d+k$/, '') : null,
      api_base: p.api_base,
      api_key_present: p.key,
      source: '',
    });
  }
  return out;
}

interface ContinueConfig {
  models?: { title?: string; name?: string; provider?: string; model?: string; apiBase?: string; apiKey?: string }[];
}

/** ~/.continue/config.json models[]: title is the local alias, model/provider the target. */
export function parseContinueConfig(text: string): Route[] {
  let cfg: ContinueConfig;
  try {
    cfg = JSON.parse(text) as ContinueConfig;
  } catch {
    return [];
  }
  return (cfg.models ?? [])
    .filter((m) => m && (m.title || m.name))
    .map((m) => ({
      alias: m.title ?? m.name!,
      target_model: m.model ?? m.provider ?? null,
      api_base: m.apiBase ?? null,
      api_key_present: m.apiKey ? keyPresence(m.apiKey) : null,
      source: '',
    }));
}

/** ~/.aider.conf.yml: no alias map, but the chosen model and base URL are routing facts. */
export function parseAiderConf(text: string): Route[] {
  const model = text.match(/^\s*(?:weak-)?model:\s*(\S+)/m)?.[1];
  if (!model) return [];
  const apiBase = strip(text.match(/^\s*openai-api-base:\s*(.+)$/m)?.[1] ?? '') || null;
  const key = text.match(/^\s*openai-api-key:\s*(\S+)/m)?.[1];
  return [{ alias: model, target_model: model, api_base: apiBase, api_key_present: key ? keyPresence(key) : null, source: '' }];
}

/** The launchd job's own --config <path> (and any yaml/json argument it names). */
export function launchdConfigPaths(): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const dirs = [join(home(), 'Library/LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons'];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.plist')) continue;
      let argv: string[];
      try {
        const text = readFileSync(join(dir, f), 'utf8');
        argv = [...text.matchAll(/<key>ProgramArguments<\/key>([\s\S]*?)<\/array>/g)]
          .flatMap((m) => [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]!));
      } catch {
        continue;
      }
      const i = argv.indexOf('--config');
      const cfg = (i >= 0 ? argv[i + 1] : undefined) ?? argv.find((a) => /\.(ya?ml|json)$/i.test(a));
      if (cfg && existsSync(cfg)) out.push({ path: cfg, source: `launchd:${f.replace(/\.plist$/, '')}` });
    }
  }
  return out;
}

/** Every config file the route map is read from this pass. */
export function routeConfigFiles(): { path: string; kind: 'litellm' | 'ccr' | 'continue' | 'aider'; source: string }[] {
  const out: { path: string; kind: 'litellm' | 'ccr' | 'continue' | 'aider'; source: string }[] = [];
  for (const { path, source } of launchdConfigPaths()) {
    out.push({ path, kind: /\.json$/i.test(path) ? 'ccr' : 'litellm', source });
  }
  const litellmDir = join(home(), '.config', 'litellm');
  try {
    for (const f of readdirSync(litellmDir)) {
      if (/\.(ya?ml)$/i.test(f)) out.push({ path: join(litellmDir, f), kind: 'litellm', source: `litellm:${f}` });
    }
  } catch {
    /* no litellm config dir */
  }
  const ccr = join(home(), '.claude-code-router', 'config.json');
  if (existsSync(ccr)) out.push({ path: ccr, kind: 'ccr', source: 'ccr' });
  const cont = join(home(), '.continue', 'config.json');
  if (existsSync(cont)) out.push({ path: cont, kind: 'continue', source: 'continue' });
  const aider = join(home(), '.aider.conf.yml');
  if (existsSync(aider)) out.push({ path: aider, kind: 'aider', source: 'aider' });
  return out;
}

/** Reads every config and produces the route rows (route_key is stable: source + alias). */
export function collectRoutes(): Route[] {
  const out: Route[] = [];
  for (const cfg of routeConfigFiles()) {
    let text: string;
    try {
      text = readFileSync(cfg.path, 'utf8');
    } catch {
      continue; // unreadable config: no map this pass, never a guess
    }
    let routes: Route[];
    if (cfg.kind === 'litellm') routes = parseLiteLLMYaml(text);
    else if (cfg.kind === 'ccr') routes = parseCCRConfig(text);
    else if (cfg.kind === 'continue') routes = parseContinueConfig(text);
    else routes = parseAiderConf(text);
    for (const r of routes) out.push({ ...r, source: `${cfg.source}:${r.alias}` });
  }
  return out;
}

/** The transport verdict the Route chip's badge renders: plaintext or bare-IP upstreams. */
export function transportClass(api_base: string | null): 'http' | 'bare_ip' | 'https' | null {
  if (!api_base) return null;
  let url: URL;
  try {
    url = new URL(api_base);
  } catch {
    return null;
  }
  if (url.protocol === 'http:') return 'http';
  if (url.protocol === 'https:') {
    return /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ? 'bare_ip' : 'https';
  }
  return null;
}

/** Upsert the alias map. A previously-known api_key_present is never demoted to
 *  unknown (NULL-only widening); the map itself is the current config state. */
export function upsertModelRoutes(db: DB, routes: Route[], now: number): number {
  const stmt = db.prepare(`
    INSERT INTO model_routes (route_key, alias, target_model, api_base, api_key_present, source, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(route_key) DO UPDATE SET
      last_seen = excluded.last_seen,
      target_model = excluded.target_model,
      api_base = excluded.api_base,
      api_key_present = COALESCE(excluded.api_key_present, model_routes.api_key_present),
      source = excluded.source`);
  for (const r of routes) stmt.run(r.source, r.alias, r.target_model, r.api_base, r.api_key_present, r.source, now, now);
  return routes.length;
}

export interface KeyLabel {
  key_name: string;
  verdict: 'approved' | 'rejected';
}

/** ~/.claude.json customApiKeyResponses — the short labels the user was prompted about. */
export function customKeyLabels(claudeJson: string): KeyLabel[] {
  let cfg: { customApiKeyResponses?: { approved?: string[]; rejected?: string[] } };
  try {
    cfg = JSON.parse(claudeJson) as typeof cfg;
  } catch {
    return [];
  }
  const out: KeyLabel[] = [];
  for (const k of cfg.customApiKeyResponses?.approved ?? []) out.push({ key_name: k, verdict: 'approved' });
  for (const k of cfg.customApiKeyResponses?.rejected ?? []) out.push({ key_name: k, verdict: 'rejected' });
  return out;
}

function upsertSurface(
  db: DB,
  s: { surface_key: string; kind: string; name: string; path: string | null; evidence: string; extra?: string | null },
  now: number,
): void {
  db.prepare(`
    INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, extra, scanner, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, 'routes', ?, ?)
    ON CONFLICT(surface_key) DO UPDATE SET
      last_seen = excluded.last_seen, evidence = excluded.evidence, extra = excluded.extra`).run(
    s.surface_key, s.kind, s.name, s.path, s.evidence, s.extra ?? null, now, now,
  );
}

/** .ccr-* config backups in the claude home: a dated timeline of rewrites. */
export function ccrBackupSurfaces(db: DB, now: number): number {
  const dir = paths.claudeConfigDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of entries) {
    if (!/\.ccr-/.test(f)) continue;
    const p = join(dir, f);
    let mtime: number | null = null;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      /* unstatable: still a named backup */
    }
    upsertSurface(db, {
      surface_key: `ccr-backup:${f}`,
      kind: 'gateway',
      name: `Config backup ${f}`,
      path: p,
      evidence: `claude-code-router left a config backup (${mtime !== null ? new Date(mtime).toISOString() : 'mtime unknown'}) — evidence the route config was rewritten, never of what crossed it`,
      extra: JSON.stringify({ mtime }),
    }, now);
    n++;
  }
  return n;
}

function statMtime(p: string): number {
  return statSync(p).mtimeMs;
}

const RC_FILES = ['.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile'];
const ROUTE_ENV_VARS = /^(OPENAI_BASE_URL|OPENAI_API_BASE|ANTHROPIC_BASE_URL|OPENROUTER_BASE_URL|GEMINI_API_BASE|CODEX_API_BASE)$/;

/** Shell rc exports whose value is a URL — the env var NAME and the hostname it points at. */
export function rcRouteSurfaces(db: DB, now: number): number {
  let n = 0;
  for (const f of RC_FILES) {
    let text: string;
    try {
      text = readFileSync(join(home(), f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(["']?)(https?:\/\/[^\s"'#]+)\2/);
      if (!m || !ROUTE_ENV_VARS.test(m[1]!) || /^\s*#/.test(line)) continue;
      let host: string | null = null;
      try {
        host = new URL(m[3]!).hostname;
      } catch {
        host = null;
      }
      upsertSurface(db, {
        surface_key: `env-route:${m[1]}`,
        kind: 'gateway',
        name: `${m[1]} (shell)`,
        path: join(home(), f),
        evidence: `${m[1]} is exported to ${host ?? 'an unparseable URL'} in ${f} — the weakest routing leg: the rc scan misses redirections that live in settings.json or launchd`,
        extra: JSON.stringify({ envVar: m[1], host }),
      }, now);
      n++;
    }
  }
  return n;
}

export const routesScanner: Scanner = {
  name: 'model-routes',
  cadenceMs: 5 * 60_000,
  run: () => {
    const db: DB = openDb();
    const now = Date.now();
    const routes = collectRoutes();
    upsertModelRoutes(db, routes, now);
    let labels = 0;
    const keyStmt = db.prepare(`
      INSERT INTO provider_keys (key_name, source_file, shape, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key_name, source_file) DO UPDATE SET
        last_seen = excluded.last_seen, shape = excluded.shape`);
    // ~/.claude.json lives in the home; under a CLAUDE_CONFIG_DIR redirect it
    // moves inside the redirected home. Read whichever exists.
    const claudeJson = [join(home(), '.claude.json'), join(paths.claudeConfigDir(), '.claude.json')].find((p) => existsSync(p));
    try {
      for (const l of customKeyLabels(readFileSync(claudeJson!, 'utf8'))) {
        keyStmt.run(l.key_name, claudeJson, `custom-api-key-label:${l.verdict}`, now, now);
        labels++;
      }
    } catch {
      /* no ~/.claude.json: no labels this pass */
    }
    const backups = ccrBackupSurfaces(db, now);
    const rcRoutes = rcRouteSurfaces(db, now);
    const plaintext = routes.filter((r) => {
      const c = transportClass(r.api_base);
      return c === 'http' || c === 'bare_ip';
    }).length;
    return {
      ok: true,
      notes:
        `${routes.length} route(s) from ${routeConfigFiles().length} config file(s)` +
        (plaintext ? ` · ${plaintext} plaintext/bare-IP upstream(s)` : '') +
        ` · ${labels} custom-key label(s) · ${backups} .ccr backup(s) · ${rcRoutes} shell env route(s)`,
    };
  },
};

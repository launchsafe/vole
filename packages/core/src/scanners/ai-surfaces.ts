import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import type { DB } from '../db';
import { openDb, insertAnomalies } from '../db';
import { loadSurfacePolicy, isSanctioned, type SurfacePolicy } from '../policy';
import type { Scanner } from '../db';
import type { Anomaly } from '../types';

/**
 * The Shadow AI census, part one: installed AI apps, persistent AI gateways and
 * AI CLIs on PATH — the surfaces nobody provisioned. This is inventory, never
 * usage: a row proves an artifact exists on disk at last_seen, and the Shadow AI
 * screen must never read it as spend (that misreading is what the evidence ladder
 * in the roadmap exists to prevent).
 *
 * Rides the scanner cadence lane: one pass every 5 minutes, never the 5s poll.
 */

export interface SurfaceDepth {
  vendor?: string | null;
  identifier?: string | null;
  state?: string | null;
  scanner?: string | null;
  confidence?: string | null;
  evidence_kind?: string | null;
  discovery?: string | null;
  account_class?: string | null;
  class_evidence?: string | null;
}

export interface Surface {
  surface_key: string;
  kind: 'app' | 'gateway' | 'cli' | 'ghost_app' | 'runtime' | 'os' | 'site' | 'extension' | 'credential' | 'dependency' | 'context' | 'ghost_ext' | 'browser_host' | 'config_dir' | 'store';
  name: string;
  path: string | null;
  evidence: string;
  version?: string | null;
  extra?: string | null;
  /** The foundation depth columns (migration 20/22): NULL-only widening on upsert. */
  depth?: SurfaceDepth;
}

/**
 * The single ai_surfaces writer every census module in this batch shares.
 * Depth columns widen NULL-only — a stored fact is never overwritten by a
 * re-derived one — and first_seen never moves. last_seen is clamped with MAX:
 * some census modules stamp `now` from a file mtime (an artifact older than
 * the wall clock), and an unguarded write would drag last_seen below the
 * already-stored first_seen.
 */
export function upsertSurface(db: DB, s: Surface, now: number): void {
  // The content boundary is enforced at the chokepoint: an `extra` blob over
  // 512 chars (or multiline) never lands verbatim — it degrades to a digest
  // stub so the row stays auditable without carrying content-shaped text.
  const extra =
    s.extra != null && (s.extra.length > 512 || s.extra.includes('\n'))
      ? JSON.stringify({ truncated: true, bytes: s.extra.length, sha256: createHash('sha256').update(s.extra).digest('hex').slice(0, 16) })
      : (s.extra ?? null);
  db.prepare(`
    INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, first_seen, last_seen,
      vendor, identifier, state, scanner, confidence, evidence_kind, discovery, account_class, class_evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(surface_key) DO UPDATE SET
      last_seen = MAX(ai_surfaces.last_seen, excluded.last_seen),
      evidence = excluded.evidence,
      extra = COALESCE(excluded.extra, ai_surfaces.extra),
      version = COALESCE(excluded.version, ai_surfaces.version),
      path = COALESCE(excluded.path, ai_surfaces.path),
      vendor = COALESCE(excluded.vendor, ai_surfaces.vendor),
      identifier = COALESCE(excluded.identifier, ai_surfaces.identifier),
      state = COALESCE(excluded.state, ai_surfaces.state),
      scanner = COALESCE(excluded.scanner, ai_surfaces.scanner),
      confidence = COALESCE(excluded.confidence, ai_surfaces.confidence),
      evidence_kind = COALESCE(excluded.evidence_kind, ai_surfaces.evidence_kind),
      discovery = COALESCE(excluded.discovery, ai_surfaces.discovery),
      account_class = COALESCE(excluded.account_class, ai_surfaces.account_class),
      class_evidence = COALESCE(excluded.class_evidence, ai_surfaces.class_evidence)`)
    .run(s.surface_key, s.kind, s.name, s.path, s.evidence, s.version ?? null, extra, now, now,
      s.depth?.vendor ?? null, s.depth?.identifier ?? null, s.depth?.state ?? null, s.depth?.scanner ?? null,
      s.depth?.confidence ?? null, s.depth?.evidence_kind ?? null, s.depth?.discovery ?? null,
      s.depth?.account_class ?? null, s.depth?.class_evidence ?? null);
}

/** Known AI apps by bundle id prefix or name (catalog, not a guess: no fuzzy matching). */
const AI_APPS: [match: RegExp, name: string][] = [
  [/^com\.anthropic\./i, 'Claude'],
  [/^com\.openai\.chatgpt/i, 'ChatGPT'],
  [/^com\.exafunction\.warp/i, 'Warp'],
  [/^com\.todesktop\.230313\.chatgpt/i, 'ChatGPT Desktop'],
  [/^com\.cursor\.composer/i, 'Cursor'],
  [/^com\.lmstudio\.lm-studio/i, 'LM Studio'],
  [/^jan\.ai/i, 'Jan'],
  [/^dev\.warp\.Warp-Stable/i, 'Warp'],
  [/^com\.zed-industries\.zed/i, 'Zed'],
  [/^com\.jetbrains\./i, 'JetBrains IDE'],
];

/** Gateway basenames in launchd ProgramArguments. */
const GATEWAY_BINARIES = new Set([
  'litellm', 'claude-code-router', 'ccr', 'bifrost', 'portkey', 'helicone',
  'openllm', 'vllm', 'ollama', 'ollama serve', 'lmstudio', 'jan', 'mitmproxy',
  'gemini-gateway-for-claude', 'gemini-proxy-for-claude',
]);

/** AI CLI catalog: name -> the dot-dir/store whose absence means 'never launched'. */
const AI_CLIS: [name: string, marker: (home: string) => string][] = [
  ['claude', (h) => join(h, '.claude')],
  ['codex', (h) => join(h, '.codex')],
  ['grok', (h) => join(h, '.grok')],
  ['opencode', (h) => join(h, '.opencode')],
  ['gemini', (h) => join(h, '.gemini')],
  ['aider', (h) => join(h, '.aider')],
  ['goose', (h) => join(h, '.goose')],
  ['amp', (h) => join(h, '.config/amp')],
  ['continue', (h) => join(h, '.continue')],
  ['ollama', (h) => join(h, '.ollama')],
  ['litellm', (h) => join(h, '.litellm')],
  ['ccr', (h) => join(h, '.claude-code-router')],
  ['claude-code-router', (h) => join(h, '.claude-code-router')],
];

/** Fingerprint directories a known AI app leaves behind even when deleted. */
const APP_GHOST_FINGERPRINTS: [dir: (home: string) => string, label: string][] = [
  [(h) => `${h}/Library/Caches/com.electron.ollama`, 'Ollama'],
  [(h) => `${h}/Library/Application Support/Ollama`, 'Ollama'],
  [(h) => `${h}/Library/Application Support/LM Studio`, 'LM Studio'],
  [(h) => `${h}/Library/Application Support/jan`, 'Jan'],
  [(h) => `${h}/Library/Application Support/com.openai.chatgpt`, 'ChatGPT Desktop'],
  [(h) => `${h}/Library/Application Support/Warp`, 'Warp'],
  [(h) => `${h}/Library/Application Support/com.exafunction.warp`, 'Warp'],
];

/** Local model runtime ports: the socket probe's dictionary. */
const RUNTIME_PORTS: [port: number, name: string][] = [
  [11434, 'Ollama'],
  [1234, 'LM Studio'],
  [1337, 'Jan'],
  [4891, 'GPT4All'],
  [8000, 'vLLM'],
  [8080, 'LocalAI'],
];

const RUNTIME_PROCESS_HINT = /ollama|lms|lmstudio|jan|gpt4all|vllm|localai|llama/i;

/** Provider key-name dictionary: the variable NAME, never the value. */
const PROVIDER_KEY_NAMES: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic',
  ANTHROPIC_AUTH_TOKEN: 'anthropic',
  ANTHROPIC_BASE_URL: 'anthropic',
  OPENAI_API_KEY: 'openai',
  OPENAI_BASE_URL: 'openai',
  AZURE_OPENAI_API_KEY: 'azure',
  AZURE_OPENAI_ENDPOINT: 'azure',
  GEMINI_API_KEY: 'google',
  GOOGLE_API_KEY: 'google',
  OLLAMA_HOST: 'ollama',
  GROQ_API_KEY: 'groq',
  MISTRAL_API_KEY: 'mistral',
  TOGETHER_API_KEY: 'together',
  OPENROUTER_API_KEY: 'openrouter',
  DEEPSEEK_API_KEY: 'deepseek',
  XAI_API_KEY: 'xai',
  COHERE_API_KEY: 'cohere',
};

/** Provider -> substrings that would name an enrolled surface for it in ai_surfaces. */
const PROVIDER_SURFACE_HINTS: Record<string, string[]> = {
  anthropic: ['claude', 'anthropic'],
  openai: ['openai', 'chatgpt', 'codex'],
  azure: ['azure'],
  google: ['gemini'],
  ollama: ['ollama'],
  groq: ['groq'],
  mistral: ['mistral'],
  together: ['together'],
  openrouter: ['openrouter'],
  deepseek: ['deepseek'],
  xai: ['grok', 'xai'],
  cohere: ['cohere'],
};

function readBundleId(appDir: string): { id: string | null; version: string | null } {
  const plist = join(appDir, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return { id: null, version: null };
  try {
    const text = readFileSync(plist, 'utf8');
    // Minimal plist scrape: CFBundleIdentifier / CFBundleShortVersionString.
    const idm = text.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    const vm = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return { id: idm?.[1] ?? null, version: vm?.[1] ?? null };
  } catch {
    return { id: null, version: null };
  }
}

/** The signing Team ID for an app bundle — who vouched for this code. */
function teamIdOf(appDir: string): string | null {
  try {
    // codesign -dv writes its verdict to STDERR; capture it or lose it.
    const r = spawnSync('codesign', ['-dv', '--verbose=2', appDir], {
      encoding: 'utf8', timeout: 4000,
    });
    return r.stderr?.match(/TeamIdentifier=(\S+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function appSurfaces(): Surface[] {
  const out: Surface[] = [];
  for (const root of ['/Applications', join(homedir(), 'Applications')]) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.app')) continue;
      const dir = join(root, name);
      const { id, version } = readBundleId(dir);
      const hit = id ? AI_APPS.find(([re]) => re.test(id)) : undefined;
      if (!hit) continue;
      const team = teamIdOf(dir);
      out.push({
        surface_key: `app:${id ?? name}`,
        kind: 'app',
        name: hit[1],
        path: dir,
        evidence: `bundle id ${id} (installed app)`,
        version,
        extra: team ? JSON.stringify({ teamId: team }) : undefined,
        depth: { vendor: id?.split('.')[1] ?? null, identifier: id, evidence_kind: 'bundle', scanner: 'ai-surfaces' },
      });
    }
  }
  return out;
}

/** Ghost apps: fingerprint dirs that outlive the .app — the tool ran here once. */
function ghostAppSurfaces(): Surface[] {
  const out: Surface[] = [];
  const home = homedir();
  for (const [dir, label] of APP_GHOST_FINGERPRINTS) {
    const p = dir(home);
    if (!existsSync(p)) continue;
    // Only a ghost if the app itself is gone: an installed app's support dir is
    // covered by the app row above.
    const installed = ['/Applications', join(home, 'Applications')].some((root) => {
      try {
        return readdirSync(root).some((n) => n.endsWith('.app') && n.toLowerCase().includes(label.toLowerCase().split(' ')[0] ?? ''));
      } catch {
        return false;
      }
    });
    if (installed) continue;
    let mtime: number | null = null;
    try {
      mtime = Math.trunc(statSync(p).mtimeMs);
    } catch {
      /* unreadable stat: still a fingerprint */
    }
    out.push({
      surface_key: `ghost_app:${label.toLowerCase().replace(/\s+/g, '-')}`,
      kind: 'ghost_app',
      name: label,
      path: p,
      evidence: `leftover ${p.replace(home, '~')} — the app ran here and was deleted` +
        (mtime ? ` (last touched ${new Date(mtime).toISOString()})` : ''),
      depth: { evidence_kind: 'fingerprint_dir', scanner: 'ai-surfaces' },
    });
  }
  return out;
}

/** One field out of a launchd plist's raw XML. */
export function plistField(text: string, key: string): string | null {
  const after = text.split(`<key>${key}</key>`)[1];
  if (!after) return null;
  const m = after.match(/^\s*<string>([^<]*)<\/string>/) ?? after.match(/^\s*<(true|false)\/>/);
  return m?.[1] ?? null;
}

export interface GatewayRow {
  surface: Surface;
  label: string;
  argv: string[];
  runAtLoad: boolean | null;
  keepAlive: boolean | null;
  logPaths: string[];
}

/**
 * The AI gateway persistence inventory: every plist under the launchd roots,
 * matched against the gateway catalog, carrying RunAtLoad / KeepAlive / the
 * Std*Path log targets. A loaded LaunchAgent proves a process is configured to
 * run, not that any agent was ever pointed at it.
 */
export function gatewayRows(home: string): GatewayRow[] {
  const out: GatewayRow[] = [];
  for (const dir of [join(home, 'Library/LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons']) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.plist')) continue;
      const p = join(dir, f);
      let text: string;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const argv = [...text.matchAll(/<key>ProgramArguments<\/key>([\s\S]*?)<\/array>/g)]
        .flatMap((m) => [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]!));
      if (!argv.length) continue;
      const hit = argv.find((a) => GATEWAY_BINARIES.has(a.split('/').pop() ?? ''));
      if (!hit) continue;
      const label = plistField(text, 'Label') ?? f.replace(/\.plist$/, '');
      const runAtLoad = plistField(text, 'RunAtLoad');
      const keepAlive = plistField(text, 'KeepAlive');
      const logPaths = ['StandardOutPath', 'StandardErrorPath']
        .map((k) => plistField(text, k))
        .filter((x): x is string => !!x);
      out.push({
        label,
        argv,
        runAtLoad: runAtLoad === null ? null : runAtLoad === 'true',
        keepAlive: keepAlive === null ? null : keepAlive === 'true',
        logPaths,
        surface: {
          surface_key: `launchd:${f.replace(/\.plist$/, '')}`,
          kind: 'gateway',
          name: f.replace(/\.plist$/, ''),
          path: p,
          evidence:
            `launchd ${dir.includes('Daemons') ? 'daemon' : 'agent'} running ${hit}` +
            (runAtLoad === 'true' ? ' · RunAtLoad' : '') +
            (keepAlive === 'true' ? ' · KeepAlive' : '') +
            (logPaths.length ? ` · logs: ${logPaths.join(', ')}` : ''),
          extra: JSON.stringify({
            argv: argv.slice(0, 8), runAtLoad: runAtLoad === 'true', keepAlive: keepAlive === 'true',
            stdoutPath: logPaths[0] ?? null, stderrPath: logPaths[1] ?? null, label,
          }),
          depth: { evidence_kind: 'launchd_plist', scanner: 'ai-surfaces' },
        },
      });
    }
  }
  return out;
}

export interface CliRow extends Surface {
  installedVia: string;
  neverLaunched: boolean | null;
}

/** The npm-global package version under a lib root, when readable. */
function npmLibVersion(pkgDir: string): string | null {
  try {
    return ((JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string }).version) ?? null;
  } catch {
    return null;
  }
}

/**
 * The AI CLI and package-manager inventory: PATH plus the manager roots a
 * bundle-less install lives in — npm global libs, pipx venvs, the Caskroom —
 * with the 'installed via' class, the version where the manager records one,
 * and the 'never launched' marker (no dot-directory, store or log).
 */
export function cliInventory(home: string): CliRow[] {
  // One row per CLI name: the manager root that carries a version wins, so the
  // grid shows 'npm, v1.2.3' rather than a bare PATH hit.
  const byName = new Map<string, CliRow>();
  const rootClass = (dir: string): string => {
    if (dir.startsWith(join(home, '.npm-global'))) return 'npm-global';
    if (dir.includes('node_modules')) return 'npm';
    if (dir.includes('pipx')) return 'pipx';
    if (dir.includes('Caskroom')) return 'brew-cask';
    if (dir.startsWith('/opt/homebrew')) return 'brew';
    if (dir.startsWith(join(home, '.local'))) return 'user-local';
    return 'manual';
  };
  const binRoots = [join(home, '.local/bin'), join(home, '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, 'go/bin'), join(home, '.cargo/bin')];
  const libRoots = [
    '/opt/homebrew/lib/node_modules',
    join(home, '.npm-global/lib/node_modules'),
    join(home, '.local/pipx/venvs'),
    '/opt/homebrew/Caskroom',
  ];
  for (const [name, marker] of AI_CLIS) {
    // The dot-directory marker separates 'installed' from 'has run'.
    const launched = existsSync(marker(home));
    const add = (path: string, installedVia: string, version: string | null) => {
      const prev = byName.get(name);
      if (prev && (prev.version || !version)) return;
      byName.set(name, {
        surface_key: `cli:${name}`,
        kind: 'cli',
        name,
        path,
        evidence:
          `found at ${path} (installed via ${installedVia}${version ? `, v${version}` : ''})` +
          (launched ? '' : ' — NEVER LAUNCHED: no dot-directory, store or log for this CLI exists'),
        version,
        extra: JSON.stringify({ installedVia, version, neverLaunched: !launched }),
        installedVia,
        neverLaunched: !launched,
        depth: { evidence_kind: 'install_root', scanner: 'ai-surfaces' },
      });
    };
    try {
      const path = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (path) add(path, 'PATH', null);
    } catch {
      /* not on PATH — the manager roots below */
    }
    for (const dir of binRoots) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) add(candidate, rootClass(dir), null);
      } catch {
        /* unreadable dir — skip */
      }
    }
    for (const dir of libRoots) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!AI_CLIS.some(([n]) => n === entry)) continue;
        const pkgDir = join(dir, entry);
        let version: string | null = null;
        if (dir.includes('node_modules')) version = npmLibVersion(pkgDir);
        if (dir.includes('pipx')) {
          // The venv's dist-info names carry the version: a listing, no execution.
          try {
            for (const py of readdirSync(join(pkgDir, 'lib'))) {
              const sp = join(pkgDir, 'lib', py, 'site-packages');
              for (const d of readdirSync(sp)) {
                const m = d.match(new RegExp(`^${entry}-(\\d[^-]*)\\.dist-info$`));
                if (m) version = m[1]!;
              }
            }
          } catch {
            /* unreadable venv */
          }
        }
        if (dir.includes('Caskroom')) {
          try {
            version = readdirSync(pkgDir).sort().pop() ?? null; // version-named subdirs
          } catch {
            /* skip */
          }
        }
        add(pkgDir, rootClass(dir), version);
      }
    }
  }
  return [...byName.values()];
}

/**
 * The local model runtime census: three independent probes, because any one
 * alone lies. (a) the socket sample (stamped 'sampled at', never read as 'was
 * never used'); (b) the ollama manifests tree; (c) the LM Studio models dir and
 * Jan thread manifests.
 */
export function runtimeCensus(home: string): { surfaces: Surface[]; anomalies: Anomaly[] } {
  const out: Surface[] = [];
  const anomalies: Anomaly[] = [];
  const now = Date.now();
  // (a) socket sample
  let listening = '';
  try {
    listening = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    });
  } catch {
    /* lsof unavailable or nothing listening */
  }
  for (const line of listening.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const proc = cols[0] ?? 'unknown';
    const pid = cols[1] ?? '';
    const nameField = cols[cols.length - 1] ?? '';
    const m = nameField.match(/^(\S+?):(\d+)$/);
    if (!m) continue;
    const bindHost = m[1]!;
    const port = parseInt(m[2]!, 10);
    const knownPort = RUNTIME_PORTS.find(([p]) => p === port);
    const procMatch = RUNTIME_PROCESS_HINT.test(proc) && !knownPort;
    if (!knownPort && !procMatch) continue;
    const name = knownPort?.[1] ?? proc;
    const exposed = bindHost === '*' || bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]';
    out.push({
      surface_key: `runtime:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${port}`,
      kind: 'runtime',
      name: `${name} (port ${port})`,
      path: null,
      evidence:
        `listening on ${bindHost === '*' ? '0.0.0.0 (all interfaces)' : bindHost}:${port} — process ${proc} pid ${pid}, ` +
        `socket sampled at ${new Date(now).toISOString()}; a socket proves a server, never usage`,
      extra: JSON.stringify({ port, process: proc, pid, bind: bindHost, exposed, sampledAt: now }),
      depth: { evidence_kind: 'port_sample', scanner: 'ai-surfaces', state: exposed ? 'exposed' : 'loopback' },
    });
    if (exposed) {
      anomalies.push({
        anomaly_key: `exposed_local_bind:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${port}`,
        rule: 'exposed_local_bind',
        severity: 'warn',
        tool: 'ollama_local',
        session_id: null,
        model: null,
        window_start: now,
        window_end: now,
        title: `Local model runtime exposed: ${name} on ${bindHost}:${port}`,
        detail: `${name} (pid ${pid}) is listening on ${bindHost}:${port} — every interface on this machine, not just loopback. Anyone on the network can reach this model server. Socket sampled at ${new Date(now).toISOString()}; a later pass may show it closed, which proves nothing about before.`,
        observed: 1,
        baseline: null,
        threshold: null,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      });
    }
  }
  // (b) ollama manifests: registry/namespace/model/tag path segments are the inventory
  const manifests = join(home, '.ollama', 'models', 'manifests');
  const models: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      else if (depth >= 3) models.push(dir.replace(manifests + '/', '').split('/').slice(-3).join('/') + ':' + e.name);
    }
  };
  walk(manifests, 0);
  if (models.length) {
    out.push({
      surface_key: 'runtime:ollama:models',
      kind: 'runtime',
      name: 'Ollama (model inventory)',
      path: manifests,
      evidence: `${models.length} model(s) in the manifests tree: ${models.slice(0, 5).join(', ')}${models.length > 5 ? '…' : ''} — a pulled model proves intent, not use`,
      extra: JSON.stringify({ models: models.slice(0, 50) }),
      depth: { evidence_kind: 'manifest', scanner: 'ai-surfaces' },
    });
  }
  // (c) LM Studio models dir + Jan thread manifests
  const lms = join(home, '.lmstudio', 'models');
  try {
    const pubs = readdirSync(lms);
    const pulled = pubs.flatMap((pub) => readdirSync(join(lms, pub)).map((m) => `${pub}/${m}`));
    if (pulled.length) {
      out.push({
        surface_key: 'runtime:lmstudio:models',
        kind: 'runtime',
        name: 'LM Studio (model inventory)',
        path: lms,
        evidence: `${pulled.length} model(s) under ~/.lmstudio/models: ${pulled.slice(0, 5).join(', ')}${pulled.length > 5 ? '…' : ''}`,
        extra: JSON.stringify({ models: pulled.slice(0, 50) }),
        depth: { evidence_kind: 'manifest', scanner: 'ai-surfaces' },
      });
    }
  } catch {
    /* not installed */
  }
  const jan = join(home, 'Library', 'Application Support', 'Jan', 'data', 'threads');
  const janModels = new Set<string>();
  for (const t of (() => { try { return readdirSync(jan); } catch { return []; } })()) {
    try {
      const thread = JSON.parse(readFileSync(join(jan, t, 'thread.json'), 'utf8')) as { model?: string | { id?: string } };
      const id = typeof thread.model === 'string' ? thread.model : thread.model?.id;
      if (id) janModels.add(id);
    } catch {
      /* malformed thread: skip */
    }
  }
  if (janModels.size) {
    out.push({
      surface_key: 'runtime:jan:models',
      kind: 'runtime',
      name: 'Jan (model inventory)',
      path: jan,
      evidence: `${janModels.size} model(s) referenced by Jan threads: ${[...janModels].slice(0, 5).join(', ')}`,
      extra: JSON.stringify({ models: [...janModels].slice(0, 50) }),
      depth: { evidence_kind: 'manifest', scanner: 'ai-surfaces' },
    });
  }
  return { surfaces: out, anomalies };
}

/**
 * Provider credentials the user holds — NAMES and shapes only, never values.
 * A raw API key with no sanctioned surface is the exact shadow-spend shape;
 * the census records that the credential EXISTS (its key name and file), which
 * is inventory. The value never crosses into Vole.
 */
function credentialSurfaces(): Surface[] {
  const out: Surface[] = [];
  const home = homedir();
  const candidates: [file: string, label: string][] = [
    [`${home}/.claude/.credentials.json`, 'Claude Code OAuth credentials'],
    [`${home}/.codex/auth.json`, 'Codex auth (OpenAI OAuth or API key)'],
    [`${home}/.grok/credentials.json`, 'Grok credentials'],
    [`${home}/.continue/config.json`, 'Continue BYOK config'],
  ];
  for (const [file, label] of candidates) {
    if (!existsSync(file)) continue;
    // Shape only: which KIND of credential, never the secret.
    let shape = 'present';
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const keys = Object.keys(parsed);
      if (keys.includes('OPENAI_API_KEY')) shape = 'raw API key';
      else if (keys.some((k) => /oauth|refresh|access/i.test(k))) shape = 'OAuth tokens';
      else shape = `${keys.length} field(s): ${keys.slice(0, 4).join(', ')}`;
    } catch {
      shape = 'present (unreadable)';
    }
    out.push({
      surface_key: `credential:${file.replace(home, '~')}`,
      kind: 'credential',
      name: label,
      path: file,
      evidence: `${shape} — names and shapes only, the value never enters Vole`,
      depth: { evidence_kind: 'auth_file', scanner: 'ai-surfaces' },
    });
  }
  return out;
}

export interface ProviderKeyRow {
  key_name: string;
  source_file: string;
  shape: string;
}

/** Extract export/assignment lines naming provider keys from one rc/env file. */
export function providerKeyNamesInFile(file: string): ProviderKeyRow[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: ProviderKeyRow[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/);
    if (!m) continue;
    const name = m[1]!;
    const known = PROVIDER_KEY_NAMES[name];
    const generic = /_API_KEY$|_AUTH_TOKEN$/.test(name);
    if (!known && !generic) continue;
    // The VALUE stays on the line, in the file — only the name crosses.
    out.push({ key_name: name, source_file: file, shape: `line ${i + 1} export` });
  }
  return out;
}

/**
 * The provider key-name census: four name-only reads that never carry a value
 * past the match window — rc/env files (home + consented repo .env*), launchctl
 * getenv (set/unset and a length only), and keychain labels (svce/acct, no -w
 * ever, best effort because dump-keychain may prompt or fail silently).
 */
export function providerKeyCensus(home: string, repoRoots: string[]): ProviderKeyRow[] {
  const out: ProviderKeyRow[] = [];
  const rcFiles = ['.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile']
    .map((f) => join(home, f))
    .concat([join(home, '.config/fish/config.fish'), join(home, '.envrc')]);
  for (const file of rcFiles) out.push(...providerKeyNamesInFile(file));
  for (const root of repoRoots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const f of entries.filter((x) => /^\.env/.test(x))) {
      out.push(...providerKeyNamesInFile(join(root, f)));
    }
  }
  // launchctl getenv: the environment launchd hands every agent — set/unset + length.
  for (const name of Object.keys(PROVIDER_KEY_NAMES)) {
    try {
      const r = spawnSync('launchctl', ['getenv', name], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0 && r.stdout && r.stdout.trim().length > 0) {
        out.push({ key_name: name, source_file: 'launchctl', shape: `set (value length ${r.stdout.trim().length} — the value is never read)` });
      }
    } catch {
      /* launchctl unavailable */
    }
  }
  // keychain labels: svce/acct blob names only. `security dump-keychain` without
  // -w never extracts a secret; it can still prompt or fail on a locked keychain,
  // so an absent row is not an absent key.
  try {
    const dump = execFileSync('security', ['dump-keychain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });
    for (const m of dump.matchAll(/"(svce|acct)"<blob>="([^"]+)"/g)) {
      const label = m[2]!;
      const known = PROVIDER_KEY_NAMES[label];
      if (!known && !/_API_KEY$|_AUTH_TOKEN$/.test(label)) continue;
      out.push({ key_name: label, source_file: 'keychain (login)', shape: `${m[1]} label — no -w ever, the value never read` });
    }
  } catch {
    /* locked or unavailable: nothing to record */
  }
  return out;
}

/** A key belongs to a provider; does any ai_surfaces row enroll that provider? */
export function providerHasSurface(db: DB, provider: string): boolean {
  const hints = PROVIDER_SURFACE_HINTS[provider] ?? [provider];
  const rows = db.prepare("SELECT name, COALESCE(vendor, '') AS v FROM ai_surfaces").all() as { name: string; v: string }[];
  const hay = rows.map((r) => `${r.name} ${r.v}`.toLowerCase());
  return hints.some((h) => hay.some((x) => x.includes(h)));
}

function providerOf(keyName: string): string {
  return PROVIDER_KEY_NAMES[keyName] ?? keyName.replace(/_API_KEY$|_AUTH_TOKEN$/, '').split('_')[0]!.toLowerCase();
}

/**
 * The AI wired into macOS: Apple Intelligence / Siri extension settings, and the
 * MDM payload that was supposed to govern them. Enablement keys record
 * availability and opt-in — never prompts, tokens or content, which no
 * user-space reader can see.
 */
function osIntelligenceSurfaces(): Surface[] {
  const out: Surface[] = [];
  const readDefaults = (domain: string): string | null => {
    try {
      return execFileSync('defaults', ['read', domain], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
      });
    } catch {
      return null;
    }
  };
  const plist = 'com.apple.generativepartnerservicesettings';
  const settings = readDefaults(plist);
  if (settings) {
    const chatgptEnabled = /enablementCount = [1-9]/.test(settings);
    out.push({
      surface_key: 'os:apple-intelligence',
      kind: 'os',
      name: 'Apple Intelligence',
      path: `/Users/${homedir().split('/').pop()}/Library/Preferences/${plist}.plist`,
      evidence: `settings plist present${chatgptEnabled ? ' — Siri ChatGPT extension enabled at least once' : ''}; records enablement only, never content`,
      extra: JSON.stringify({ chatgptExtension: chatgptEnabled }),
      depth: { vendor: 'apple', evidence_kind: 'defaults', scanner: 'ai-surfaces' },
    });
  }
  const mdm = existsSync(`/Library/Managed Preferences/${plist}.plist`);
  if (mdm) {
    out.push({
      surface_key: 'os:apple-intelligence-mdm',
      kind: 'os',
      name: 'Apple Intelligence (MDM)',
      path: `/Library/Managed Preferences/${plist}.plist`,
      evidence: 'an MDM payload governs this setting — managed, not user-chosen',
      depth: { vendor: 'apple', evidence_kind: 'managed_prefs', scanner: 'ai-surfaces' },
    });
  }
  return out;
}

/**
 * Account class on shadow surfaces without collectors, resolved from the auth
 * path's opaque fields only: ~/.claude.json oauthOrganization (uuid/type/tier —
 * never emailAddress, fullName, displayName or organizationName) answers org-vs-
 * personal for Claude-family surfaces; ~/.copilot/config.json firstLaunchAt
 * dates the Copilot CLI surface. Everything undeterminable stays 'unknown'
 * rather than a guess.
 */
export function accountClassCensus(db: DB, home: string): number {
  let n = 0;
  let claude: { accountClass: string; evidence: string } | null = null;
  try {
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      oauthAccount?: { organizationUuid?: string; organizationType?: string; seatTier?: string; billingType?: string };
    };
    const o = cfg.oauthAccount;
    if (o) {
      const isOrg = typeof o.organizationUuid === 'string' && o.organizationUuid.length > 0;
      claude = {
        accountClass: isOrg ? 'org' : 'personal',
        evidence: `~/.claude.json oauthAccount.${isOrg ? 'organizationUuid present' : 'no organizationUuid'}${o.organizationType ? `, organizationType=${o.organizationType}` : ''}${o.seatTier ? `, seatTier=${o.seatTier}` : ''}${o.billingType ? `, billingType=${o.billingType}` : ''} — no name or email field touched`,
      };
    }
  } catch {
    /* absent or unreadable: class stays unknown, never guessed */
  }
  if (claude) {
    n += db.prepare(`
      UPDATE ai_surfaces SET account_class = COALESCE(account_class, ?), class_evidence = COALESCE(class_evidence, ?)
      WHERE surface_key LIKE 'app:com.anthropic%' OR surface_key LIKE 'cli:claude%' OR surface_key LIKE 'credential:~/.claude%'`)
      .run(claude.accountClass, claude.evidence).changes;
  }
  // Copilot: only a first-launch date exists locally; class is unknown by design.
  try {
    const cfg = JSON.parse(readFileSync(join(home, '.copilot', 'config.json'), 'utf8')) as { firstLaunchAt?: string };
    if (cfg.firstLaunchAt) {
      db.prepare(`
        UPDATE ai_surfaces SET class_evidence = COALESCE(class_evidence, ?)
        WHERE surface_key LIKE '%copilot%' AND account_class IS NULL`)
        .run(`~/.copilot/config.json firstLaunchAt=${cfg.firstLaunchAt} — personal-vs-org not determinable from local files`);
    }
  } catch {
    /* absent: nothing to date */
  }
  return n;
}

export function scanAiSurfaces(): { ok: boolean; notes?: string } {
  const db: DB = openDb();
  const now = Date.now();
  const home = homedir();
  const gateways = gatewayRows(home);
  const clis = cliInventory(home);
  const runtimes = runtimeCensus(home);
  const repoRoots = (db.prepare('SELECT root_path FROM work_roots WHERE COALESCE(exists_now, 1) = 1').all() as { root_path: string }[]).map((r) => r.root_path);
  const providerKeys = providerKeyCensus(home, repoRoots);
  const surfaces: Surface[] = [
    ...appSurfaces(),
    ...gateways.map((g) => g.surface),
    ...clis,
    ...ghostAppSurfaces(),
    ...runtimes.surfaces,
    ...osIntelligenceSurfaces(),
    ...credentialSurfaces(),
  ];
  for (const s of surfaces) upsertSurface(db, s, now);

  // provider_keys: the name census. UNIQUE(key_name, source_file) upsert.
  const keyUpsert = db.prepare(`
    INSERT INTO provider_keys (key_name, source_file, shape, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key_name, source_file) DO UPDATE SET last_seen = excluded.last_seen`);
  for (const k of providerKeys) keyUpsert.run(k.key_name, k.source_file, k.shape, now, now);

  // The policy join: sanctioned-ness is an admin decision, re-evaluated on every
  // scan. With no declaration loaded, every surface stays NULL/"no policy" and the
  // unsanctioned rule is INERT — shipping a default allowlist would make Vole's
  // opinion look like evidence.
  const policy: SurfacePolicy | null = loadSurfacePolicy();

  const anomalies: Anomaly[] = [
    ...runtimes.anomalies,
    // A launchd-declared gateway is persistence: it will run at load whether or
    // not anyone asked for it, and no vendor console reports it.
    ...gateways.map((g): Anomaly => ({
      anomaly_key: `ai_gateway_persistent:${g.label}`,
      rule: 'ai_gateway_persistent',
      severity: 'warn',
      tool: 'claude_code',
      session_id: null,
      model: null,
      window_start: now,
      window_end: now,
      title: `Persistent AI gateway: ${g.label}`,
      detail: `launchd declares ${g.label} running "${g.argv.join(' ')}"` +
        (g.runAtLoad ? ' with RunAtLoad' : '') + (g.keepAlive ? ' and KeepAlive' : '') +
        '. A loaded LaunchAgent proves a process is configured to run, not that any agent was ever pointed at it.',
      observed: 1,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    })),
    // A provider key with no enrolled surface for that provider is the shadow-
    // spend shape in miniature: possession without a governed consumer.
    ...[...new Map(providerKeys.map((k) => [providerOf(k.key_name), k])).entries()]
      .filter(([provider]) => !providerHasSurface(db, provider))
      .map(([provider, k]): Anomaly => ({
        anomaly_key: `provider_key_without_sanctioned_surface:${provider}:${k.source_file}`,
        rule: 'provider_key_without_sanctioned_surface',
        severity: 'info',
        tool: 'claude_code',
        session_id: null,
        model: null,
        window_start: now,
        window_end: now,
        title: `Provider key held with no enrolled surface: ${provider}`,
        detail: `${k.key_name} is set (${k.source_file}, ${k.shape}) but no AI surface for ${provider} is enrolled on this machine. Possession is not use: this rule cannot count a call, price one, or prove the key is still valid.`,
        observed: 1,
        baseline: null,
        threshold: null,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      })),
  ];

  const seen: { key: string; sanctioned: boolean | null; name: string; kind: string }[] = [];
  for (const s of surfaces) {
    const sanctioned = isSanctioned(policy, s.surface_key);
    db.prepare('UPDATE ai_surfaces SET sanctioned = ? WHERE surface_key = ?').run(
      sanctioned === null ? null : sanctioned ? 1 : 0,
      s.surface_key,
    );
    seen.push({ key: s.surface_key, sanctioned, name: s.name, kind: s.kind });

    // First-seen rule: a surface that appeared within the last day is news.
    const stored = db
      .prepare('SELECT first_seen FROM ai_surfaces WHERE surface_key = ?')
      .get(s.surface_key) as { first_seen: number };
    if (now - stored.first_seen < 24 * 3600_000) {
      anomalies.push({
        anomaly_key: `new_ai_surface:${s.surface_key}`,
        rule: 'new_ai_surface',
        severity: 'info',
        tool: 'claude_code',
        session_id: null,
        model: null,
        window_start: stored.first_seen,
        window_end: now,
        title: `New AI surface: ${s.name}`,
        detail: `${s.kind} surface "${s.name}" first seen ${new Date(stored.first_seen).toISOString()} — evidence: ${s.evidence}.`,
        observed: 1,
        baseline: null,
        threshold: null,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      });
    }
  }

  // The unsanctioned rule: only when a policy is loaded.
  if (policy) {
    for (const s of seen.filter((x) => x.sanctioned === false)) {
      anomalies.push({
        anomaly_key: `unsanctioned_surface:${s.key}`,
        rule: 'unsanctioned_surface',
        severity: 'warn',
        tool: 'claude_code',
        session_id: null,
        model: null,
        window_start: now,
        window_end: now,
        title: `Unsanctioned AI surface: ${s.name}`,
        detail: `${s.kind} surface "${s.name}" is not in the sanctioned declaration (${policy.source}). A row here is an inventory fact, never usage: it proves the artifact exists on disk, not that anything was sent to it.`,
        observed: 1,
        baseline: null,
        threshold: null,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      });
    }
  }

  const classified = accountClassCensus(db, home);

  // Rows that no longer appear in the census: a surface that vanished is either
  // uninstalled (its row should go) or a ghost (the ghost_app kind keeps its own
  // rows by design, created only when the app is confirmed gone). Never keep a
  // stale verdict on the books. Depth rows written by other census modules
  // (browser/editor/deps scanners) are theirs to retire, not ours.
  const currentKeys = new Set(surfaces.map((s) => s.surface_key));
  const mine = db
    .prepare("SELECT surface_key FROM ai_surfaces WHERE kind IN ('app','gateway','cli','ghost_app','runtime','os','credential')")
    .all() as { surface_key: string }[];
  for (const { surface_key } of mine) {
    if (!currentKeys.has(surface_key)) {
      db.prepare('DELETE FROM ai_surfaces WHERE surface_key = ?').run(surface_key);
    }
  }

  insertAnomalies(db, anomalies);
  return {
    ok: true,
    notes: `${surfaces.length} AI surfaces · ${gateways.length} gateway(s) · ${clis.length} CLI root(s) · ${providerKeys.length} provider key name(s)` +
      (classified ? ` · ${classified} surface(s) account-classified` : '') +
      (policy ? `, policy from ${policy.source}` : ', no policy loaded (unsanctioned rule inert)'),
  };
}

/** Registered on the cadence lane: a discovery walk never rides the 5s poll. */
export const aiSurfacesScanner: Scanner = {
  name: 'ai-surfaces',
  cadenceMs: 5 * 60_000,
  run: scanAiSurfaces,
};

import { readdirSync, readFileSync, existsSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { paths } from '../paths';
import { Database } from '../sqlite';
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

export interface Surface {
  surface_key: string;
  kind: 'app' | 'gateway' | 'cli' | 'ghost_app' | 'runtime' | 'os' | 'site' | 'extension' | 'credential' | 'dependency' | 'context' | 'ghost_ext';
  name: string;
  path: string | null;
  evidence: string;
  version?: string | null;
  extra?: string | null;
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

/** AI CLIs to probe on PATH and in known install dirs. */
const AI_CLIS = [
  'claude', 'codex', 'grok', 'opencode', 'gemini', 'aider', 'goose', 'amp',
  'continue', 'ollama', 'litellm', 'ccr', 'claude-code-router',
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

/** Local model runtime ports whose exposure is worth an evidence line. */
const RUNTIME_PORTS: [port: number, name: string][] = [
  [11434, 'Ollama'],
  [1234, 'LM Studio'],
  [4000, 'LiteLLM proxy'],
  [30000, 'vLLM/unknown gateway'],
];

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
    });
  }
  return out;
}

/** Local model runtimes with a listening port — the exposed-bind check. */
function runtimePortSurfaces(): Surface[] {
  const out: Surface[] = [];
  let listening = '';
  try {
    listening = execFileSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    });
  } catch {
    return out; // lsof unavailable or nothing listening
  }
  for (const [port, name] of RUNTIME_PORTS) {
    const line = listening.split('\n').find((l) => l.includes(`:${port} `) || l.endsWith(`:${port}`));
    if (!line) continue;
    const proc = line.trim().split(/\s+/)[0] ?? 'unknown';
    out.push({
      surface_key: `runtime:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${port}`,
      kind: 'runtime',
      name: `${name} (port ${port})`,
      path: null,
      evidence: `listening on 0.0.0.0:${port} — process ${proc}. A socket proves a server, never usage.`,
      extra: JSON.stringify({ port, process: proc }),
    });
  }
  return out;
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
    });
  }
  return out;
}

/** AI web hosts counted from browser history — hostname counts only, never URLs. */
const AI_HOST_PREFIXES: [prefix: string, label: string][] = [
  ['https://chatgpt.com', 'ChatGPT'],
  ['https://chat.openai.com', 'ChatGPT'],
  ['https://claude.ai', 'Claude'],
  ['https://gemini.google.com', 'Gemini'],
  ['https://www.perplexity.ai', 'Perplexity'],
  ['https://poe.com', 'Poe'],
  ['https://grok.com', 'Grok'],
  ['https://copilot.microsoft.com', 'Copilot'],
];

/** AI web hosts counted from browser history — hostname counts only, never URLs. */
function browserSiteSurfaces(): Surface[] {
  const out: Surface[] = [];
  const root = join(homedir(), 'Library/Application Support/Google/Chrome');
  for (const profile of ['Default', 'Profile 1', 'Profile 2']) {
    const history = join(root, profile, 'History');
    if (!existsSync(history)) continue;
    const tmp = join(root, `.vole-history-copy-${process.pid}`);
    try {
      copyFileSync(history, tmp);
      const hdb = new Database(tmp, { readonly: true, fileMustExist: true });
      for (const [prefix, label] of AI_HOST_PREFIXES) {
        // Chrome's last_visit_time is microseconds since 1601, as a BIGINT that
        // overflows JS numbers — cast to TEXT and do the epoch maths in BigInt.
        const row = hdb
          .prepare(
            `SELECT COUNT(*) AS visits, CAST(MAX(last_visit_time) AS TEXT) AS last
             FROM urls WHERE url LIKE ? || '%'`,
          )
          .get(`${prefix}/%`) as { visits: number; last: string | null };
        if (!row.visits) continue;
        let lastMs: number | null = null;
        if (row.last) {
          try {
            lastMs = Number((BigInt(row.last) - 11644473600000000n) / 1000n);
          } catch {
            lastMs = null;
          }
        }
        out.push({
          surface_key: `site:${label.toLowerCase().replace(/\s+/g, '-')}`,
          kind: 'site',
          name: `${label} (web)`,
          path: null,
          evidence: `${row.visits} visit(s) in Chrome ${profile} history, last ${
            lastMs ? new Date(lastMs).toISOString().slice(0, 10) : 'unknown'
          } — a visit is not usage: hostname counts only, no tokens, no cost`,
          extra: JSON.stringify({ visits: row.visits, lastVisit: lastMs, browser: 'chrome', profile }),
        });
      }
      hdb.close();
    } catch {
      /* history unreadable or locked: skip the profile */
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* temp copy cleanup is best effort */
      }
    }
  }
  return out;
}

/** Chrome extensions from Secure Preferences — installed browser AI reach. */
function browserExtensionSurfaces(): Surface[] {
  const out: Surface[] = [];
  const p = join(homedir(), 'Library/Application Support/Google/Chrome/Default/Secure Preferences');
  if (!existsSync(p)) return out;
  try {
    const prefs = JSON.parse(readFileSync(p, 'utf8')) as {
      extensions?: { settings?: Record<string, { manifest?: { name?: string; version?: string }; state?: number }> };
    };
    const AI_EXT_HINTS = /(?:^|[^a-z])(ai|gpt|claude|gemini|copilot|llm|chat|wise|sider|merlin|monica|perplex)(?:[^a-z]|$)/i;
    for (const [id, ext] of Object.entries(prefs.extensions?.settings ?? {})) {
      const name = ext.manifest?.name;
      if (!name || name.startsWith('__MSG_')) continue; // localised placeholder, not a real name
      if (!AI_EXT_HINTS.test(name)) continue;
      out.push({
        surface_key: `chrome-ext:${id}`,
        kind: 'extension',
        name,
        path: null,
        evidence: `Chrome extension (id ${id}, v${ext.manifest?.version ?? '?'}) — installed browser AI reach`,
        version: ext.manifest?.version ?? null,
        extra: JSON.stringify({ browser: 'chrome', id }),
      });
    }
  } catch {
    /* malformed prefs: skip */
  }
  return out;
}

/** VS Code / Cursor / Antigravity extensions from each editor's extensions.json. */
function editorExtensionSurfaces(): Surface[] {
  const out: Surface[] = [];
  const roots: [dir: string, editor: string][] = [
    [join(homedir(), '.vscode/extensions/extensions.json'), 'VS Code'],
    [join(homedir(), '.cursor/extensions/extensions.json'), 'Cursor'],
    [join(homedir(), '.antigram/extensions/extensions.json'), 'Antigravity'],
  ];
  const AI_EXT_HINTS = /(?:^|[^a-z])(ai|gpt|claude|gemini|copilot|llm|chat|cline|kilo|continue|aider)(?:[^a-z]|$)/i;
  for (const [file, editor] of roots) {
    if (!existsSync(file)) continue;
    try {
      const exts = JSON.parse(readFileSync(file, 'utf8')) as {
        identifier?: { id?: string }; version?: string; metadata?: { displayName?: string };
      }[];
      for (const e of exts) {
        const id = e.identifier?.id ?? '';
        if (!id || !AI_EXT_HINTS.test(id)) continue;
        out.push({
          surface_key: `editor-ext:${editor.toLowerCase().replace(/\s+/g, '')}:${id}`,
          kind: 'extension',
          name: e.metadata?.displayName ?? id,
          path: null,
          evidence: `${editor} extension ${id}@${e.version ?? '?'} — an install is not a use`,
          version: e.version ?? null,
          extra: JSON.stringify({ editor, id }),
        });
      }
    } catch {
      /* malformed extensions.json: skip */
    }
  }
  return out;
}

/** The AI wired into macOS: Apple Intelligence / Siri extension settings, and the
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
    });
  }
  return out;
}

function gatewaySurfaces(): Surface[] {
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
      const p = join(dir, f);
      let argv: string[] = [];
      try {
        const text = readFileSync(p, 'utf8');
        const m = text.match(/<key>ProgramArguments<\/key>([\s\S]*?)<\/array>/);
        if (m) argv = [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]!);
      } catch {
        continue;
      }
      const hit = argv.find((a) => GATEWAY_BINARIES.has(a.split('/').pop() ?? ''));
      if (!hit) continue;
      out.push({
        surface_key: `launchd:${f.replace(/\.plist$/, '')}`,
        kind: 'gateway',
        name: f.replace(/\.plist$/, ''),
        path: p,
        evidence: `launchd ${dir.includes('Daemons') ? 'daemon' : 'agent'} running ${hit}`,
        extra: JSON.stringify({ argv: argv.slice(0, 6) }),
      });
    }
  }
  return out;
}

function cliSurfaces(): Surface[] {
  const out: Surface[] = [];
  // PATH alone is not enough: a collector launched from the app bundle inherits
  // a minimal launchd PATH and cannot see ~/.local/bin — the census would silently
  // lose every user-local CLI depending on who started it. Probe PATH AND the
  // well-known install locations directly.
  const binDirs = [
    join(homedir(), '.local/bin'),
    join(homedir(), '.npm-global/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), 'go/bin'),
    join(homedir(), '.cargo/bin'),
  ];
  for (const name of AI_CLIS) {
    let path: string | null = null;
    try {
      path = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      /* not on PATH — try the known dirs */
    }
    if (!path) {
      for (const dir of binDirs) {
        const candidate = join(dir, name);
        try {
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            path = candidate;
            break;
          }
        } catch {
          /* unreadable dir — skip */
        }
      }
    }
    if (!path) continue;
    out.push({
      surface_key: `cli:${name}`,
      kind: 'cli',
      name,
      path,
      evidence: `found at ${path}${path.startsWith(join(homedir(), '.')) ? ' (user-local install)' : ''}`,
    });
  }
  return out;
}

export function scanAiSurfaces(): { ok: boolean; notes?: string } {
  const db: DB = openDb();
  const now = Date.now();
  const surfaces = [
    ...appSurfaces(),
    ...gatewaySurfaces(),
    ...cliSurfaces(),
    ...ghostAppSurfaces(),
    ...runtimePortSurfaces(),
    ...osIntelligenceSurfaces(),
    ...credentialSurfaces(),
    ...browserSiteSurfaces(),
    ...browserExtensionSurfaces(),
    ...editorExtensionSurfaces(),
  ];
  const upsert = db.prepare(`
    INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(surface_key) DO UPDATE SET
      last_seen = excluded.last_seen,
      path = excluded.path,
      version = excluded.version,
      evidence = excluded.evidence,
      extra = excluded.extra`);

  // The policy join: sanctioned-ness is an admin decision, re-evaluated on every
  // scan. With no declaration loaded, every surface stays NULL/"no policy" and the
  // unsanctioned rule is INERT — shipping a default allowlist would make Vole's
  // opinion look like evidence.
  const policy: SurfacePolicy | null = loadSurfacePolicy();

  const anomalies: Anomaly[] = [];
  const seen: { key: string; sanctioned: boolean | null; name: string; kind: string; firstSeen: number }[] = [];
  for (const s of surfaces) {
    upsert.run(s.surface_key, s.kind, s.name, s.path, s.evidence, s.version ?? null, s.extra ?? null, now, now);
    const sanctioned = isSanctioned(policy, s.surface_key);
    db.prepare('UPDATE ai_surfaces SET sanctioned = ? WHERE surface_key = ?').run(
      sanctioned === null ? null : sanctioned ? 1 : 0,
      s.surface_key,
    );
    seen.push({ key: s.surface_key, sanctioned, name: s.name, kind: s.kind, firstSeen: now });

    // First-seen rule: a surface that appeared within the last day is news.
    const stored = db
      .prepare('SELECT first_seen FROM ai_surfaces WHERE surface_key = ?')
      .get(s.surface_key) as { first_seen: number };
    if (now - stored.first_seen < 24 * 3600_000) {
      anomalies.push({
        anomaly_key: `new_ai_surface:${s.surface_key}`,
        rule: 'new_ai_surface',
        severity: 'info',
        tool: 'claude_code' as never, // no collector owns inventory; the column is NOT NULL
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
        tool: 'claude_code' as never,
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

  // Rows that no longer appear in the census: a surface that vanished is either
  // uninstalled (its row should go) or a ghost (the ghost_app kind keeps its own
  // rows by design, created only when the app is confirmed gone). Never keep a
  // stale verdict on the books.
  const currentKeys = new Set(surfaces.map((s) => s.surface_key));
  const stale = db
    .prepare("SELECT surface_key FROM ai_surfaces WHERE kind != 'ghost_app'")
    .all() as { surface_key: string }[];
  for (const { surface_key } of stale) {
    if (!currentKeys.has(surface_key)) {
      db.prepare('DELETE FROM ai_surfaces WHERE surface_key = ?').run(surface_key);
    }
  }

  insertAnomalies(db, anomalies);
  return {
    ok: true,
    notes: `${surfaces.length} AI surfaces${policy ? `, policy from ${policy.source}` : ', no policy loaded (unsanctioned rule inert)'}`,
  };
}

/** Registered on the cadence lane: a discovery walk never rides the 5s poll. */
export const aiSurfacesScanner: Scanner = {
  name: 'ai-surfaces',
  cadenceMs: 5 * 60_000,
  run: scanAiSurfaces,
};

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Database } from '../sqlite';
import type { DB } from '../db';
import { openDb } from '../db';
import type { Scanner } from '../db';
import { upsertSurface, type Surface } from './ai-surfaces';

/**
 * The editor AI-extension census (tier 2). extensions.json is the SMALLEST of
 * the three readers — the most-deployed AI extension on earth ships as a BUILT-IN
 * under /Applications and appears in no extensions.json — so the census unions:
 *   1. <root>/extensions/extensions.json (installer's record, full metadata)
 *   2. built-ins: App.app/Contents/Resources/app/extensions/<name>/package.json
 *   3. profile extensions.json under <app support>/User/profiles/<id>/
 * plus the root's own version/commit chip from product.json.
 *
 * Ghosts come from the workbench/memento key shapes that outlive an uninstall,
 * resolved through a shipped offline map — an unmapped id renders as 'unmapped
 * container: <id>', never guessed. Fork drift compares the same extension id
 * across roots. Settings-Sync envelopes give retroactive version history.
 */

/** Editor home roots (dot-dirs) and their app bundles, where one exists. */
export function editorRoots(home: string, appsBase = '/Applications'): { key: string; extRoot: string; app?: string; appSupport: string }[] {
  return [
    { key: 'vscode', extRoot: join(home, '.vscode'), app: join(appsBase, 'Visual Studio Code.app'), appSupport: join(home, 'Library/Application Support/Code') },
    { key: 'cursor', extRoot: join(home, '.cursor'), app: join(appsBase, 'Cursor.app'), appSupport: join(home, 'Library/Application Support/Cursor') },
    { key: 'antigravity', extRoot: join(home, '.antigravity-ide'), appSupport: join(home, 'Library/Application Support/Antigravity') },
    { key: 'kiro', extRoot: join(home, '.kiro'), appSupport: join(home, 'Library/Application Support/Kiro') },
    { key: 'windsurf', extRoot: join(home, '.windsurf'), appSupport: join(home, 'Library/Application Support/Windsurf') },
  ];
}

/**
 * The contribution points an extension DECLARES its AI surface with. Vendor-
 * neutral, machine-readable, already on disk — no publisher allowlist.
 */
const AI_CONTRIBUTES = [
  'chatParticipants', 'chatAgents', 'chatSessions', 'chatSkills', 'chatPromptFiles',
  'languageModelChatProviders', 'languageModelTools', 'languageModelToolSets',
  'mcpServerDefinitionProviders',
];
const AI_ID_HINT = /(?:^|[^a-z])(ai|gpt|claude|gemini|copilot|llm|cline|roo|kilo|continue|aider|chat|chatmocker|cody)(?:[^a-z]|$)/i;

export interface ExtensionRow {
  id: string;
  version: string | null;
  root: string;
  reader: 'extensions.json' | 'builtin' | 'profile';
  builtIn: boolean;
  metadata: Record<string, unknown>;
  aiSignals: string[];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function contributionSignals(pkg: Record<string, unknown>): string[] {
  const contributes = (pkg.contributes ?? {}) as Record<string, unknown>;
  const signals: string[] = [];
  for (const key of AI_CONTRIBUTES) {
    const v = contributes[key];
    if (Array.isArray(v) && v.length) signals.push(key);
    else if (v && typeof v === 'object' && Object.keys(v).length) signals.push(key);
  }
  const untrusted = ((pkg.capabilities as { untrustedWorkspaces?: { supported?: string } } | undefined)?.untrustedWorkspaces)?.supported;
  if (untrusted) signals.push(`untrusted:${untrusted}`);
  return signals;
}

/** Reader 1 + 3: an extensions.json array, from a home root or a profile. */
export function readExtensionsJson(file: string, root: string, reader: 'extensions.json' | 'profile'): ExtensionRow[] {
  const parsed = readJson(file);
  if (!Array.isArray(parsed)) return [];
  const out: ExtensionRow[] = [];
  for (const e of parsed as Record<string, unknown>[]) {
    const id = ((e.identifier as { id?: string } | undefined)?.id ?? '').toLowerCase();
    if (!id) continue;
    const metadata = (e.metadata ?? {}) as Record<string, unknown>;
    out.push({
      id,
      version: (e.version as string | undefined) ?? null,
      root, reader, builtIn: false,
      metadata: {
        installedTimestamp: metadata.installedTimestamp ?? null,
        installedFrom: metadata.source ?? null,
        publisherId: metadata.publisherId ?? null,
        publisherDisplayName: metadata.publisherDisplayName ?? null,
        isPreReleaseVersion: metadata.isPreReleaseVersion ?? null,
        pinned: metadata.pinned ?? null,
        updated: metadata.updated ?? null,
        private: metadata.private ?? null,
        targetPlatform: metadata.targetPlatform ?? null,
        relativeLocation: (e.location as { value?: string } | undefined)?.value ?? null,
      },
      aiSignals: AI_ID_HINT.test(id) ? ['id_hint'] : [],
    });
  }
  return out;
}

/** Reader 2: built-ins under /Applications — the extensions.json census misses these. */
export function readBuiltins(app: string, root: string): ExtensionRow[] {
  const dir = join(app, 'Contents/Resources/app/extensions');
  const out: ExtensionRow[] = [];
  for (const name of readdirSafe(dir)) {
    const pkg = readJson(join(dir, name, 'package.json'));
    if (!pkg) continue;
    const publisher = (pkg.publisher as string | undefined) ?? 'vscode';
    const id = `${publisher}.${(pkg.name as string | undefined) ?? name}`.toLowerCase();
    const signals = contributionSignals(pkg);
    out.push({
      id, version: (pkg.version as string | undefined) ?? null, root, reader: 'builtin', builtIn: true,
      metadata: { builtinName: name, extensionKind: pkg.extensionKind ?? null, enabledApiProposals: (pkg.enabledApiProposals as string[] | undefined)?.length ?? null },
      aiSignals: signals,
    });
  }
  return out;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The editor's own version/commit/quality chip, from product.json. */
export function productChip(app: string): { version: string | null; commit: string | null; quality: string | null } {
  const pkg = readJson(join(app, 'Contents/Resources/app/product.json'));
  return {
    version: (pkg?.version as string | undefined) ?? null,
    commit: (pkg?.commit as string | undefined) ?? null,
    quality: (pkg?.quality as string | undefined) ?? null,
  };
}

/**
 * The full census across the three readers. Returns extension rows and the
 * ai_surfaces rows to write (root chips, extensions, fork drift).
 */
export function editorExtensionCensus(home: string, appsBase = '/Applications'): { rows: ExtensionRow[]; surfaces: Surface[] } {
  const surfaces: Surface[] = [];
  const rows: ExtensionRow[] = [];
  for (const root of editorRoots(home, appsBase)) {
    const hasRoot = existsSync(root.extRoot) || existsSync(root.appSupport);
    if (!hasRoot) continue;
    // The root's own chip: version/commit/quality of the editor itself.
    if (root.app && existsSync(root.app)) {
      const chip = productChip(root.app);
      surfaces.push({
        surface_key: `editor-root:${root.key}`,
        kind: 'config_dir',
        name: `${root.key} editor root`,
        path: root.extRoot,
        evidence: `editor present (v${chip.version ?? '?'} commit ${chip.commit?.slice(0, 8) ?? '?'} ${chip.quality ?? '?'}) — extensions below are grouped under this root`,
        version: chip.version,
        extra: JSON.stringify({ ...chip, editor: root.key }),
        depth: { evidence_kind: 'product_json', scanner: 'editor-census' },
      });
    }
    const installed = readExtensionsJson(join(root.extRoot, 'extensions/extensions.json'), root.key, 'extensions.json');
    const profiles = existsSync(root.appSupport)
      ? readdirSafe(join(root.appSupport, 'User/profiles')).flatMap((p) =>
          readExtensionsJson(join(root.appSupport, 'User/profiles', p, 'extensions.json'), `${root.key}:${p}`, 'profile'))
      : [];
    const builtins = root.app && existsSync(root.app) ? readBuiltins(root.app, root.key) : [];
    rows.push(...installed, ...profiles, ...builtins);
    for (const e of [...installed, ...profiles]) {
      surfaces.push({
        surface_key: `editor-ext:${e.root}:${e.id}`,
        kind: 'extension',
        name: e.id,
        path: join(root.extRoot, 'extensions'),
        evidence: `${root.key} extension ${e.id}@${e.version ?? '?'} installed ${e.reader === 'profile' ? '(profile)' : ''}` +
          (e.metadata.installedTimestamp ? ` at ${new Date(Number(e.metadata.installedTimestamp)).toISOString()}` : '') +
          ' — the installer\'s record, not proof it ever ran',
        version: e.version,
        extra: JSON.stringify({ ...e, ai: e.aiSignals.length > 0 }),
        depth: { identifier: e.id, evidence_kind: e.reader, scanner: 'editor-census', discovery: e.reader === 'profile' ? 'profile' : 'installed' },
      });
    }
    for (const e of builtins) {
      if (!e.aiSignals.length) continue; // 80 built-ins; only the declared-AI ones are surfaces
      surfaces.push({
        surface_key: `editor-ext:${e.root}:builtin:${e.id}`,
        kind: 'extension',
        name: `${e.id} (built-in)`,
        path: root.app ? join(root.app, 'Contents/Resources/app/extensions') : null,
        evidence: `BUILT-IN ${e.id}@${e.version ?? '?'} bundled with ${root.key} — appears in no extensions.json; declares: ${e.aiSignals.join(', ')}`,
        version: e.version,
        extra: JSON.stringify(e),
        depth: { identifier: e.id, evidence_kind: 'builtin', scanner: 'editor-census', discovery: 'builtin' },
      });
    }
  }
  // Fork drift: same extension id, different versions across roots.
  const byId = new Map<string, { root: string; version: string | null }[]>();
  for (const e of rows.filter((r) => !r.builtIn)) {
    const list = byId.get(e.id) ?? [];
    list.push({ root: e.root, version: e.version });
    byId.set(e.id, list);
  }
  for (const [id, list] of byId) {
    const versions = new Set(list.map((x) => x.version ?? '?'));
    if (list.length > 1 && versions.size > 1) {
      surfaces.push({
        surface_key: `editor-fork-drift:${id}`,
        kind: 'extension',
        name: `Fork drift: ${id}`,
        path: null,
        evidence: `extension ${id} runs ${versions.size} versions across editor roots: ${[...versions].join(', ')} (${list.map((x) => x.root).join(', ')})`,
        extra: JSON.stringify({ id, versions: [...versions], roots: list }),
        depth: { identifier: id, evidence_kind: 'fork_drift', scanner: 'editor-census' },
      });
    }
  }
  return { rows, surfaces };
}

/**
 * The shipped offline map for view-container ids found in ghost state keys.
 * Resolution is exact-prefix or 'unmapped container: <id>' — never a keyword guess.
 */
export const CONTAINER_MAP: Record<string, string> = {
  'github.copilot': 'GitHub Copilot',
  'github.copilot-chat': 'GitHub Copilot Chat',
  'github.vscode-copilot': 'GitHub Copilot',
  'continue.continue': 'Continue',
  'saoudrizwan.claude-dev': 'Cline',
  'rooveterinaryinc.roo-cline': 'Roo Code',
  'kilocode.kilo-code': 'Kilo Code',
  'anthropic.claude-code': 'Claude Code (VS Code)',
  'anthropic.claude-vscode': 'Claude Code (VS Code)',
  'google.geminicodeassist': 'Gemini Code Assist',
  'sourcegraph.cody-ai': 'Sourcegraph Cody',
  'openai.chatgpt': 'ChatGPT (VS Code)',
  'openai.vscode-openai': 'OpenAI (VS Code)',
};

/** Container ids extracted from the ghost key shapes. */
export function extractGhostContainers(keys: string[]): { containerId: string; shape: string }[] {
  const out: { containerId: string; shape: string }[] = [];
  for (const key of keys) {
    // Container ids contain dots themselves ('github.copilot-chat'), so every
    // capture is non-greedy up to the fixed suffix.
    let m = key.match(/^workbench\.view\.extension\.(.+?)\.state\.hidden$/);
    if (m) { out.push({ containerId: m[1]!, shape: 'workbench.view' }); continue; }
    m = key.match(/^memento\/webviewView\.(.+)$/);
    if (m) { out.push({ containerId: leadingExtensionId(m[1]!), shape: 'memento.webviewView' }); continue; }
    m = key.match(/^memento\/(.+)$/);
    if (m) { out.push({ containerId: leadingExtensionId(m[1]!), shape: 'memento' }); continue; }
    m = key.match(/^chatStatusDashboard\.contributedCollapsed\.(.+)$/);
    if (m) { out.push({ containerId: leadingExtensionId(m[1]!), shape: 'chatStatusDashboard' }); continue; }
  }
  return out;
}

function leadingExtensionId(id: string): string {
  const parts = id.split('.');
  return parts.length >= 2 && parts[0]!.length > 1 ? `${parts[0]}.${parts[1]}` : id;
}

/** Resolve a container id through the offline map; unknown stays explicit. */
export function resolveContainer(id: string): string {
  if (CONTAINER_MAP[id]) return CONTAINER_MAP[id]!;
  const twoSegment = leadingExtensionId(id);
  if (CONTAINER_MAP[twoSegment]) return CONTAINER_MAP[twoSegment]!;
  return `unmapped container: ${id}`;
}

/**
 * Ghost AI extensions: workbench/memento keys contributed by an extension that
 * is no longer installed, from state.vscdb ItemTable and the dated Settings-Sync
 * globalState backups. The two backup timestamps bound its existence.
 */
export function ghostExtensionCensus(home: string, installedIds: Set<string>): Surface[] {
  const out: Surface[] = [];
  for (const root of editorRoots(home)) {
    const appSupport = root.appSupport;
    if (!existsSync(appSupport)) continue;
    const sightings = new Map<string, { shapes: Set<string>; firstTs: number | null; lastTs: number }>();
    const note = (id: string, shape: string, ts: number | null) => {
      const s = sightings.get(id) ?? { shapes: new Set<string>(), firstTs: ts, lastTs: ts ?? 0 };
      s.shapes.add(shape);
      if (ts !== null) {
        if (s.firstTs === null || ts < s.firstTs) s.firstTs = ts;
        if (ts > s.lastTs) s.lastTs = ts;
      }
      sightings.set(id, s);
    };
    // Source 1: the live global state (state.vscdb, ItemTable keys).
    const vscdb = join(appSupport, 'User/globalStorage/state.vscdb');
    if (existsSync(vscdb)) {
      try {
        const db = new Database(vscdb, { readonly: true, fileMustExist: true });
        const keys = (db.prepare('SELECT key FROM ItemTable').all() as { key: string }[]).map((r) => r.key);
        db.close();
        const ts = Math.trunc(statSync(vscdb).mtimeMs);
        for (const { containerId, shape } of extractGhostContainers(keys)) note(containerId, shape, ts);
      } catch {
        /* unreadable state: skip */
      }
    }
    // Source 2: the dated Settings-Sync backups — the bound on when it existed.
    const syncDir = join(appSupport, 'User/sync/globalState');
    for (const f of readdirSafe(syncDir).filter((x) => x.endsWith('.json'))) {
      const file = join(syncDir, f);
      const parsed = readJson(file);
      if (!parsed) continue;
      let ts: number | null = null;
      try {
        ts = Math.trunc(statSync(file).mtimeMs);
      } catch {
        ts = null;
      }
      for (const { containerId, shape } of extractGhostContainers(Object.keys(parsed))) note(containerId, shape, ts);
    }
    for (const [containerId, s] of sightings) {
      const extId = leadingExtensionId(containerId);
      if (installedIds.has(extId)) continue; // still installed — not a ghost
      const resolved = resolveContainer(containerId);
      if (resolved.startsWith('unmapped container:') && !AI_ID_HINT.test(containerId)) continue; // unknown AND not AI-shaped: skip
      out.push({
        surface_key: `ghost-ext:${root.key}:${containerId}`,
        kind: 'ghost_ext',
        name: resolved,
        path: join(appSupport, 'User'),
        evidence: `${resolved} left workbench state (${[...s.shapes].join(', ')}) in ${root.key} but is not installed — it ran here once and was removed` +
          (s.firstTs ? `, state seen between ${new Date(s.firstTs).toISOString().slice(0, 10)} and ${new Date(s.lastTs).toISOString().slice(0, 10)}` : ''),
        extra: JSON.stringify({ containerId, resolved, shapes: [...s.shapes], firstBackupTs: s.firstTs, lastBackupTs: s.lastTs || null, editor: root.key }),
        depth: { identifier: containerId, evidence_kind: 'ghost_state', scanner: 'editor-census', discovery: 'ghost' },
      });
    }
  }
  return out;
}

/**
 * Retroactive extension-version history from Settings Sync: each envelope under
 * User/sync/extensions/<id>.json carries the version that was synced, so the
 * version lane survives the local upgrade.
 */
export function syncVersionHistory(home: string): Surface[] {
  const out: Surface[] = [];
  for (const root of editorRoots(home)) {
    const dir = join(root.appSupport, 'User/sync/extensions');
    for (const f of readdirSafe(dir).filter((x) => x.endsWith('.json'))) {
      const id = f.replace(/\.json$/, '').toLowerCase();
      const parsed = readJson(join(dir, f));
      const version = (parsed?.version as string | undefined) ?? null;
      let ts: number | null = null;
      try {
        ts = Math.trunc(statSync(join(dir, f)).mtimeMs);
      } catch {
        /* keep null */
      }
      if (!version && !ts) continue;
      out.push({
        surface_key: `extver-sync:${root.key}:${id}:${version ?? 'unknown'}`,
        kind: 'extension',
        name: `${id} (Settings Sync envelope)`,
        path: join(dir, f),
        evidence: `Settings Sync recorded ${id}${version ? ` at version ${version}` : ''}${ts ? ` (envelope last written ${new Date(ts).toISOString().slice(0, 10)})` : ''} — retroactive version history from the sync envelope`,
        version,
        extra: JSON.stringify({ id, version, envelopeTs: ts, editor: root.key }),
        depth: { identifier: id, evidence_kind: 'sync_envelope', scanner: 'editor-census' },
      });
    }
  }
  return out;
}

export function scanEditorCensus(): { ok: boolean; notes?: string } {
  const db: DB = openDb();
  const now = Date.now();
  const home = homedir();
  const { rows, surfaces } = editorExtensionCensus(home);
  const installedIds = new Set(rows.map((r) => r.id));
  const ghosts = ghostExtensionCensus(home, installedIds);
  const sync = syncVersionHistory(home);
  for (const s of [...surfaces, ...ghosts, ...sync]) upsertSurface(db, s, now);
  return {
    ok: true,
    notes: `${rows.length} extension(s) across 3 readers · ${ghosts.length} ghost(s) · ${sync.length} sync envelope(s)`,
  };
}

export const editorCensusScanner: Scanner = {
  name: 'editor-census',
  cadenceMs: 5 * 60_000,
  run: scanEditorCensus,
};

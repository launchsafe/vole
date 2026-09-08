import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { editorRoots, home } from '../paths';
import { Database } from '../sqlite';
import { openDb } from '../db';
import type { DB, Scanner } from '../db';

/**
 * The editor-state readers (tier 2 features 5/6/39/40/42): what the sanctioned
 * editor itself recorded about AI use — exact per-extension token totals counted
 * by the editor, the repositories each extension activated in, the
 * contribution points that make an extension an AI surface with no name list,
 * the models chosen in the picker, and the browser vendor's own assistant with
 * a real last-invoked date.
 *
 * The token figures are single undifferentiated totals: cost is NOT computable,
 * every cost column stays NULL, and no aggregate may fold these rows into a
 * dollar figure. A workspace or model id proves activation or selection, never
 * that a request was sent.
 */

function slug(app: string): string {
  return app.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Opens an ItemTable store read-only; null when absent or unreadable. */
function openItemTable(p: string): Database | null {
  if (!existsSync(p)) return null;
  try {
    return new Database(p, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

interface ItemRow {
  key: string;
  value: string;
}

/** All ItemTable rows (sync state, workspace state) for a .vscdb path. */
export function itemRows(p: string): ItemRow[] {
  const db = openItemTable(p);
  if (!db) return [];
  try {
    return db.prepare('SELECT key, value FROM ItemTable').all() as ItemRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// ── Feature 5: languageModelStats — exact tokens per extension per model ──────

export interface ExtModelStat {
  model: string;
  extensionId: string;
  requestCount: number | null;
  tokenCount: number | null;
}

/**
 * Parses the documented value shape for key languageModelStats.<model>:
 * {"extensions":[{"extensionId":"GitHub.copilot-chat","requestCount":6,
 * "tokenCount":66383,"participants":[]}]}. Older blobs wrote {model:{tokenCount}}
 * — that shape carries no per-extension split and yields nothing here, by design.
 */
export function parseLanguageModelStats(key: string, value: unknown): ExtModelStat[] {
  if (!key.startsWith('languageModelStats.')) return [];
  const model = key.slice('languageModelStats.'.length);
  let v: unknown = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  // The sync blob wraps values as {version, value}; unwrap one level.
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const inner = (v as { value: unknown }).value;
    if (typeof inner === 'string') {
      try {
        v = JSON.parse(inner);
      } catch {
        v = inner;
      }
    } else v = inner;
  }
  const exts = (v as { extensions?: unknown } | null)?.extensions;
  if (!Array.isArray(exts)) return [];
  const out: ExtModelStat[] = [];
  for (const e of exts) {
    const ext = e as { extensionId?: string; requestCount?: number; tokenCount?: number };
    if (typeof ext?.extensionId !== 'string') continue;
    out.push({
      model,
      extensionId: ext.extensionId,
      requestCount: typeof ext.requestCount === 'number' ? ext.requestCount : null,
      tokenCount: typeof ext.tokenCount === 'number' ? ext.tokenCount : null,
    });
  }
  return out;
}

/** languageModelAccess.<model>: the extension ids GRANTED that model. */
export function parseLanguageModelAccess(key: string, value: unknown): { model: string; granted: string[] } | null {
  if (!key.startsWith('languageModelAccess.')) return null;
  let v: unknown = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const inner = (v as { value: unknown }).value;
    v = typeof inner === 'string' ? (() => { try { return JSON.parse(inner); } catch { return inner; } })() : inner;
  }
  const list = Array.isArray(v) ? v : (v as { extensions?: unknown[] } | null)?.extensions;
  if (!Array.isArray(list)) return null;
  return {
    model: key.slice('languageModelAccess.'.length),
    granted: list.filter((x): x is string => typeof x === 'string'),
  };
}

/** Every (key, parsed-value) pair in the Settings Sync global-state blob and its dated siblings. */
function syncStorageEntries(root: string): { key: string; value: unknown }[] {
  const out: { key: string; value: unknown }[] = [];
  const dir = join(root, 'User', 'sync', 'globalState');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    const blob = readJson(join(dir, f)) as { storage?: Record<string, unknown> } | null;
    for (const [key, value] of Object.entries(blob?.storage ?? {})) out.push({ key, value });
  }
  return out;
}

// ── Feature 6: per-workspace activation ──────────────────────────────────────

export interface WorkspaceActivation {
  uri: string | null;
  /** state.vscdb mtime — the 'not after' date of the evidence. */
  notAfter: number | null;
  extensions: string[];
}

/**
 * Which extensions left keys in THIS workspace's state.vscdb — proof a view
 * container was materialized there, not that a prompt was sent. Keys look
 * like <publisher.extension>/<state> or <publisher.extension>:<state>.
 */
export function workspaceActivation(root: string): WorkspaceActivation[] {
  const out: WorkspaceActivation[] = [];
  const wsRoot = join(root, 'User', 'workspaceStorage');
  let hashes: string[];
  try {
    hashes = readdirSync(wsRoot);
  } catch {
    return out;
  }
  for (const h of hashes) {
    const vscdb = join(wsRoot, h, 'state.vscdb');
    let notAfter: number | null = null;
    try {
      notAfter = statSync(vscdb).mtimeMs;
    } catch {
      /* absent vscdb: mtime unknown, activation list empty */
    }
    const extensions = new Set<string>();
    for (const { key } of itemRows(vscdb)) {
      const m = key.match(/^([a-z0-9-]+\.[a-z0-9_-]+)[/:]/i);
      if (m) extensions.add(m[1]!.toLowerCase());
    }
    const folder = (readJson(join(wsRoot, h, 'workspace.json')) as { folder?: string } | null)?.folder ?? null;
    if (extensions.size || folder) {
      out.push({ uri: folder, notAfter, extensions: [...extensions] });
    }
  }
  return out;
}

// ── Feature 39: contribution-point classifier ────────────────────────────────

export interface ContribCaps {
  /** Which AI contribution points the extension declares. */
  contributions: string[];
  /** Count of declared chat participants / providers (0 when none declared). */
  chatParticipants: number;
  languageModelProviders: number;
  untrustedWorkspaces: string | null;
  extensionKind: string | null;
  enabledApiProposals: string[];
}

const AI_CONTRIB_POINTS = [
  'languageModelChatProviders',
  'chatParticipants',
  'chatAgents',
  'languageModelTools',
  'languageModelToolSets',
  'mcpServerDefinitionProviders',
  'chatSessions',
  'chatSkills',
  'chatPromptFiles',
] as const;

/** Classifies a package.json: does it DECLARE an AI surface, without a name list. */
export function classifyContributes(pkg: {
  contributes?: Record<string, unknown>;
  capabilities?: { untrustedWorkspaces?: { supported?: string } };
  extensionKind?: string | string[];
  enabledApiProposals?: string[];
}): ContribCaps {
  const contributions: string[] = [];
  let chatParticipants = 0;
  let languageModelProviders = 0;
  for (const point of AI_CONTRIB_POINTS) {
    const v = pkg.contributes?.[point];
    if (Array.isArray(v) && v.length) {
      contributions.push(point);
      if (point === 'chatParticipants' || point === 'chatAgents') chatParticipants += v.length;
      if (point === 'languageModelChatProviders') languageModelProviders += v.length;
    }
  }
  return {
    contributions,
    chatParticipants,
    languageModelProviders,
    untrustedWorkspaces: pkg.capabilities?.untrustedWorkspaces?.supported ?? null,
    extensionKind: Array.isArray(pkg.extensionKind) ? pkg.extensionKind.join(',') : (pkg.extensionKind ?? null),
    enabledApiProposals: pkg.enabledApiProposals ?? [],
  };
}

interface ExtensionDir {
  id: string;
  version: string | null;
  dir: string | null;
}

/** Where an editor's extension dir lives: the ~/.vscode-family dotdir, not App Support. */
export function extensionDirForApp(app: string): string | null {
  const candidates: Record<string, string> = {
    code: '.vscode',
    cursor: '.cursor',
    kiro: '.kiro',
    'antigravity-ide': '.antigravity-ide',
  };
  const slugApp = slug(app);
  const names = [candidates[slugApp] ?? `.${slugApp}`, '.vscode'];
  for (const n of names) {
    const dir = join(home(), n, 'extensions');
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Installed extensions: extensions.json ids + on-disk <id>-<version> dirs. */
export function installedExtensions(extDir: string | null): ExtensionDir[] {
  const out = new Map<string, ExtensionDir>();
  if (!extDir) return [];
  const registry = readJson(join(extDir, 'extensions.json')) as
    | { identifier?: { id?: string }; version?: string; location?: { path?: string } }[]
    | null;
  if (Array.isArray(registry)) {
    for (const e of registry) {
      const id = e?.identifier?.id;
      if (!id) continue;
      out.set(id.toLowerCase(), { id: id.toLowerCase(), version: e.version ?? null, dir: e.location?.path ?? null });
    }
  }
  try {
    for (const d of readdirSync(extDir)) {
      const dir = join(extDir, d);
      // Only real extension directories — extensions.json itself lives here too.
      if (!statSync(dir).isDirectory()) continue;
      const m = d.match(/^(.+?)-(\d+\.\d+\.\d+[^/]*)$/);
      const id = (m?.[1] ?? d).toLowerCase();
      // The registry entry wins for id/version, but a registry row without a
      // location gets its package.json dir from disk.
      const prior = out.get(id);
      if (!prior || prior.dir === null) out.set(id, { id, version: prior?.version ?? m?.[2] ?? null, dir });
    }
  } catch {
    /* no extensions dir */
  }
  return [...out.values()];
}

/** Built-in extensions bundled inside installed editor apps (the Copilot case). */
export function builtinExtensionDirs(): { app: string; dir: string }[] {
  const out: { app: string; dir: string }[] = [];
  let apps: string[];
  try {
    apps = readdirSync('/Applications');
  } catch {
    return out;
  }
  for (const app of apps) {
    if (!app.endsWith('.app')) continue;
    const dir = join('/Applications', app, 'Contents', 'Resources', 'app', 'extensions');
    if (existsSync(dir)) out.push({ app: app.replace(/\.app$/, ''), dir });
  }
  return out;
}

// ── Feature 40: model routes chosen inside the editor ────────────────────────

export interface EditorModelSelection {
  model: string;
  selected_on: string[];
  pinned: boolean;
  reasoningEffort: string | null;
  contextSize: string | null;
}

const SELECTION_KEYS = [
  'chatModelRecentlyUsed',
  'chatModelPinned',
  'chatModelVisibility',
  'chat.currentLanguageModel.panel',
  'chat.currentLanguageModel.editor',
  'chat.currentLanguageModel.terminal',
  'chat.currentLanguageModel.editing-session',
];

function parseValue(value: unknown): unknown {
  let v: unknown = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return v; // a bare string model id
    }
  }
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const inner = (v as { value: unknown }).value;
    v = typeof inner === 'string' ? (() => { try { return JSON.parse(inner); } catch { return inner; } })() : inner;
  }
  return v;
}

/** Every model id the editor recorded as selected/pinned/recent, per key. */
export function extractModelSelections(entries: { key: string; value: unknown }[]): EditorModelSelection[] {
  const byModel = new Map<string, EditorModelSelection>();
  const add = (model: string, on: string, pinned = false) => {
    const cur = byModel.get(model) ?? { model, selected_on: [], pinned: false, reasoningEffort: null, contextSize: null };
    if (!cur.selected_on.includes(on)) cur.selected_on.push(on);
    cur.pinned = cur.pinned || pinned;
    byModel.set(model, cur);
  };
  for (const { key, value } of entries) {
    const v = parseValue(value);
    if (key === 'chatModelRecentlyUsed' || key === 'chatModelVisibility' || key === 'chatModelPinned') {
      // Accept a bare string array or {recentlyUsed|visible|pinned:[...]}.
      const list = Array.isArray(v)
        ? v
        : Object.values((v as Record<string, unknown>) ?? {}).find((x) => Array.isArray(x));
      if (Array.isArray(list)) for (const m of list) if (typeof m === 'string') add(m, key, key === 'chatModelPinned');
    } else if (SELECTION_KEYS.includes(key) && typeof v === 'string' && v) {
      add(v, key);
    } else if (key === 'chat.modelConfiguration.panel' && v && typeof v === 'object') {
      for (const [model, cfg] of Object.entries(v as Record<string, { reasoningEffort?: string; contextSize?: string }>)) {
        const cur = byModel.get(model) ?? { model, selected_on: [], pinned: false, reasoningEffort: null, contextSize: null };
        cur.reasoningEffort = cfg?.reasoningEffort ?? cur.reasoningEffort;
        cur.contextSize = cfg?.contextSize ?? cur.contextSize;
        cur.selected_on.push('chat.modelConfiguration.panel');
        byModel.set(model, cur);
      }
    }
  }
  return [...byModel.values()];
}

// ── Feature 42: browser_assistant ────────────────────────────────────────────

export interface BrowserAssistant {
  browser: string;
  profile: string;
  last_invoked_time: number | null;
  used_count: number | null;
  subscription_tier: string | null;
  rollout_eligibility: string | boolean | null;
  compose_button: boolean | null;
}

/** The vendor's own assistant, with a real last-invoked date. */
export function browserAssistants(): BrowserAssistant[] {
  const out: BrowserAssistant[] = [];
  const root = join(home(), 'Library', 'Application Support', 'Google', 'Chrome');
  const localState = readJson(join(root, 'Local State')) as { profile?: { info_cache?: Record<string, unknown> } } | null;
  const profiles = Object.keys(localState?.profile?.info_cache ?? {});
  if (!profiles.length && !existsSync(join(root, 'Default', 'Preferences'))) return out;
  for (const profile of profiles.length ? profiles : ['Default']) {
    const prefs = readJson(join(root, profile, 'Preferences')) as {
      glic?: { last_invoked_time?: number };
      in_product_help?: { new_badge?: Record<string, { used_count?: number }> };
      account_values?: { sync?: { ai_subscription_tier?: string; glic_rollout_eligibility?: string | boolean } };
      ntp?: { compose_button?: boolean };
    } | null;
    if (!prefs) continue;
    const glicBadge = Object.entries(prefs.in_product_help?.new_badge ?? {}).find(([k]) => /glic/i.test(k));
    out.push({
      browser: 'chrome',
      profile,
      last_invoked_time: prefs.glic?.last_invoked_time ?? null,
      used_count: glicBadge?.[1]?.used_count ?? null,
      subscription_tier: prefs.account_values?.sync?.ai_subscription_tier ?? null,
      rollout_eligibility: prefs.account_values?.sync?.glic_rollout_eligibility ?? null,
      compose_button: prefs.ntp?.compose_button ?? null,
    });
  }
  return out;
}

// ── Scanner ──────────────────────────────────────────────────────────────────

function upsertSurface(
  db: DB,
  s: { surface_key: string; kind: string; name: string; path: string | null; evidence: string; version?: string | null; extra?: string | null; identifier?: string | null },
  now: number,
): void {
  db.prepare(`
    INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, identifier, scanner, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'vscode-state', ?, ?)
    ON CONFLICT(surface_key) DO UPDATE SET
      last_seen = excluded.last_seen, evidence = excluded.evidence, extra = excluded.extra`).run(
    s.surface_key, s.kind, s.name, s.path, s.evidence, s.version ?? null, s.extra ?? null, s.identifier ?? null, now, now,
  );
}

export const vscodeStateScanner: Scanner = {
  name: 'vscode-state',
  cadenceMs: 30 * 60_000, // workspace state.vscdb walks are the heaviest read here
  run: () => {
    const db: DB = openDb();
    const now = Date.now();
    let stats = 0;
    let activations = 0;
    let contribs = 0;
    let selections = 0;

    for (const r of editorRoots()) {
      const app = slug(r.app);

      // Feature 5: languageModelStats (sync blob + state.vscdb) and access grants.
      const entries = [
        ...syncStorageEntries(r.root),
        ...itemRows(join(r.root, 'User', 'globalStorage', 'state.vscdb')),
      ];
      const perExt = new Map<string, { models: { model: string; requests: number | null; tokens: number | null }[]; granted: string[] }>();
      for (const { key, value } of entries) {
        for (const s of parseLanguageModelStats(key, value)) {
          const cur = perExt.get(s.extensionId) ?? { models: [], granted: [] };
          cur.models.push({ model: s.model, requests: s.requestCount, tokens: s.tokenCount });
          perExt.set(s.extensionId, cur);
          stats++;
        }
        const access = parseLanguageModelAccess(key, value);
        if (access) {
          for (const extId of access.granted) {
            const cur = perExt.get(extId) ?? { models: [], granted: [] };
            if (!cur.granted.includes(access.model)) cur.granted.push(access.model);
            perExt.set(extId, cur);
          }
        }
      }
      for (const [extId, d] of perExt) {
        const tokens = d.models.reduce((n, m) => n + (m.tokens ?? 0), 0);
        // ponytail: 20 models in extra — same 512-char shape ceiling as above.
        if (d.models.length > 20) d.models.length = 20;
        upsertSurface(db, {
          surface_key: `ide-ext-usage:${app}:${extId}`,
          kind: 'extension',
          name: `${extId} (editor-counted usage)`,
          path: r.root,
          evidence:
            `the editor itself counted ${d.models.length} model(s), ${tokens} token(s) for this extension — ` +
            `a single undifferentiated total: input/output/cache split is not recorded, so cost is NOT computable ` +
            `and every aggregate must carry these rows in its unpriced count (em dash, never $0.00)`,
          extra: JSON.stringify({ models: d.models, access_granted: d.granted }),
        }, now);
      }

      // Feature 6: per-workspace activation.
      const wsByExt = new Map<string, { list: { uri: string | null; not_after: number | null }[]; total: number }>();
      for (const ws of workspaceActivation(r.root)) {
        for (const ext of ws.extensions) {
          const cur = wsByExt.get(ext) ?? { list: [], total: 0 };
          cur.total++;
          // ponytail: 12 workspaces in extra — ai_surfaces.extra is shape-scanned
          // to ≤512 chars (the content boundary); the full reach list needs the
          // dedicated per-workspace table flagged for integration.
          if (cur.list.length < 12) cur.list.push({ uri: ws.uri, not_after: ws.notAfter });
          wsByExt.set(ext, cur);
        }
      }
      for (const [extId, { list, total }] of wsByExt) {
        activations++;
        upsertSurface(db, {
          surface_key: `ws-activation:${app}:${extId}`,
          kind: 'extension',
          name: `${extId} (workspace activation)`,
          path: r.root,
          evidence:
            `activated in ${total} workspace(s) — state proves a view container was materialized there, ` +
            `not that a prompt was sent or a token spent; state.vscdb mtime is the 'not after' date`,
          extra: JSON.stringify({ total, workspaces: list }),
        }, now);
      }

      // Feature 39: contribution points, installed + built-in.
      for (const ext of installedExtensions(extensionDirForApp(r.app))) {
        const pkg = readJson(join(ext.dir ?? '', 'package.json')) as Parameters<typeof classifyContributes>[0] | null;
        if (!pkg) continue;
        const caps = classifyContributes(pkg);
        contribs++;
        upsertSurface(db, {
          surface_key: `ext-contrib:${app}:${ext.id}`,
          kind: 'extension',
          name: ext.id,
          path: ext.dir,
          version: ext.version,
          evidence:
            caps.contributions.length
              ? `declares AI contribution points: ${caps.contributions.join(', ')} — a declaration of intent, not proof of runtime registration; consumers of the API ship no contribution point and stay invisible to this reader`
              : `no AI contribution points declared — not classified as an AI surface by contribution alone`,
          extra: JSON.stringify(caps),
        }, now);
      }
      for (const { app: appDir, dir } of builtinExtensionDirs()) {
        try {
          for (const d of readdirSync(dir)) {
            const pkg = readJson(join(dir, d, 'package.json')) as { publisher?: string; name?: string; version?: string } & Parameters<typeof classifyContributes>[0];
            if (!pkg?.name) continue;
            const id = `${pkg.publisher ?? 'unknown'}.${pkg.name}`.toLowerCase();
            const caps = classifyContributes(pkg);
            if (!caps.contributions.length && !/(copilot|chat|ai|assistant|language)/i.test(id)) continue;
            contribs++;
            upsertSurface(db, {
              surface_key: `ext-contrib:${slug(appDir)}-builtin:${id}`,
              kind: 'extension',
              name: `${id} (built-in)`,
              path: join(dir, d),
              version: pkg.version ?? null,
              evidence: `bundled inside ${appDir}.app — appears in no extensions.json anywhere, yet can hold a populated globalStorage`,
              extra: JSON.stringify(caps),
            }, now);
          }
        } catch {
          /* unreadable builtins dir */
        }
      }

      // Feature 40: models chosen in the picker.
      for (const sel of extractModelSelections(entries)) {
        selections++;
        upsertSurface(db, {
          surface_key: `editor-model:${app}:${sel.model}`,
          kind: 'runtime',
          name: sel.model,
          path: r.root,
          evidence:
            `selected in ${r.app} (${sel.selected_on.join(', ')})${sel.pinned ? ' and pinned' : ''} — selection proves a ` +
            `picker choice, never that a request was sent; usage figures come only from languageModelStats and the ` +
            `two lists do not fully overlap, so a selected model with no counter reads 'selected, usage unread', never zero`,
          identifier: sel.model,
          extra: JSON.stringify(sel),
        }, now);
      }
    }

    // Feature 42: browser_assistant.
    for (const b of browserAssistants()) {
      upsertSurface(db, {
        surface_key: `browser-assistant:${b.browser}:${b.profile}`,
        kind: 'site',
        name: `Chrome assistant (profile ${b.profile})`,
        path: join(home(), 'Library', 'Application Support', 'Google', 'Chrome', b.profile, 'Preferences'),
        evidence:
          `vendor AI inside the browser — navigates to no domain and installs no extension folder, so hostname counts ` +
          `and folder walks both miss it. ` +
          (b.last_invoked_time !== null
            ? `Last invoked ${new Date(b.last_invoked_time).toISOString()} — the last time the panel was opened, not a prompt count.`
            : `No invocation recorded on this profile.`),
        extra: JSON.stringify({
          browser: b.browser,
          profile: b.profile,
          last_invoked_time: b.last_invoked_time,
          used_count: b.used_count, // in-product-help badge counter: saturates, is NOT usage
          subscription_tier: b.subscription_tier,
          rollout_eligibility: b.rollout_eligibility,
          compose_button: b.compose_button,
        }),
      }, now);
    }

    const assistants = browserAssistants().length;
    return {
      ok: true,
      notes:
        `${perExtCount(db)} editor extension-usage row(s) at last pass · ${stats} stat(s) parsed · ` +
        `${activations} activation row(s) · ${contribs} classified extension(s) · ${selections} editor-selected model(s) · ` +
        `${assistants} browser assistant profile(s)`,
    };
  },
};

function perExtCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ai_surfaces WHERE surface_key LIKE 'ide-ext-usage:%'").get() as { n: number }).n;
}

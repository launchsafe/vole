import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { DB } from '../db';
import type { Anomaly } from '../types';
import { dayBucket, globToRegex, sha256hex } from './util';
import { hidingPattern, ignoreMatches, readIgnorePatterns, readTrackedPaths } from './tracked';

/**
 * The envelope (tier 6 §19, §20, §11, §26, §62, §63, §22): the
 * change_risk_class classifier over the file-write ledger (consuming the
 * t5-authority-ledgers output), the escape/visibility joins, the dependency
 * key-set deltas and install hooks from the transcript's own pre/post
 * images, and the review-packet receipt.
 *
 * Content boundary: everything here works on paths, names, shas and counts.
 * The manifest images the classifier reasons over are held in memory only —
 * parsed, diffed as key sets, never stored.
 */

// ── the versioned path pack (change_risk_class, spec §19) ───────────────────

export type ChangeRiskClass =
  | 'env_secret' | 'visibility' | 'lockfile' | 'dependency' | 'permissions'
  | 'ci' | 'container_manifest' | 'agent_config' | 'instructions' | 'source';

/** The classes that widen the security envelope (§11, §20). */
export const ENVELOPE_CLASSES: ChangeRiskClass[] = [
  'env_secret', 'visibility', 'lockfile', 'dependency', 'permissions', 'ci', 'container_manifest', 'agent_config',
];

export interface PathPattern {
  pattern: string;
  class: ChangeRiskClass;
}

export const PATH_PACK_VERSION = 1;

/** Ordered pack: first match wins; no match means NULL (unclassified, counted as its own figure). */
export const BUILTIN_PATH_PACK: PathPattern[] = [
  { pattern: '**/.env', class: 'env_secret' },
  { pattern: '**/.env.*', class: 'env_secret' },
  { pattern: '**/credentials', class: 'env_secret' },
  { pattern: '**/credentials.json', class: 'env_secret' },
  { pattern: '**/*.pem', class: 'env_secret' },
  { pattern: '**/id_rsa', class: 'env_secret' },
  { pattern: '**/id_ed25519', class: 'env_secret' },
  { pattern: '**/.gitignore', class: 'visibility' },
  { pattern: '**/.dockerignore', class: 'visibility' },
  { pattern: '**/.npmignore', class: 'visibility' },
  { pattern: 'package-lock.json', class: 'lockfile' },
  { pattern: '**/package-lock.json', class: 'lockfile' },
  { pattern: 'pnpm-lock.yaml', class: 'lockfile' },
  { pattern: 'yarn.lock', class: 'lockfile' },
  { pattern: 'Cargo.lock', class: 'lockfile' },
  { pattern: 'uv.lock', class: 'lockfile' },
  { pattern: 'poetry.lock', class: 'lockfile' },
  { pattern: 'go.sum', class: 'lockfile' },
  { pattern: 'Gemfile.lock', class: 'lockfile' },
  { pattern: 'package.json', class: 'dependency' },
  { pattern: '**/package.json', class: 'dependency' },
  { pattern: '**/requirements*.txt', class: 'dependency' },
  { pattern: '**/pyproject.toml', class: 'dependency' },
  { pattern: '**/go.mod', class: 'dependency' },
  { pattern: '**/Cargo.toml', class: 'dependency' },
  { pattern: '**/Gemfile', class: 'dependency' },
  { pattern: '.claude/settings.json', class: 'permissions' },
  { pattern: '.claude/settings.local.json', class: 'permissions' },
  { pattern: '.mcp.json', class: 'permissions' },
  { pattern: '.cursor/mcp.json', class: 'permissions' },
  { pattern: '.cursor/hooks', class: 'permissions' },
  { pattern: '.cursor/hooks/*', class: 'permissions' },
  { pattern: '.vscode/settings.json', class: 'permissions' },
  { pattern: '.github/workflows/**', class: 'ci' },
  { pattern: '.gitlab-ci.yml', class: 'ci' },
  { pattern: '.circleci/config.yml', class: 'ci' },
  { pattern: 'Jenkinsfile', class: 'ci' },
  { pattern: '**/Dockerfile', class: 'container_manifest' },
  { pattern: '**/Dockerfile.*', class: 'container_manifest' },
  { pattern: 'compose.yaml', class: 'container_manifest' },
  { pattern: 'docker-compose*.yml', class: 'container_manifest' },
  { pattern: 'docker-compose*.yaml', class: 'container_manifest' },
  { pattern: '.devcontainer/**', class: 'container_manifest' },
  { pattern: '.claude/**', class: 'agent_config' },
  { pattern: '.codex/**', class: 'agent_config' },
  { pattern: '.cursor/**', class: 'agent_config' },
  { pattern: '.continue/**', class: 'agent_config' },
  { pattern: '.gemini/**', class: 'agent_config' },
  { pattern: '.clinerules', class: 'agent_config' },
  { pattern: '.roomodes', class: 'agent_config' },
  { pattern: '.cursorrules', class: 'agent_config' },
  { pattern: '**/CLAUDE.md', class: 'instructions' },
  { pattern: '**/AGENTS.md', class: 'instructions' },
  { pattern: '**/GEMINI.md', class: 'instructions' },
  { pattern: '.github/copilot-instructions.md', class: 'instructions' },
  { pattern: '**/*.ts', class: 'source' },
  { pattern: '**/*.tsx', class: 'source' },
  { pattern: '**/*.js', class: 'source' },
  { pattern: '**/*.jsx', class: 'source' },
  { pattern: '**/*.mjs', class: 'source' },
  { pattern: '**/*.py', class: 'source' },
  { pattern: '**/*.go', class: 'source' },
  { pattern: '**/*.rs', class: 'source' },
  { pattern: '**/*.rb', class: 'source' },
  { pattern: '**/*.java', class: 'source' },
  { pattern: '**/*.swift', class: 'source' },
  { pattern: '**/*.sql', class: 'source' },
  { pattern: '**/*.sh', class: 'source' },
];

const PACK_REGEX = BUILTIN_PATH_PACK.map((p) => ({ ...p, re: globToRegex(p.pattern) }));

export interface Classified {
  change_risk_class: ChangeRiskClass;
  class_pattern_id: string;
}

/** Classify one path. NULL-equivalent (null) means unclassified, never 'other'. */
export function classifyPath(path: string): Classified | null {
  const base = path.split('/').slice(-2).join('/'); // match root-anchored patterns at any depth
  for (const p of PACK_REGEX) {
    if (p.re.test(path) || p.re.test(base)) {
      return { change_risk_class: p.class, class_pattern_id: sha256hex(p.pattern) };
    }
  }
  return null;
}

/** Register the builtin pack in path_classes (idempotent, versioned). */
export function ensurePathPack(db: DB, now: number): void {
  const upsert = db.prepare(
    `INSERT INTO path_classes (pattern_id, pack_version, class, pattern, first_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pattern_id, pack_version) DO NOTHING`,
  );
  for (const p of BUILTIN_PATH_PACK) upsert.run(sha256hex(p.pattern), PATH_PACK_VERSION, p.class, p.pattern, now);
}

/**
 * Classify the file-write ledger (§19): NULL-only widening of change_risk_class,
 * class_pattern_id, content_rev and visibility_class. Visibility is computed
 * from the containing repo's root-level ignore rules — 'ignored', 'visible',
 * or NULL when no repo root is determinable.
 */
export function classifyFileWrites(db: DB, now: number): { classified: number; visibility: number } {
  ensurePathPack(db, now);
  const rows = db
    .prepare(`SELECT write_key, path FROM file_writes WHERE change_risk_class IS NULL AND path IS NOT NULL`)
    .all() as { write_key: string; path: string }[];
  const updClass = db.prepare(
    `UPDATE file_writes SET change_risk_class = ?, class_pattern_id = ?, content_rev = ? WHERE write_key = ? AND change_risk_class IS NULL`,
  );
  const updVis = db.prepare(
    `UPDATE file_writes SET visibility_class = ? WHERE write_key = ? AND visibility_class IS NULL`,
  );
  const visRows = db
    .prepare(`SELECT write_key, path FROM file_writes WHERE visibility_class IS NULL AND path IS NOT NULL`)
    .all() as { write_key: string; path: string }[];
  let classified = 0;
  let visCount = 0;
  const ignoreCache = new Map<string, ReturnType<typeof readIgnorePatterns>>();
  const rootCache = new Map<string, string | null>();
  const rootOf = (p: string): string | null => {
    if (rootCache.has(p)) return rootCache.get(p)!;
    let cur = dirname(p);
    let root: string | null = null;
    for (;;) {
      if (existsSync(join(cur, '.git'))) {
        root = cur;
        break;
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    rootCache.set(p, root);
    return root;
  };
  for (const r of rows) {
    const c = classifyPath(r.path);
    if (!c) continue;
    if (updClass.run(c.change_risk_class, c.class_pattern_id, PATH_PACK_VERSION, r.write_key).changes > 0) classified++;
  }
  for (const r of visRows) {
    const root = rootOf(r.path);
    if (!root) continue; // no repo: visibility is unknown, stays NULL
    if (!ignoreCache.has(root)) ignoreCache.set(root, readIgnorePatterns(root));
    const patterns = ignoreCache.get(root)!;
    const rel = r.path.startsWith(`${root}/`) ? r.path.slice(root.length + 1) : r.path;
    const hiding = hidingPattern(rel, patterns);
    updVis.run(hiding ? 'ignored' : 'visible', r.write_key);
    visCount++;
  }
  return { classified, visibility: visCount };
}

// ── pre/post image reconstruction (§62, §63, §26) ────────────────────────────

export interface EditImage {
  filePath: string;
  sessionId: string | null;
  ts: number | null;
  /** Claude toolUseResult.originalFile — the pre-image */
  originalFile?: string | null;
  oldString?: string | null;
  newString?: string | null;
  /** create/new-file writes carry the full content */
  content?: string | null;
  replaceAll?: boolean | null;
  toolCallKey?: string | null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The post-image: apply the edit to the pre-image, or the created content. */
export function postImage(e: EditImage): string | null {
  if (typeof e.content === 'string') return e.content;
  if (typeof e.originalFile !== 'string' || typeof e.oldString !== 'string') return null;
  if (e.oldString === '') return e.originalFile + (e.newString ?? '');
  const re = new RegExp(escapeRe(e.oldString), e.replaceAll ? 'g' : '');
  return e.originalFile.replace(re, e.newString ?? '');
}

/** Added ignore patterns from a pre/post pair of an ignore-family file. */
export function ignorePatternDelta(pre: string, post: string): string[] {
  const parse = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  const before = new Set(parse(pre));
  return parse(post).filter((p) => !before.has(p));
}

// ── dependency key-set deltas (§62) ──────────────────────────────────────────

export interface DependencyDelta {
  ecosystem: 'npm' | 'pip' | 'pyproject' | 'go' | 'cargo' | 'gem';
  name: string;
  section: string;
  oldSpec: string | null;
  newSpec: string | null;
  verb: 'added' | 'removed' | 'changed';
  /** parse_failed marker: the row records it and no name is guessed */
  parseFailed?: false;
}

export interface ParseFailure {
  parseFailed: true;
  ecosystem: string;
  manifestPath: string;
}

type ManifestParse = { sections: Map<string, Map<string, string>> } | null;

function parsePackageJson(text: string): ManifestParse {
  try {
    const doc = JSON.parse(text) as Record<string, Record<string, string>>;
    const sections = new Map<string, Map<string, string>>();
    for (const sec of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies']) {
      if (doc[sec] && typeof doc[sec] === 'object') {
        sections.set(sec, new Map(Object.entries(doc[sec]!).map(([k, v]) => [k, String(v)])));
      }
    }
    return { sections };
  } catch {
    return null;
  }
}

function parseRequirements(text: string): ManifestParse {
  const deps = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*(?:[=><~!]+\s*(\S+))?/.exec(line);
    if (m) deps.set(m[1]!.toLowerCase(), m[2] ?? '');
  }
  return { sections: new Map([['requirements', deps]]) };
}

// ponytail: TOML/Gemfile parsing is a shaped subset (section headers + quoted
// values). Full grammar not needed — key-set deltas survive the subset.
function parseShapedManifest(text: string, kind: 'pyproject' | 'cargo' | 'gem'): ManifestParse {
  const sections = new Map<string, Map<string, string>>();
  let section = '';
  let inArray = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!;
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    if (kind === 'gem') {
      const g = /^gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/.exec(line);
      if (g) sections.get(section)!.set(g[1]!, g[2] ?? '');
      continue;
    }
    if (kind === 'pyproject') {
      if (line.startsWith('dependencies') || line.startsWith('["')) {
        inArray = true;
        continue;
      }
      if (inArray) {
        const item = /^['"]([^'"=><~!\s]+)\s*([=><~!].*)?['"]$/.exec(line.replace(/,$/, '').trim());
        if (item) sections.get(section)!.set(item[1]!.toLowerCase(), item[2]?.trim() ?? '');
        if (!line.endsWith(',')) inArray = false;
        continue;
      }
      const kv = /^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']*)["']/.exec(line);
      if (kv && section) sections.get(section)!.set(kv[1]!, kv[2]!);
      continue;
    }
    // cargo: name = "1.2" or { version = "1.2" }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|\{\s*version\s*=\s*"([^"]*)")/.exec(line);
    if (kv && section) sections.get(section)!.set(kv[1]!, kv[2] ?? kv[3] ?? '');
  }
  return { sections };
}

function parseGoMod(text: string): ManifestParse {
  const deps = new Map<string, string>();
  let inRequire = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('require (')) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ')') {
      inRequire = false;
      continue;
    }
    const single = /^require\s+(\S+)\s+(\S+)/.exec(line);
    if (single) {
      deps.set(single[1]!, single[2]!);
      continue;
    }
    if (inRequire) {
      const m = /^(\S+)\s+(\S+)/.exec(line);
      if (m) deps.set(m[1]!, m[2]!);
    }
  }
  return { sections: new Map([['require', deps]]) };
}

function manifestKind(path: string): { kind: 'npm' | 'pip' | 'pyproject' | 'go' | 'cargo' | 'gem' } | null {
  const base = path.split('/').pop() ?? '';
  if (base === 'package.json') return { kind: 'npm' };
  if (/^requirements.*\.txt$/.test(base)) return { kind: 'pip' };
  if (base === 'pyproject.toml') return { kind: 'pyproject' };
  if (base === 'go.mod') return { kind: 'go' };
  if (base === 'Cargo.toml') return { kind: 'cargo' };
  if (base === 'Gemfile') return { kind: 'gem' };
  return null;
}

function parseManifest(path: string, text: string): { kind: 'npm' | 'pip' | 'pyproject' | 'go' | 'cargo' | 'gem'; parsed: ManifestParse } {
  const kind = manifestKind(path);
  if (!kind) return { kind: 'npm', parsed: null };
  let parsed: ManifestParse = null;
  if (kind.kind === 'npm') parsed = parsePackageJson(text);
  else if (kind.kind === 'pip') parsed = parseRequirements(text);
  else if (kind.kind === 'go') parsed = parseGoMod(text);
  else parsed = parseShapedManifest(text, kind.kind);
  return { kind: kind.kind, parsed };
}

/** The exact key-set delta between two manifest images. If either image fails to parse, the row records parse_failed — no name is guessed. */
export function dependencyDeltas(e: EditImage): DependencyDelta[] | ParseFailure {
  const pre = e.originalFile;
  const post = postImage(e);
  const kind = manifestKind(e.filePath);
  if (!kind) return { parseFailed: true, ecosystem: 'unknown', manifestPath: e.filePath };
  if (typeof pre !== 'string' || post === null) return { parseFailed: true, ecosystem: kind.kind, manifestPath: e.filePath };
  const a = parseManifest(e.filePath, pre);
  const b = parseManifest(e.filePath, post);
  if (!a.parsed || !b.parsed) return { parseFailed: true, ecosystem: kind.kind, manifestPath: e.filePath };
  const out: DependencyDelta[] = [];
  const allSections = new Set([...a.parsed.sections.keys(), ...b.parsed.sections.keys()]);
  for (const sec of allSections) {
    const before = a.parsed.sections.get(sec) ?? new Map();
    const after = b.parsed.sections.get(sec) ?? new Map();
    for (const [name, spec] of after) {
      if (!before.has(name)) out.push({ ecosystem: kind.kind, name, section: sec, oldSpec: null, newSpec: spec, verb: 'added' });
      else if (before.get(name) !== spec) out.push({ ecosystem: kind.kind, name, section: sec, oldSpec: before.get(name)!, newSpec: spec, verb: 'changed' });
    }
    for (const [name, spec] of before) {
      if (!after.has(name)) out.push({ ecosystem: kind.kind, name, section: sec, oldSpec: spec, newSpec: null, verb: 'removed' });
    }
  }
  return out;
}

// ── install-time hooks (§63) ─────────────────────────────────────────────────

const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack'];

export interface InstallHook {
  /** the manifest key that executes at install time */
  key: string;
  /** sha256 of the command string — never the command text */
  commandSha256: string;
  /** the command-shape skeleton id (round 2's vocabulary) */
  skeleton: string;
  filePath: string;
}

export function installHooksFromEdit(e: EditImage): InstallHook[] {
  const post = postImage(e);
  if (post === null) return [];
  const postDoc = (() => {
    try {
      return JSON.parse(post) as Record<string, { scripts?: Record<string, string> }>;
    } catch {
      return null;
    }
  })();
  const preDoc = (() => {
    try {
      return JSON.parse(e.originalFile ?? '{}') as Record<string, { scripts?: Record<string, string> }>;
    } catch {
      return null;
    }
  })();
  if (!postDoc) return [];
  const out: InstallHook[] = [];
  const scripts = postDoc.scripts ?? {};
  const preScriptsMap = preDoc?.scripts ?? {};
  for (const key of INSTALL_SCRIPT_KEYS) {
    const cmd = scripts[key];
    if (typeof cmd !== 'string') continue;
    if (preScriptsMap[key] === cmd) continue; // unchanged wiring is not a plant
    out.push({
      key: `scripts.${key}`,
      commandSha256: sha256hex(cmd),
      skeleton: skeletonOf(cmd),
      filePath: e.filePath,
    });
  }
  return out;
}

/** Minimal command skeleton (structure, never content) for hook rows. */
function skeletonOf(cmd: string): string {
  const head = cmd.trim().split(/\s+/)[0] ?? '';
  return head ? (['node', 'sh', 'bash', 'curl', 'npx'].includes(head) ? head : 'other') : 'empty';
}

/** install_hook_added: critical by default — the exact rung s1ngularity used. */
export function installHookAnomaly(e: EditImage, hook: InstallHook, now: number): Anomaly {
  return {
    anomaly_key: `install_hook_added:${sha256hex(`${e.sessionId ?? ''}|${e.filePath}|${hook.key}|${hook.commandSha256}`)}`,
    rule: 'install_hook_added' as const,
    severity: 'critical' as const,
    tool: 'claude_code' as const,
    session_id: e.sessionId,
    model: null,
    window_start: e.ts ?? now,
    window_end: e.ts ?? now,
    title: `Install-time script planted: ${hook.key}`,
    detail:
      `An install-time entry point (${hook.key}) was added to ${e.filePath} — command skeleton ` +
      `"${hook.skeleton}", command sha256 ${hook.commandSha256}. It states that an install-time entry ` +
      `point was added and by whom, never that it is malicious. It runs on every teammate's install ` +
      `without anyone opening the file. The editor, npm pkg set, and dependency tarballs are outside this view.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  };
}

// ── escape_state join + envelope_change_escaped (§20) ───────────────────────

/**
 * Widen file_writes.escape_state from the VCS action ledger inside the same
 * session: 'pushed' wins over 'committed' (the max evidence). NULL-only.
 */
export function joinEscapeState(db: DB, now: number): { widened: number } {
  const rows = db
    .prepare(
      `SELECT f.write_key, v.escape_state FROM file_writes f
       JOIN tool_calls tc ON tc.session_id = f.session_id
       JOIN vcs_actions v ON v.call_key = tc.tool_call_key
       WHERE f.change_risk_class IS NOT NULL AND v.escape_state IN ('committed', 'pushed')
       ORDER BY CASE v.escape_state WHEN 'pushed' THEN 1 ELSE 0 END`,
    )
    .all() as { write_key: string; escape_state: string }[];
  const upd = db.prepare(`UPDATE file_writes SET escape_state = ? WHERE write_key = ? AND escape_state IS NULL`);
  let widened = 0;
  const seen = new Map<string, string>();
  for (const r of rows) {
    const cur = seen.get(r.write_key);
    if (cur === 'pushed') continue;
    seen.set(r.write_key, r.escape_state);
  }
  for (const [writeKey, state] of seen) {
    widened += upd.run(state, writeKey).changes;
  }
  void now;
  return { widened };
}

export interface EscapedRow {
  write_key: string;
  session_id: string | null;
  path: string | null;
  change_risk_class: string | null;
  escape_state: string | null;
  verb: string | null;
  repo: string | null;
  push_evidence: string | null;
}

/** envelope_change_escaped (§20): did the widening leave the laptop. */
export function detectEnvelopeChangeEscaped(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT f.write_key, f.session_id, f.path, f.change_risk_class, f.escape_state, f.ts,
              v.verb, v.repo, v.push_evidence
       FROM file_writes f
       JOIN tool_calls tc ON tc.session_id = f.session_id
       JOIN vcs_actions v ON v.call_key = tc.tool_call_key
       WHERE f.change_risk_class IN (${ENVELOPE_CLASSES.map((c) => `'${c}'`).join(',')})
         AND v.escape_state IN ('committed', 'pushed')`,
    )
    .all() as (EscapedRow & { ts: number | null })[];
  const best = new Map<string, EscapedRow & { ts: number | null }>();
  for (const r of rows) {
    const cur = best.get(r.write_key);
    if (!cur || (cur.escape_state !== 'pushed' && r.escape_state === 'pushed')) best.set(r.write_key, r);
  }
  return [...best.values()].map((r) => ({
    anomaly_key: `envelope_change_escaped:${r.write_key}`,
    rule: 'envelope_change_escaped' as const,
    severity: r.escape_state === 'pushed' ? ('critical' as const) : ('warn' as const),
    tool: 'claude_code' as const,
    session_id: r.session_id,
    model: null,
    window_start: r.ts ?? now,
    window_end: r.ts ?? now,
    title: `Envelope change ${r.escape_state}: ${r.path ?? r.write_key}`,
    detail:
      `A ${r.change_risk_class} write reached the ${r.escape_state} state in session ` +
      `${r.session_id?.slice(0, 8) ?? 'unknown'} (verb ${r.verb ?? 'unknown'}, repo ${r.repo ?? 'unknown'}, ` +
      `push evidence ${r.push_evidence ?? 'none'}). Escape state is provenance (gitOperation / command_shape), ` +
      `never a confidence value. The branch and short sha belong on the incident card.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

// ── write_then_hide (§26) ─────────────────────────────────────────────────────

export interface PatternDelta {
  sessionId: string | null;
  filePath: string; // the ignore-family file written
  addedPatterns: string[];
  ts: number | null;
}

export interface WriteThenHideOpts {
  /** collector-supplied pattern deltas from pre/post images (the exact key-set delta) */
  patternDeltas?: PatternDelta[];
}

/**
 * write_then_hide fires in exactly two shapes (§26):
 *  A) a path the same session wrote is matched by a pattern the same session
 *     added (from the pattern delta);
 *  B) the added pattern covers a path already present in tracked_state from
 *     .git/index.
 * The bare visibility class stays info; only the join fires. A file hidden by
 * a pattern that was already there, or hidden by a human, is invisible to the
 * rule (spec limit).
 */
export function detectWriteThenHide(db: DB, now: number, opts: WriteThenHideOpts = {}): Anomaly[] {
  const out: Anomaly[] = [];
  const writes = db
    .prepare(`SELECT session_id, path FROM file_writes WHERE path IS NOT NULL`)
    .all() as { session_id: string | null; path: string }[];
  const trackedCache = new Map<string, Set<string>>();
  const trackedFor = (root: string): Set<string> => {
    if (!trackedCache.has(root)) trackedCache.set(root, readTrackedPaths(root).paths);
    return trackedCache.get(root)!;
  };
  for (const delta of opts.patternDeltas ?? []) {
    const root = rootOfPath(delta.filePath);
    const rel = root && delta.filePath.startsWith(`${root}/`) ? delta.filePath.slice(root.length + 1) : delta.filePath;
    const ignored = /\.(git|docker|npm)ignore$/.test(delta.filePath) || /(^|\/)\.git\/info\/exclude$/.test(delta.filePath);
    if (!ignored) continue;
    // Shape A: the same session wrote a path matched by an added pattern.
    const sessionWrites = writes.filter((w) => w.session_id === delta.sessionId && w.path !== delta.filePath);
    for (const w of sessionWrites) {
      const wRoot = rootOfPath(w.path);
      if (!wRoot || wRoot !== root) continue;
      const wRel = w.path.slice(wRoot.length + 1);
      const hit = delta.addedPatterns.find((p) => ignoreMatches(wRel, p));
      if (hit) {
        out.push(hideAnomaly(delta.sessionId, w.path, hit, delta.filePath, now, delta.ts));
      }
    }
    // Shape B: the added pattern covers a tracked_state path.
    if (root) {
      const tracked = trackedFor(root);
      for (const t of tracked) {
        const hit = delta.addedPatterns.find((p) => ignoreMatches(t, p));
        if (hit) {
          out.push(hideAnomaly(delta.sessionId, join(root, t), hit, delta.filePath, now, delta.ts));
          break; // one incident per delta is enough for the pattern set
        }
      }
    }
  }
  return out;
}

// local alias to avoid importing the whole tracked matcher under another name

function rootOfPath(p: string): string | null {
  let cur = dirname(p);
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function hideAnomaly(
  sessionId: string | null,
  hiddenPath: string,
  pattern: string,
  ignoreFile: string,
  now: number,
  ts: number | null,
): Anomaly {
  return {
    anomaly_key: `write_then_hide:${sha256hex(`${sessionId ?? ''}|${ignoreFile}|${pattern}|${hiddenPath}`)}`,
    rule: 'write_then_hide' as const,
    severity: 'warn' as const,
    tool: 'claude_code' as const,
    session_id: sessionId,
    model: null,
    window_start: ts ?? now,
    window_end: ts ?? now,
    title: `Change made unreviewable: ${hiddenPath}`,
    detail:
      `A path this session wrote is now matched by the pattern "${pattern}" added by the same session to ` +
      `${ignoreFile}. Adding build output to an ignore file is overwhelmingly the honest case — which is why ` +
      `the bare class stays info and only this join fires. A pattern that was already there, or a hidden ` +
      `change made by a human, is invisible to this rule.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  };
}

// ── security_envelope_changed (§11) ─────────────────────────────────────────

const MODE_RANK: Record<string, number> = { default: 0, acceptEdits: 1, plan: 0, auto: 1, bypassPermissions: 3 };

/**
 * One rule over the classified rows, scored by who authorised the change,
 * not how many changes there are: info under an explicit grant in `default`
 * mode, warn under acceptEdits/auto, critical under bypassPermissions, and a
 * NULL posture degrades to warn — never defaulted to 'default'.
 */
export function detectSecurityEnvelopeChanged(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT f.write_key, f.session_id, f.path, f.change_risk_class, f.ts, f.tool_call_key,
              a.autonomy, a.permission_profile, tc.authorization_basis,
              MAX(CASE a.autonomy WHEN 'bypassPermissions' THEN 3 WHEN 'auto' THEN 1 WHEN 'acceptEdits' THEN 1 ELSE 0 END) AS mode_rank
       FROM file_writes f
       LEFT JOIN autonomy_intervals a
         ON a.session_id = f.session_id AND f.ts >= a.started_at AND f.ts <= a.ended_at
       LEFT JOIN tool_calls tc ON tc.tool_call_key = f.tool_call_key
       WHERE f.change_risk_class IN (${ENVELOPE_CLASSES.map((c) => `'${c}'`).join(',')})
       GROUP BY f.write_key`,
    )
    .all() as {
    write_key: string; session_id: string | null; path: string | null; change_risk_class: string;
    ts: number | null; autonomy: string | null; permission_profile: string | null;
    authorization_basis: string | null; mode_rank: number | null;
  }[];
  const byKey = new Map<string, { session_id: string | null; class: string; day: number; ts: number; mode: string | null; auth: string | null; n: number; paths: Set<string> }>();
  for (const r of rows) {
    if (r.ts === null) continue;
    const mode = r.autonomy ?? r.permission_profile ?? null;
    const key = `security_envelope_changed:${r.session_id ?? 'unknown'}:${r.change_risk_class}:${dayBucket(r.ts)}`;
    const cur = byKey.get(key) ?? {
      session_id: r.session_id, class: r.change_risk_class, day: dayBucket(r.ts), ts: r.ts,
      mode, auth: r.authorization_basis, n: 0, paths: new Set<string>(),
    };
    cur.n++;
    if (r.path) cur.paths.add(r.path);
    // keep the most permissive covering interval for the group
    const curRank = cur.mode ? MODE_RANK[cur.mode] ?? 0 : -1;
    const rRank = mode ? MODE_RANK[mode] ?? 0 : -1;
    if (rRank > curRank) cur.mode = mode;
    byKey.set(key, cur);
  }
  return [...byKey.entries()].map(([key, g]) => {
    let severity: 'info' | 'warn' | 'critical';
    let posture: string;
    if (g.mode === null) {
      severity = 'warn'; // NULL posture degrades the rule to warn (spec §11 limit)
      posture = 'no covering interval — posture at the instant of the write is unknown';
    } else if (g.mode === 'bypassPermissions') {
      severity = 'critical';
      posture = 'bypassPermissions posture';
    } else if (g.mode === 'acceptEdits' || g.mode === 'auto') {
      severity = 'warn';
      posture = `${g.mode} posture`;
    } else {
      severity = 'info';
      posture = `${g.mode} posture`;
    }
    if (severity === 'info' && g.auth === 'pre_authorised') posture += ' under an explicit grant';
    return {
      anomaly_key: key,
      rule: 'security_envelope_changed' as const,
      severity,
      tool: 'claude_code' as const,
      session_id: g.session_id,
      model: null,
      window_start: g.day * 86_400_000,
      window_end: g.ts,
      title: `Security envelope changed under ${g.mode ?? 'unknown posture'}: ${g.class}`,
      detail:
        `${g.n} ${g.class} write(s) in session ${g.session_id?.slice(0, 8) ?? 'unknown'} (${[...g.paths].slice(0, 3).join(', ')}` +
        `${g.paths.size > 3 ? `, +${g.paths.size - 3} more` : ''}) — scored by who authorised the change ` +
        `(${posture}), not by how many changes there were. authorization_basis: ${g.auth ?? 'no record'}.`,
      observed: g.n,
      baseline: null,
      threshold: null,
      confidence: 'exact' as const,
      source: 'live' as const,
      detected_at: now,
    };
  });
}

// ── the envelope receipt / review packet (§22) ───────────────────────────────

export interface EnvelopeReceipt {
  sessionId: string | null;
  byClass: { change_risk_class: string; n: number }[];
  unclassified: number;
  escapes: { committed: number; pushed: number; local_only: number; unknown: number };
  hidden: { ignored: number; visible: number; unknown: number };
  securityIncidents: number;
  /** dependency deltas ride the receipt when the collector records them (dependency_deltas table is a foundation gap) */
  dependencyDeltas: DependencyDelta[];
  sentence: string;
}

/**
 * The v_envelope_changes equivalent (the view itself is a foundation gap —
 * flagged): one receipt per session (or the whole store) feeding the review
 * packet, with unclassified rows printed as their own count rather than
 * folded into zero.
 */
export function envelopeReceipt(db: DB, sessionId: string | null = null, deltas: DependencyDelta[] = []): EnvelopeReceipt {
  const args = sessionId ? [sessionId] : [];
  const where = sessionId ? 'WHERE session_id = ?' : '';
  const andWhere = sessionId ? 'WHERE session_id = ? AND' : 'WHERE';
  const byClass = db
    .prepare(`SELECT change_risk_class, COUNT(*) AS n FROM file_writes ${where} GROUP BY change_risk_class ORDER BY n DESC`)
    .all(...args) as { change_risk_class: string; n: number }[];
  const unclassified = (
    db.prepare(`SELECT COUNT(*) AS n FROM file_writes ${andWhere} change_risk_class IS NULL`).all(...args) as { n: number }[]
  )[0]!.n;
  const esc = (
    db.prepare(
      `SELECT
         SUM(CASE escape_state WHEN 'committed' THEN 1 ELSE 0 END) AS committed,
         SUM(CASE escape_state WHEN 'pushed' THEN 1 ELSE 0 END) AS pushed,
         SUM(CASE WHEN escape_state IS NULL AND change_risk_class IS NOT NULL THEN 1 ELSE 0 END) AS unknown
       FROM file_writes ${where}`,
    ).all(...args) as { committed: number | null; pushed: number | null; unknown: number | null }[]
  )[0]!;
  const hid = (
    db.prepare(
      `SELECT
         SUM(CASE visibility_class WHEN 'ignored' THEN 1 ELSE 0 END) AS ignored,
         SUM(CASE visibility_class WHEN 'visible' THEN 1 ELSE 0 END) AS visible,
         SUM(CASE WHEN visibility_class IS NULL THEN 1 ELSE 0 END) AS unknown
       FROM file_writes ${where}`,
    ).all(...args) as { ignored: number | null; visible: number | null; unknown: number | null }[]
  )[0]!;
  const incidents = (
    db.prepare(`SELECT COUNT(*) AS n FROM anomalies ${andWhere} rule = 'security_envelope_changed'`)
    .all(...args) as { n: number }[]
  )[0]!.n;
  const total = byClass.reduce((n, c) => n + c.n, 0);
  const sentence =
    `${total} envelope writes in ${byClass.length} class(es)` +
    `; ${esc.pushed ?? 0} pushed, ${esc.committed ?? 0} committed and left the laptop` +
    `; ${hid.ignored ?? 0} hidden from review` +
    `; ${unclassified} unclassified (agents that record no write target render as an unmonitored denominator, never as 'no envelope changes')`;
  return {
    sessionId,
    byClass,
    unclassified,
    escapes: { committed: esc.committed ?? 0, pushed: esc.pushed ?? 0, local_only: 0, unknown: esc.unknown ?? 0 },
    hidden: { ignored: hid.ignored ?? 0, visible: hid.visible ?? 0, unknown: hid.unknown ?? 0 },
    securityIncidents: incidents,
    dependencyDeltas: deltas,
    sentence,
  };
}

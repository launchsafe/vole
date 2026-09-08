import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from '../db';
import { openDb } from '../db';
import type { Scanner } from '../db';

/**
 * ai_dependencies (tier 2): the installed SDK tree under consented repo roots —
 * code that calls a model directly, with no agent, no log and no console row.
 * Declared (package.json / requirements / pyproject / go.mod / Cargo.toml) and
 * installed (node_modules/.package-lock.json, site-packages dist-info, uv.lock /
 * poetry.lock) are stored as SEPARATE bindings so 'declared 1.2, installed 1.4'
 * is a queryable drift, not a merged guess.
 *
 * A dependency is not a call: these rows cannot know whether the code ran, which
 * key it used, or how many tokens it spent — every usage column stays absent.
 */

/** Model-calling SDK families. A name match, never a fuzzy guess. */
const AI_SDK_NAME = /^(openai|anthropic|@anthropic-ai\/[a-z0-9-]+|google-genai|@google\/generative-ai|@google\/ai|cohere|mistralai|litellm|langchain|@langchain\/[a-z0-9-]+|langchain-[a-z0-9-]+|llama-index|llama-index-core|llamaindex|ollama|together|groq|openrouter|deepseek|ai|@ai-sdk\/[a-z0-9-]+|vertexai|google-cloud-aiplatform|boto3-bedrock?|tiktoken)$/i;

export interface DepBinding {
  dep_key: string;
  name: string;
  kind: string; // npm | pip | go | cargo
  source: string; // declared | installed
  path: string; // the file the binding was read from
  version: string | null;
}

function parseJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** package.json: dependencies + devDependencies → declared bindings. */
export function declaredFromPackageJson(root: string): DepBinding[] {
  const file = join(root, 'package.json');
  const pkg = parseJson(file);
  if (!pkg) return [];
  const out: DepBinding[] = [];
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = pkg[section] as Record<string, string> | undefined;
    for (const [name, spec] of Object.entries(deps ?? {})) {
      if (!AI_SDK_NAME.test(name)) continue;
      out.push({
        dep_key: `dep:${root}:package.json:${name}`,
        name, kind: 'npm', source: 'declared', path: file, version: spec,
      });
    }
  }
  return out;
}

/** node_modules/.package-lock.json: the RESOLVED versions — what actually runs. */
export function installedFromNodeModulesLock(root: string): DepBinding[] {
  const file = join(root, 'node_modules', '.package-lock.json');
  const lock = parseJson(file);
  const packages = (lock?.packages ?? {}) as Record<string, { version?: string }>;
  const out: DepBinding[] = [];
  for (const [key, meta] of Object.entries(packages)) {
    // Keys are "node_modules/openai" / "node_modules/@scope/x"; the root "" is the repo itself.
    const name = key.replace(/^node_modules\//, '');
    if (!key.startsWith('node_modules/') || !AI_SDK_NAME.test(name)) continue;
    out.push({
      dep_key: `dep:${root}:node_modules:${name}`,
      name, kind: 'npm', source: 'installed', path: file, version: meta.version ?? null,
    });
  }
  return out;
}

/** requirements.txt / pyproject dependencies → declared pip bindings. */
export function declaredFromPython(root: string): DepBinding[] {
  const out: DepBinding[] = [];
  const req = join(root, 'requirements.txt');
  if (existsSync(req)) {
    for (const line of readFileSync(req, 'utf8').split('\n')) {
      const m = line.trim().match(/^([A-Za-z0-9_.-]+)\s*==\s*([^\s;#]+)/);
      if (m && AI_SDK_NAME.test(m[1]!)) {
        out.push({ dep_key: `dep:${root}:requirements.txt:${m[1]}`, name: m[1]!, kind: 'pip', source: 'declared', path: req, version: m[2]! });
      }
    }
  }
  const pyproject = join(root, 'pyproject.toml');
  if (existsSync(pyproject)) {
    for (const line of readFileSync(pyproject, 'utf8').split('\n')) {
      const m = line.trim().match(/^"?([A-Za-z0-9_.-]+)"?\s*[=<>~!]/);
      if (m && AI_SDK_NAME.test(m[1]!)) {
        const vm = line.match(/([0-9][0-9a-zA-Z.*-]*)\s*"?$/);
        out.push({ dep_key: `dep:${root}:pyproject.toml:${m[1]}`, name: m[1]!, kind: 'pip', source: 'declared', path: pyproject, version: vm?.[1] ?? null });
      }
    }
  }
  return out;
}

/**
 * site-packages *.dist-info directory names → installed pip bindings.
 * ponytail: only the conventional venv roots (<root>/{venv,.venv,env}) and the
 * pipx tree are probed; a venv at an arbitrary path is invisible until this
 * list grows.
 */
export function installedFromSitePackages(root: string): DepBinding[] {
  const out: DepBinding[] = [];
  const bases = [join(root, 'venv'), join(root, '.venv'), join(root, 'env')];
  for (const base of bases) {
    const lib = join(base, 'lib');
    if (!existsSync(lib)) continue;
    for (const py of readdirSafe(lib)) {
      const sp = join(lib, py, 'site-packages');
      for (const d of distInfoIn(sp)) {
        out.push({ dep_key: `dep:${root}:site-packages:${d.name}`, name: d.name, kind: 'pip', source: 'installed', path: sp, version: d.version });
      }
    }
  }
  return out;
}

/** *.dist-info directory names in one site-packages dir → name + version. */
function distInfoIn(sitePackages: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  for (const d of readdirSafe(sitePackages)) {
    const m = d.match(/^(.+)-([0-9][^-]*)\.dist-info$/);
    if (m && AI_SDK_NAME.test(m[1]!)) out.push({ name: m[1]!, version: m[2]! });
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

/** go.mod require lines → declared go bindings. */
export function declaredFromGoMod(root: string): DepBinding[] {
  const file = join(root, 'go.mod');
  if (!existsSync(file)) return [];
  const out: DepBinding[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.trim().match(/^(?:require\s+)?([A-Za-z0-9./-]+)\s+v([0-9][^\s]+)/);
    if (m && AI_SDK_NAME.test(m[1]!.split('/').pop() ?? '')) {
      out.push({ dep_key: `dep:${root}:go.mod:${m[1]}`, name: m[1]!, kind: 'go', source: 'declared', path: file, version: `v${m[2]}` });
    }
  }
  return out;
}

/** Cargo.toml [dependencies] → declared cargo bindings. */
export function declaredFromCargo(root: string): DepBinding[] {
  const file = join(root, 'Cargo.toml');
  if (!existsSync(file)) return [];
  const out: DepBinding[] = [];
  let inDeps = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const header = line.trim().match(/^\[([a-z-]+)\]$/);
    if (header) {
      inDeps = header[1] === 'dependencies';
      continue;
    }
    if (!inDeps) continue;
    const m = line.trim().match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|version\s*=\s*"([^"]+)")/);
    if (m && AI_SDK_NAME.test(m[1]!)) {
      out.push({ dep_key: `dep:${root}:Cargo.toml:${m[1]}`, name: m[1]!, kind: 'cargo', source: 'declared', path: file, version: m[2] ?? m[3] ?? null });
    }
  }
  return out;
}

/** uv.lock / poetry.lock: the resolved python tree. */
export function installedFromLockfile(root: string): DepBinding[] {
  const out: DepBinding[] = [];
  for (const [file, re] of [
    [join(root, 'uv.lock'), /^\[\[package\]\]$/],
    [join(root, 'poetry.lock'), /^\[\[?package\]?\]$/],
  ] as const) {
    if (!existsSync(file)) continue;
    let name: string | null = null;
    let version: string | null = null;
    const flush = () => {
      if (name && version && AI_SDK_NAME.test(name)) {
        out.push({ dep_key: `dep:${root}:${file.split('/').pop()}:${name}`, name, kind: 'pip', source: 'installed', path: file, version });
      }
      name = null;
      version = null;
    };
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (re.test(line.trim())) flush();
      const nm = line.match(/^name\s*=\s*"([^"]+)"/);
      if (nm) {
        flush();
        name = nm[1]!;
      }
      const vm = line.match(/^version\s*=\s*"([^"]+)"/);
      if (vm && name) version = vm[1]!;
    }
    flush();
  }
  return out;
}

/** Consent boundary: repo roots come from the work_roots table, never a walk. */
export function consentedRoots(db: DB): string[] {
  return (db
    .prepare('SELECT root_path FROM work_roots WHERE COALESCE(exists_now, 1) = 1')
    .all() as { root_path: string }[]).map((r) => r.root_path);
}

export function aiDependencyCensus(db: DB, home: string, now: number): number {
  const upsert = db.prepare(`
    INSERT INTO ai_dependencies (dep_key, name, kind, source, path, version, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dep_key) DO UPDATE SET
      last_seen = excluded.last_seen,
      version = COALESCE(excluded.version, ai_dependencies.version),
      path = COALESCE(excluded.path, ai_dependencies.path)`);
  let n = 0;
  for (const root of consentedRoots(db)) {
    const bindings = [
      ...declaredFromPackageJson(root),
      ...installedFromNodeModulesLock(root),
      ...declaredFromPython(root),
      ...installedFromSitePackages(root),
      ...declaredFromGoMod(root),
      ...declaredFromCargo(root),
      ...installedFromLockfile(root),
    ];
    for (const b of bindings) {
      upsert.run(b.dep_key, b.name, b.kind, b.source, b.path, b.version, now, now);
      n++;
    }
  }
  // pipx global tree: site-packages under each venv (names + versions only).
  const pipx = join(home, '.local', 'pipx', 'venvs');
  for (const venv of readdirSafe(pipx)) {
    const lib = join(pipx, venv, 'lib');
    for (const py of readdirSafe(lib)) {
      const sp = join(lib, py, 'site-packages');
      for (const d of distInfoIn(sp)) {
        const key = `dep:pipx:${venv}:site-packages:${d.name}`;
        upsert.run(key, d.name, 'pip', 'installed', sp, d.version, now, now);
        n++;
      }
    }
  }
  return n;
}

export function scanDeps(): { ok: boolean; notes?: string } {
  const db: DB = openDb();
  const now = Date.now();
  const n = aiDependencyCensus(db, homedir(), now);
  return {
    ok: true,
    notes: `${n} dependency binding(s) under consented roots — a dependency is not a call; no usage column exists here`,
  };
}

export const depsScanner: Scanner = {
  name: 'ai-deps',
  cadenceMs: 5 * 60_000,
  run: scanDeps,
};

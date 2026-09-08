import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The pre-Vole residue hunt (tier 6 #75): the filesystem remembers days the
 * store never saw. At hunt time only, under a declared byte budget, it reads
 * dated residue — npm debug logs, lockfiles under the declared work roots,
 * Homebrew install receipts, VS Code extension manifests.
 *
 * Residue proves PRESENCE, not execution: a lockfile entry proves resolution,
 * an install receipt proves an install, neither proves the postinstall ran or
 * that an agent used it. Every row names whose clock its date came from.
 */

export type ResidueSource =
  | 'npm_log'
  | 'npm_lockfile'
  | 'pnpm_modules_yaml'
  | 'homebrew_cellar'
  | 'homebrew_cask'
  | 'vscode_extension';

export type ResidueClock =
  | 'log filename'
  | 'lockfile mtime'
  | 'install receipt time'
  | 'extension manifest'
  | 'directory mtime'
  | 'directory name';

export interface ResidueRow {
  source: ResidueSource;
  name: string;
  version: string | null;
  /** NULL = the artifact carried no usable date — presence without a when. */
  date_ts: number | null;
  /** Whose clock the date came from (the spec's labelling requirement). */
  date_basis: ResidueClock;
  still_on_disk: boolean | null;
  bytes: number | null;
  /** File or root the row was read from. */
  root: string;
}

export interface ResidueHuntOptions {
  home?: string;
  /** Declared work_roots (root_path values) whose node_modules may be read. */
  workRoots: string[];
  /** Declared byte budget; the hunt stops reading when exceeded. */
  byteBudget?: number;
  /** Overrides for the fixed roots (tests and non-standard installs). */
  cellarDir?: string;
  caskroomDir?: string;
  vscodeExtensionsDir?: string;
}

export interface ResidueHuntResult {
  rows: ResidueRow[];
  bytes_read: number;
  truncated: boolean;
}

/** The declared budget default (ponytail: 8 MiB; raise it if a hunt needs deeper roots). */
export const DEFAULT_RESIDUE_BUDGET = 8 * 1024 * 1024;

class Budget {
  used = 0;
  truncated = false;
  constructor(private readonly cap: number) {}
  read(file: string, size: number): string | null {
    if (this.used + size > this.cap) {
      this.truncated = true;
      return null;
    }
    this.used += size;
    return readFileSync(file, 'utf8');
  }
}

function safeSize(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/** npm's debug-log filename embeds the UTC instant: 2026-08-04T03_04_05_123Z-debug-0.log. */
function tsFromNpmLogName(name: string): number | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})_(\d{2})_(\d{2})(?:_(\d+))?Z?-debug-\d+\.log$/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5] ?? '000'}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function huntNpmLogs(dir: string, budget: Budget, rows: ResidueRow[]): void {
  if (!existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith('-debug-0.log')) continue;
    const file = join(dir, n);
    const size = safeSize(file);
    if (size === null) continue;
    // Only the filename is needed; the budget still pays for the size class.
    budget.read(file, size);
    rows.push({
      source: 'npm_log',
      name: n,
      version: null,
      date_ts: tsFromNpmLogName(n),
      date_basis: 'log filename',
      still_on_disk: true,
      bytes: size,
      root: file,
    });
  }
}

interface LockfileEntry {
  name: string;
  version: string | null;
}

/** npm's hidden lockfile: packages keyed "node_modules/<name>" with a version. */
function parseHiddenLockfile(text: string): LockfileEntry[] {
  try {
    const packages = (JSON.parse(text) as { packages?: Record<string, { version?: unknown }> }).packages ?? {};
    const out: LockfileEntry[] = [];
    for (const [key, v] of Object.entries(packages)) {
      const name = key.replace(/^node_modules\//, '').replace(/^node_modules\/.*\/node_modules\//, '');
      if (!name || key === '') continue;
      out.push({ name, version: typeof v.version === 'string' ? v.version : null });
    }
    return out;
  } catch {
    return [];
  }
}

function huntWorkRoot(roots: string[], budget: Budget, rows: ResidueRow[]): void {
  for (const root of roots) {
    const lock = join(root, 'node_modules', '.package-lock.json');
    const size = safeSize(lock);
    if (size !== null && existsSync(lock)) {
      const text = budget.read(lock, size);
      if (text !== null) {
        const mtime = statSync(lock).mtimeMs;
        for (const e of parseHiddenLockfile(text)) {
          rows.push({
            source: 'npm_lockfile',
            name: e.name,
            version: e.version,
            date_ts: Number.isFinite(mtime) ? mtime : null,
            date_basis: 'lockfile mtime',
            still_on_disk: true,
            bytes: size,
            root: lock,
          });
        }
      }
    }
    const yaml = join(root, 'node_modules', '.modules.yaml');
    const ysize = safeSize(yaml);
    if (ysize !== null && existsSync(yaml)) {
      const text = budget.read(yaml, ysize);
      if (text !== null) {
        const mtime = statSync(yaml).mtimeMs;
        const line = text.split('\n').find((l) => /^storeDir:/.test(l));
        rows.push({
          source: 'pnpm_modules_yaml',
          name: 'pnpm store',
          version: null,
          date_ts: Number.isFinite(mtime) ? mtime : null,
          date_basis: 'lockfile mtime',
          still_on_disk: true,
          bytes: ysize,
          root: line ? line.replace(/^storeDir:\s*/, '').replace(/['"]/g, '') : yaml,
        });
      }
    }
  }
}

function huntHomebrew(cellar: string, caskroom: string, budget: Budget, rows: ResidueRow[]): void {
  for (const [dir, source, clock] of [
    [cellar, 'homebrew_cellar', 'install receipt time'],
    [caskroom, 'homebrew_cask', 'directory mtime'],
  ] as const) {
    if (!existsSync(dir)) continue;
    let kegs: string[];
    try {
      kegs = readdirSync(dir);
    } catch {
      continue;
    }
    for (const keg of kegs) {
      let versions: string[];
      try {
        versions = readdirSync(join(dir, keg));
      } catch {
        continue;
      }
      for (const ver of versions) {
        const receipt = join(dir, keg, ver, 'INSTALL_RECEIPT.json');
        if (source === 'homebrew_cellar' && existsSync(receipt)) {
          const size = safeSize(receipt);
          if (size === null) continue;
          const text = budget.read(receipt, size);
          let ts: number | null = null;
          if (text) {
            try {
              const t = (JSON.parse(text) as { time?: unknown }).time;
              if (typeof t === 'string') {
                const p = Date.parse(t);
                ts = Number.isFinite(p) ? p : null;
              }
            } catch {
              ts = null;
            }
          }
          rows.push({
            source,
            name: keg,
            version: ver,
            date_ts: ts,
            date_basis: 'install receipt time',
            still_on_disk: true,
            bytes: size,
            root: receipt,
          });
        } else {
          const d = safeSize(join(dir, keg, ver));
          rows.push({
            source,
            name: keg,
            version: ver,
            date_ts: d !== null ? statSync(join(dir, keg, ver)).mtimeMs : null,
            date_basis: clock === 'directory mtime' ? 'directory mtime' : 'directory name',
            still_on_disk: true,
            bytes: d,
            root: join(dir, keg, ver),
          });
        }
      }
    }
  }
}

function huntVscodeExtensions(dir: string, budget: Budget, rows: ResidueRow[]): void {
  const manifest = join(dir, 'extensions.json');
  if (!existsSync(manifest)) return;
  const size = safeSize(manifest);
  if (size === null) return;
  const text = budget.read(manifest, size);
  if (text === null) return;
  let installed: Array<{ identifier?: { id?: unknown }; version?: unknown; relativeLocation?: unknown }>;
  try {
    installed = JSON.parse(text);
  } catch {
    return;
  }
  if (!Array.isArray(installed)) return;
  const obsoleteFile = join(dir, '.obsolete');
  let obsolete: Record<string, unknown> = {};
  if (existsSync(obsoleteFile)) {
    const osize = safeSize(obsoleteFile);
    if (osize !== null) {
      const otext = budget.read(obsoleteFile, osize);
      if (otext) {
        try {
          obsolete = JSON.parse(otext) as Record<string, unknown>;
        } catch {
          obsolete = {};
        }
      }
    }
  }
  const obsoleteIds = new Set(Object.keys(obsolete));
  for (const ext of installed) {
    const id = ext.identifier?.id;
    if (typeof id !== 'string') continue;
    const dirName = typeof ext.relativeLocation === 'string' ? ext.relativeLocation : id;
    rows.push({
      source: 'vscode_extension',
      name: id,
      version: typeof ext.version === 'string' ? ext.version : null,
      date_ts: null,
      date_basis: 'extension manifest',
      still_on_disk: !obsoleteIds.has(dirName),
      bytes: size,
      root: manifest,
    });
  }
}

/** Runs the residue hunt. Read-only over the filesystem; nothing is stored. */
export function residueHunt(opts: ResidueHuntOptions): ResidueHuntResult {
  const home = opts.home ?? homedir();
  const budget = new Budget(opts.byteBudget ?? DEFAULT_RESIDUE_BUDGET);
  const rows: ResidueRow[] = [];
  huntNpmLogs(join(home, '.npm', '_logs'), budget, rows);
  huntWorkRoot(opts.workRoots, budget, rows);
  huntHomebrew(
    opts.cellarDir ?? join('/opt', 'homebrew', 'Cellar'),
    opts.caskroomDir ?? join('/opt', 'homebrew', 'Caskroom'),
    budget,
    rows,
  );
  huntVscodeExtensions(opts.vscodeExtensionsDir ?? join(home, '.vscode', 'extensions'), budget, rows);
  return { rows, bytes_read: budget.used, truncated: budget.truncated };
}

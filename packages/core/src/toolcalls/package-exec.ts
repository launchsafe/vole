import type { DB } from '../db';
import { splitCommandSegments, tokenize, stripPrefixes } from './patterns';
import { widenUpsert } from './upsert';

/**
 * The package-execution ledger: installs, fetch-and-run (npx/pnpm dlx/pipx run
 * — the "execute code you just downloaded" shape), and registry provenance.
 * The registry is NULL unless the command declares one: a default npmjs
 * assumption would be a fabricated provenance fact.
 *
 * ponytail: install lists are the raw operands after the install verb with
 * flag-looking tokens dropped — a truly shell-accurate parse of npm's grammar
 * (workspaces, --workspace flags) is not worth the code; mised parses surface
 * as an odd package_name, never a fabricated registry.
 */

export interface PackageExecRow {
  call_key: string;
  package_name: string | null;
  registry: string | null;
  fetch_and_run: number; // 0 | 1
  ts: number | null;
}

const INSTALLERS: { re: RegExp; start: number }[] = [
  { re: /^(npm|pnpm|yarn|bun)\s+install\b/, start: 2 },
  { re: /^(npm|pnpm|yarn|bun)\s+(add|i)\b/, start: 2 },
  { re: /^(pip|pip3|uv)\s+install\b/, start: 2 },
  { re: /^pipx\s+install\b/, start: 2 },
  { re: /^brew\s+(install|upgrade)\b/, start: 2 },
  { re: /^cargo\s+(add|install)\b/, start: 2 },
  { re: /^gem\s+install\b/, start: 2 },
  { re: /^go\s+get\b/, start: 2 },
];

const FETCH_AND_RUN = [/^npx\b/, /^pnpm\s+(dlx|exec)\b/, /^pipx\s+run\b/, /^bunx\b/, /^uvx\b/];

function registryOf(toks: string[], pip = false): string | null {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === '--registry' && toks[i + 1]) return toks[i + 1]!;
    if (t.startsWith('--registry=')) return t.slice('--registry='.length);
    if (pip && t === '--index-url' && toks[i + 1]) return toks[i + 1]!;
    if (pip && t.startsWith('--index-url=')) return t.slice('--index-url='.length);
  }
  return null;
}

export function packageExecs(command: string, callKey: string, ts: number | null): PackageExecRow[] {
  const out: PackageExecRow[] = [];
  for (const seg of splitCommandSegments(command)) {
    const toks = stripPrefixes(tokenize(seg));
    if (!toks.length) continue;
    const text = toks.join(' ');
    const push = (names: string[], fetchAndRun: number) => {
      for (const name of names) {
        out.push({ call_key: callKey, package_name: name, registry: registryOf(toks, /^pip/.test(toks[0] ?? '')), fetch_and_run: fetchAndRun, ts });
      }
    };
    for (const far of FETCH_AND_RUN) {
      if (far.test(text)) {
        // npx <pkg>[@version] [args...] — the first non-flag operand.
        const operand = toks.slice(1).find((t) => !t.startsWith('-'));
        push(operand ? [operand] : [], 1);
        break;
      }
    }
    for (const ins of INSTALLERS) {
      if (ins.re.test(text)) {
        // Drop flags AND the value that follows one (e.g. `--registry <url>`).
        const operands: string[] = [];
        let skipNext = false;
        for (const t of toks.slice(ins.start)) {
          if (skipNext) { skipNext = false; continue; }
          if (t.startsWith('-')) { skipNext = true; continue; }
          if (t.includes('=')) continue;
          operands.push(t);
        }
        push(operands, 0);
        break;
      }
    }
  }
  return out;
}

export function insertPackageExecs(db: DB, rows: PackageExecRow[]): number {
  return widenUpsert(db, {
    table: 'package_execs',
    keyCols: ['call_key', 'package_name'],
    cols: ['registry', 'fetch_and_run', 'ts'],
  }, rows);
}

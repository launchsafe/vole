import type { DB } from '../db';
import { splitCommandSegments, tokenize, stripPrefixes } from './patterns';
import { loadAssetRegister, resolveAsset, type AssetEntry, type AssetResolution } from './assets';
import { widenUpsert } from './upsert';

/**
 * action_targets (feature 38): one row per ledger call that names a system
 * OUTSIDE this filesystem, with the resolution chain made explicit. A resolved
 * label is what the string and the local files say, not what a credential
 * resolved to at the server — an exported AWS_PROFILE overrides the file, so
 * kubectl without --context is tagged context_file_default (flag absent), and
 * anything from $VAR is shell_var_from_file, never a literal.
 */

export interface ActionTargetRow {
  call_key: string;
  target_kind: string; // cloud_account | k8s_context | database | vcs_repo | package_registry | saas | remote_host
  target_label: string | null;
  locality: string | null; // loopback | remote | unknown
  env_class: string | null; // prod | staging | dev — only when the label declares it
  reversible: string | null; // yes | no | unknown
  resolution: string | null; // literal | shell_var_from_file | context_file_default | flag | unresolved
  evidence_path: string | null;
  asset_id: string | null;
}

interface Extracted {
  target_kind: string;
  target_label: string | null;
  resolution: string;
}

const VAR = /^\$/;

function localityOf(label: string | null): string | null {
  if (!label) return null;
  if (/^(localhost|127\.|::1|\[?0\.0\.0\.0)/.test(label)) return 'loopback';
  if (label.includes('.')) return 'remote';
  return 'unknown';
}

function envClassOf(label: string | null): string | null {
  if (!label) return null;
  if (/\b(prod|production)\b/i.test(label)) return 'prod';
  if (/\b(staging|stage)\b/i.test(label)) return 'staging';
  if (/\b(dev|development)\b/i.test(label)) return 'dev';
  return null; // never guessed — an env chip only when declared
}

function flagValue(toks: string[], flag: string): string | null {
  const i = toks.indexOf(flag);
  if (i < 0) return null;
  const v = toks[i + 1];
  return v && !v.startsWith('-') ? v.replace(/^["']|["']$/g, '') : null;
}

function urlHost(u: string): string | null {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

/** Extract external systems from one shell command. */
export function actionTargetsFromCommand(command: string): Extracted[] {
  const out: Extracted[] = [];
  const push = (e: Extracted) => out.push(e);
  for (const seg of splitCommandSegments(command)) {
    const toks = stripPrefixes(tokenize(seg));
    if (!toks.length) continue;
    const head = toks[0]!;
    const literal = (t: string | undefined) =>
      t === undefined ? null : VAR.test(t) ? null : t.replace(/^["']|["']$/g, '');
    const varOr = (t: string | undefined) =>
      t === undefined ? null : VAR.test(t) ? '$VAR' : t.replace(/^["']|["']$/g, '');

    if (head === 'ssh' || head === 'scp' || head === 'rsync' || head === 'sshfs') {
      // First non-flag token (for scp/rsync: the first with a host part).
      for (const t of toks.slice(1)) {
        if (t.startsWith('-')) continue;
        // user@host or user@host:path — the host, never the path.
        const m = /^([\w.-]+@)([\w.-]+)(?::|$)/.exec(t) ?? /^([\w.-]+):/.exec(t);
        if (m) {
          const host = m[2] ?? m[1]!;
          push({ target_kind: 'remote_host', target_label: VAR.test(host) ? null : host, resolution: VAR.test(host) ? 'shell_var_from_file' : 'literal' });
        } else if (head === 'ssh') {
          push({ target_kind: 'remote_host', target_label: varOr(t), resolution: VAR.test(t) ? 'shell_var_from_file' : 'literal' });
        }
        break; // only the first operand is the destination
      }
    } else if (head === 'curl' || head === 'wget') {
      for (const t of toks.slice(1)) {
        if (/^https?:\/\//.test(t)) {
          const h = urlHost(t);
          if (h) push({ target_kind: 'remote_host', target_label: h, resolution: 'literal' });
        }
      }
    } else if (head === 'psql' || head === 'mysql') {
      const h = flagValue(toks, '-h') ?? flagValue(toks, '--host');
      const db = flagValue(toks, '-d');
      push({
        target_kind: 'database',
        target_label: h ? (db ? `${h}/${db}` : h) : null,
        resolution: h ? (VAR.test(h) ? 'shell_var_from_file' : 'literal') : 'unresolved',
      });
    } else if (head === 'kubectl') {
      const ctx = flagValue(toks, '--context');
      if (ctx) {
        push({ target_kind: 'k8s_context', target_label: ctx, resolution: VAR.test(ctx) ? 'shell_var_from_file' : 'flag' });
      } else {
        // No flag: the current-context default from the kubeconfig file.
        push({ target_kind: 'k8s_context', target_label: null, resolution: 'context_file_default' });
      }
    } else if (head === 'git' && toks[1] === 'clone') {
      const url = literal(toks[2]);
      if (url) push({ target_kind: 'vcs_repo', target_label: url, resolution: 'literal' });
    } else if (head === 'gh') {
      const repo = flagValue(toks, '--repo') ?? flagValue(toks, '-R');
      if (repo) push({ target_kind: 'vcs_repo', target_label: repo, resolution: VAR.test(repo) ? 'shell_var_from_file' : 'flag' });
    } else if (head === 'aws') {
      const p = flagValue(toks, '--profile');
      if (p) push({ target_kind: 'cloud_account', target_label: p, resolution: VAR.test(p) ? 'shell_var_from_file' : 'flag' });
    } else if (head === 'gcloud') {
      const p = flagValue(toks, '--project');
      if (p) push({ target_kind: 'cloud_account', target_label: p, resolution: VAR.test(p) ? 'shell_var_from_file' : 'flag' });
    } else if (head === 'npm' || head === 'pnpm' || head === 'yarn' || head === 'pip' || head === 'pip3' || head === 'uv') {
      const reg = flagValue(toks, '--registry') ?? flagValue(toks, '--index-url');
      if (reg) push({ target_kind: 'package_registry', target_label: reg, resolution: VAR.test(reg) ? 'shell_var_from_file' : 'flag' });
    }
  }
  return out;
}

export interface TargetContext {
  call_key: string;
  evidence_path?: string | null;
  cwd?: string | null;
  register?: AssetEntry[];
}

/** Extract + resolve + classify one command into insertable target rows. */
export function actionTargetsForCommand(command: string, ctx: TargetContext): ActionTargetRow[] {
  const register = ctx.register ?? loadAssetRegister();
  return actionTargetsFromCommand(command).map((e) => {
    const res: AssetResolution = resolveAsset(register, { label: e.target_label, cwd: ctx.cwd });
    return {
      call_key: ctx.call_key,
      target_kind: e.target_kind,
      target_label: e.target_label,
      locality: localityOf(e.target_label),
      env_class: envClassOf(e.target_label),
      reversible: 'unknown', // per-action reversibility is the child ledgers' fact
      resolution: e.resolution,
      evidence_path: ctx.evidence_path ?? null,
      asset_id: res.asset_id,
    };
  });
}

export function insertActionTargets(db: DB, rows: ActionTargetRow[]): number {
  // A NULL label would make SQLite's UNIQUE treat every re-poll as a new row
  // (NULL != NULL), so unlabeled targets (kubectl with no --context) are keyed
  // with '' — which reads back as "no label named", never as a fabricated one.
  const keyed = rows.map((r) => ({ ...r, target_label: r.target_label ?? '' }));
  return widenUpsert(db, {
    table: 'action_targets',
    keyCols: ['call_key', 'target_kind', 'target_label'],
    cols: ['locality', 'env_class', 'reversible', 'resolution', 'evidence_path', 'asset_id'],
    stamped: true,
  }, keyed);
}

import type { DB } from '../db';
import { splitCommandSegments, tokenize, stripPrefixes } from './patterns';
import { widenUpsert } from './upsert';

/**
 * The credential ledgers (features 16 + 50). secret_store_reads records the
 * credential the agent PULLED from a remote vault; grant_deposits records the
 * one it HANDED to something else — the direction that permanently widens
 * someone else's authority. Both store the NAME of the item and field only,
 * never a value: a literal credential typed into the command is fingerprinted
 * upstream by the DLP scanner, never here.
 */

export interface SecretStoreReadRow {
  call_key: string;
  store_kind: string;
  target_ref: string | null;
  item_name: string | null;
  field_name: string | null;
  materialised: string | null; // 'yes' | 'unknown' — decoded vs merely fetched
  ts: number | null;
}

export interface GrantDepositRow {
  deposit_key: string;
  tool_call_key: string | null;
  store_kind: string | null;
  target_ref: string | null;
  item_name: string | null;
  ts: number | null;
}

interface StoreShape {
  store_kind: string;
  /** Returns [item, field?, target?] from the command tokens. */
  extract: (toks: string[]) => [string | null, string | null, string | null];
}

const afterFlag = (toks: string[], flag: string): string | null => {
  const i = toks.indexOf(flag);
  return i >= 0 && toks[i + 1] ? toks[i + 1]!.replace(/^["']|["']$/g, '') : null;
};
const firstOperand = (toks: string[], from: number): string | null => {
  for (const t of toks.slice(from)) {
    if (!t.startsWith('-')) return t.replace(/^["']|["']$/g, '');
  }
  return null;
};

/** The secret-store read shapes (39 commands across 8 CLIs on the reference
 *  machine). Ordering matters: kubectl's secret read is checked before generic
 *  kubectl, aws secretsmanager before generic aws. */
const READ_SHAPES: { re: RegExp; shape: StoreShape }[] = [
  {
    re: /^kubectl\s+(get|describe)\s+secrets?\b/,
    shape: {
      store_kind: 'kubernetes',
      extract: (toks) => {
        const item = firstOperand(toks, 3);
        // -o jsonpath='{.data.FIELD}' — the field name, never the decoded value.
        const jp = toks.find((t) => /jsonpath/.test(t));
        const field = jp ? (/\{\.data\.([A-Za-z0-9_-]+)/.exec(jp)?.[1] ?? null) : null;
        const ctx = afterFlag(toks, '--context') ?? afterFlag(toks, '-n') ?? null;
        return [item, field, ctx];
      },
    },
  },
  {
    re: /^aws\s+secretsmanager\s+get-secret-value\b/,
    shape: {
      store_kind: 'aws_secretsmanager',
      extract: (toks) => [
        afterFlag(toks, '--secret-id') ?? firstOperand(toks, 3),
        null,
        afterFlag(toks, '--profile'),
      ],
    },
  },
  { re: /^gh\s+secret\s+list\b/, shape: { store_kind: 'github_actions', extract: (toks) => [null, null, afterFlag(toks, '--repo')] } },
  { re: /^gh\s+secret\s+set\b/, shape: { store_kind: 'github_actions', extract: (toks) => [toks[2]?.replace(/^["']|["']$/g, '') ?? null, null, afterFlag(toks, '--repo')] } },
  { re: /^op\s+read\b/, shape: { store_kind: 'onepassword', extract: (toks) => [toks[1] ?? null, null, null] } },
  { re: /^vault\s+kv\s+get\b/, shape: { store_kind: 'vault', extract: (toks) => [toks[3] ?? null, null, null] } },
  { re: /^wrangler\s+secret\b/, shape: { store_kind: 'cloudflare', extract: (toks) => [toks[2] ?? null, null, null] } },
  { re: /^flyctl\s+secrets?\b/, shape: { store_kind: 'flyio', extract: (toks) => [firstOperand(toks, 2), null, afterFlag(toks, '--app')] } },
  { re: /^doctl\b.*--access-token\b/, shape: { store_kind: 'digitalocean', extract: () => [null, null, null] } },
];

/** The deposit shapes: credentials handed out (feature 50). */
const DEPOSIT_SHAPES: { re: RegExp; store_kind: string; itemIndex: number; flag?: string }[] = [
  { re: /^gh\s+secret\s+set\b/, store_kind: 'github_actions', itemIndex: 3, flag: '--repo' },
  { re: /^gh\s+variable\s+set\b/, store_kind: 'github_actions', itemIndex: 3, flag: '--repo' },
  { re: /^gh\s+workflow\s+(enable|run)\b/, store_kind: 'github_actions', itemIndex: 2, flag: '--repo' },
  { re: /^aws\s+iam\s+(attach|put|create)/, store_kind: 'aws_iam', itemIndex: 2 },
  { re: /^gcloud\b.*add-iam-policy-binding\b/, store_kind: 'gcp_iam', itemIndex: 2 },
  { re: /^kubectl\s+create\s+secret\b/, store_kind: 'kubernetes', itemIndex: 3, flag: '--context' },
  { re: /^vault\s+kv\s+put\b/, store_kind: 'vault', itemIndex: 3 },
  { re: /^wrangler\s+secret\s+put\b/, store_kind: 'cloudflare', itemIndex: 3 },
  { re: /^heroku\s+config:set\b/, store_kind: 'heroku', itemIndex: 2, flag: '--app' },
  { re: /^terraform\s+apply\b/, store_kind: 'terraform', itemIndex: 1 },
];

const headOf = (seg: string): { toks: string[]; text: string } => {
  const toks = stripPrefixes(tokenize(seg));
  return { toks, text: toks.join(' ') };
};

/** Secret-store reads from a command string. Names only, values never. */
export function secretStoreReads(command: string, callKey: string, ts: number | null): SecretStoreReadRow[] {
  const out: SecretStoreReadRow[] = [];
  // materialised: 'yes' only when the pipeline decodes (base64 -d) — the decode
  // usually sits in the NEXT segment, so it is checked against the whole command.
  const materialised = /\bbase64\b[^|]*\s+-d/.test(command) ? 'yes' : 'unknown';
  for (const seg of splitCommandSegments(command)) {
    const { toks, text } = headOf(seg);
    if (!toks.length) continue;
    for (const s of READ_SHAPES) {
      if (!s.re.test(text)) continue;
      const [item, field, target] = s.shape.extract(toks);
      out.push({
        call_key: callKey,
        store_kind: s.shape.store_kind,
        target_ref: target,
        item_name: item,
        field_name: field,
        materialised,
        ts,
      });
      break;
    }
  }
  return out;
}

/** Grant deposits from a command string. Records an ATTEMPT to deposit, never
 *  a confirmed success (the shell gives no exit code in the transcript). */
export function grantDeposits(command: string, callKey: string, ts: number | null): GrantDepositRow[] {
  const out: GrantDepositRow[] = [];
  for (const seg of splitCommandSegments(command)) {
    const { toks, text } = headOf(seg);
    if (!toks.length) continue;
    for (const d of DEPOSIT_SHAPES) {
      if (!d.re.test(text)) continue;
      const item = toks[d.itemIndex]?.replace(/^["']|["']$/g, '') ?? null;
      const target = d.flag ? afterFlag(toks, d.flag) : null;
      out.push({
        deposit_key: `${callKey}:${d.store_kind}:${item ?? 'unnamed'}`,
        tool_call_key: callKey,
        store_kind: d.store_kind,
        target_ref: target,
        item_name: item,
        ts,
      });
      break;
    }
  }
  return out;
}

export function insertSecretStoreReads(db: DB, rows: SecretStoreReadRow[]): number {
  return widenUpsert(db, {
    table: 'secret_store_reads',
    keyCols: ['call_key', 'store_kind', 'item_name', 'field_name'],
    cols: ['target_ref', 'materialised', 'ts'],
  }, rows);
}

export function insertGrantDeposits(db: DB, rows: GrantDepositRow[]): number {
  return widenUpsert(db, {
    table: 'grant_deposits',
    keyCols: ['deposit_key'],
    cols: ['tool_call_key', 'store_kind', 'target_ref', 'item_name', 'ts'],
    stamped: true,
  }, rows);
}

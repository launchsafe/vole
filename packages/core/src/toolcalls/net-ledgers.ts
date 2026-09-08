import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import { home } from '../paths';
import { skeletonize } from './bind';

/**
 * The net ledgers — tier 5's target/action records, in one module:
 *
 *   db_actions       remote-database statements (class + object names, never SQL)
 *   remote_exec       execution hops that left this machine (host deduped via ssh_config)
 *   context_edges     every crossing by transport and destination
 *   vcs_actions       the agent's own gitOperation record, with escape state
 *   package_execs     installs and fetch-and-run
 *   fetch_ingress     web bytes that entered a session (host/status/size)
 *   sensitive_access  path-class + authorization basis matrix (hashes, never paths)
 *
 * Two entry paths, deliberately:
 *
 *   1. BIND TIME (rich): collectors hold the raw arguments for a call and call the
 *      parse* functions, then writeNetLedgers(). This is where destinations, object
 *      names, inner patterns and statement classes come from — they cannot be
 *      recovered from the stored shape, and they are never stored raw.
 *   2. FROM STORE (coarse): emitNetLedgers(db) re-derives what the stored shape
 *      alone can prove — the transport verb, the git verb, the install verb — with
 *      destination/object names left NULL ("not recorded", never guessed). Rows are
 *      emitted only for calls with no row in that ledger yet, so the pass is
 *      idempotent and incremental.
 *
 * Everything here is content-free by construction: identifiers, classes, hashes.
 */

// ── row shapes (local; the tables' own contracts) ────────────────────────────

export interface DbActionRow {
  call_key: string;
  statement_class: 'read' | 'write' | 'ddl' | 'truncate' | 'drop' | 'migrate_reset';
  object_names: string | null;
  target_key: string | null;
  ts: number | null;
}

export interface RemoteExecRow {
  call_key: string;
  hop: number;
  host: string | null;
  user: string | null;
  inner_pattern: string | null;
  ts: number | null;
}

export interface ContextEdgeRow {
  call_key: string;
  transport: string;
  verb: string | null;
  destination: string | null;
  direction: 'push' | 'pull' | 'out' | 'mount' | 'unknown';
  ts: number | null;
}

export interface VcsActionRow {
  call_key: string;
  verb: string;
  repo: string | null;
  escape_state: 'local' | 'committed' | 'pushed';
  push_evidence: string | null;
  ts: number | null;
}

export interface PackageExecRow {
  call_key: string;
  package_name: string | null;
  registry: string | null;
  fetch_and_run: 0 | 1;
  ts: number | null;
}

export interface FetchIngressRow {
  call_key: string;
  url_host: string | null;
  status: number | null;
  bytes: number | null;
  ts: number | null;
}

export interface SensitiveAccessRow {
  path_class: string;
  path_hash: string;
  authorization_basis: string | null;
  count: number;
  window_start: number;
}

export interface NetLedgerBatch {
  contextEdges?: ContextEdgeRow[];
  dbActions?: DbActionRow[];
  remoteExec?: RemoteExecRow[];
  vcsActions?: VcsActionRow[];
  packageExecs?: PackageExecRow[];
  fetchIngress?: FetchIngressRow[];
  sensitiveAccess?: SensitiveAccessRow[];
}

// ── shell tokenisation (quote-aware, the shared substrate of every parser) ────

/** Split a command line into tokens, honouring single and double quotes. */
export function shellTokens(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Command segments: split on &&, ||, ; and | — the chain a single call executed. */
export function commandSegments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The command string inside a tool-call argument object, or the string itself. */
export function commandOf(name: string, args: unknown): string | null {
  if (typeof args === 'string' && /\s/.test(args)) return args;
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    for (const k of ['command', 'cmd', 'script', 'input', 'body']) {
      if (typeof a[k] === 'string') return a[k] as string;
    }
  }
  return null;
}

// ── context_edges: crossings by transport and destination ────────────────────

const TRANSPORT_HEADS: Record<string, string> = {
  ssh: 'ssh',
  mosh: 'mosh',
  scp: 'scp',
  rsync: 'rsync',
  sshfs: 'sshfs',
  docker: 'docker',
  kubectl: 'kubectl',
  podman: 'podman',
  colima: 'colima',
  limactl: 'limactl',
  tart: 'tart',
  runpod: 'runpod',
  vagrant: 'vagrant',
  modal: 'modal',
  devcontainer: 'devcontainer',
};

/** Flags that consume the NEXT token, so destination detection can skip the value. */
const FLAG_WITH_VALUE: Record<string, Set<string>> = {
  ssh: new Set(['-p', '-i', '-o', '-l', '-b', '-e', '-F', '-W', '-J', '-S']),
  scp: new Set(['-P', '-p', '-i', '-o', '-F', '-S', '-J', '-l']),
  rsync: new Set(['-e', '--rsh', '--rsync-path', '--exclude-from', '--include-from']),
};

function isRemoteRef(token: string): boolean {
  // 'host:/path', 'user@host:/path' — a colon before any slash marks a remote side;
  // 'C:\\' style windows paths do not appear in these commands' remote position.
  const colon = token.indexOf(':');
  return colon > 0 && (token.indexOf('/') === -1 || colon < token.indexOf('/'));
}

function stripPathPart(ref: string): string {
  return ref.slice(0, ref.indexOf(':')) || ref;
}

/** Transports whose invocation alone proves a crossing (destination may be unknown). */
const COARSE_TRANSPORTS = new Set(['ssh', 'mosh', 'docker', 'kubectl', 'podman', 'colima', 'limactl', 'tart', 'runpod', 'vagrant', 'modal', 'devcontainer']);

/**
 * Classify one command segment. Returns the crossing row, or null when the segment
 * names no transport (or, for the copy verbs, when no remote side exists — a
 * local `cp` never left the machine and must not be recorded as if it had).
 *
 * `coarse` is the from-store mode: the stored shape keeps only the verb and its
 * known flags, so a crossing is recorded with destination NULL ("not recorded")
 * when the transport alone proves it — never guessed from a skeleton.
 */
export function parseSegmentCrossing(callKey: string, segment: string, ts: number | null, coarse = false): ContextEdgeRow | null {
  const tokens = shellTokens(segment);
  const head = tokens[0];
  if (!head) return null;

  if (head === 'gh' && tokens[1] === 'codespace') {
    // gh codespace cp <local> <codespace>:<path>  |  gh codespace ssh <name>
    const sub = tokens[2];
    if (sub === 'cp' || sub === 'ssh') {
      const remote = tokens.slice(3).find(isRemoteRef) ?? tokens[3] ?? null;
      return {
        call_key: callKey,
        transport: 'gh_codespace',
        verb: sub,
        destination: remote ? stripPathPart(remote) : null,
        direction: sub === 'cp' ? 'push' : 'out',
        ts,
      };
    }
    return null;
  }

  const transport = TRANSPORT_HEADS[head];
  if (!transport) return null;

  const flagValues = FLAG_WITH_VALUE[head] ?? new Set<string>();
  const args: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t.startsWith('-')) {
      if (flagValues.has(t) && i + 1 < tokens.length) i++; // skip the flag's value
      continue;
    }
    args.push(t);
  }

  if (coarse && !args.length && COARSE_TRANSPORTS.has(transport)) {
    return { call_key: callKey, transport, verb: head, destination: null, direction: 'out', ts };
  }

  if (transport === 'ssh' || transport === 'mosh') {
    const dest = args[0];
    if (!dest) return null;
    return { call_key: callKey, transport, verb: head, destination: dest.replace(/^[^@/]+@/, ''), direction: 'out', ts };
  }
  if (transport === 'sshfs') {
    const remote = args.find(isRemoteRef);
    if (!remote) return null;
    return { call_key: callKey, transport, verb: 'mount', destination: stripPathPart(remote).replace(/^[^@/]+@/, ''), direction: 'mount', ts };
  }
  if (transport === 'scp' || transport === 'rsync') {
    const remoteIdx = args.findIndex(isRemoteRef);
    if (remoteIdx === -1) return null; // local-to-local copy: never left the device
    const remote = args[remoteIdx] as string;
    const direction: ContextEdgeRow['direction'] =
      remoteIdx === args.length - 1 ? 'push' : remoteIdx === 0 ? 'pull' : 'unknown';
    return { call_key: callKey, transport, verb: head, destination: stripPathPart(remote).replace(/^[^@/]+@/, ''), direction, ts };
  }
  if (transport === 'docker' || transport === 'podman') {
    const sub = args[0]; // run | exec | cp | create | ...
    if (!sub) return null;
    if (sub === 'cp') {
      const a = args[1];
      const b = args[2];
      if (!a || !b) return null;
      return {
        call_key: callKey,
        transport: `${transport}_cp`,
        verb: 'cp',
        destination: a.includes(':') ? a.slice(0, a.indexOf(':')) : b.slice(0, b.indexOf(':')) || null,
        direction: a.includes(':') ? 'pull' : 'push',
        ts,
      };
    }
    // run/create: the image is the destination; exec: the container.
    const target = sub === 'run' || sub === 'create' ? args.slice(1).find((t) => !t.startsWith('-')) : args[1];
    return { call_key: callKey, transport, verb: sub, destination: target ?? null, direction: 'out', ts };
  }
  if (transport === 'kubectl') {
    const sub = args[0];
    if (!sub) return null;
    if (sub === 'cp') {
      const a = args[1];
      const b = args[2];
      if (!a || !b) return null;
      return {
        call_key: callKey,
        transport: 'kubectl_cp',
        verb: 'cp',
        destination: a.includes(':') ? a.slice(0, a.indexOf(':')) : b.slice(0, b.indexOf(':')) || null,
        direction: a.includes(':') ? 'pull' : 'push',
        ts,
      };
    }
    if (sub === 'exec') {
      const pod = args[1] ?? null;
      return { call_key: callKey, transport, verb: 'exec', destination: pod, direction: 'out', ts };
    }
    return { call_key: callKey, transport, verb: sub, destination: null, direction: 'out', ts };
  }
  // modal, vagrant, devcontainer, colima, limactl, tart, runpod: the first operand.
  return { call_key: callKey, transport, verb: head, destination: args[0] ?? null, direction: 'out', ts };
}

/** All crossings in one call, one row per transport-bearing segment. */
export function parseContextEdges(callKey: string, name: string, args: unknown, ts: number | null): ContextEdgeRow[] {
  const cmd = commandOf(name, args);
  if (!cmd) return [];
  const out: ContextEdgeRow[] = [];
  for (const seg of commandSegments(cmd)) {
    const row = parseSegmentCrossing(callKey, seg, ts);
    if (row) out.push(row);
  }
  return out;
}

// ── remote_exec: hops, host dedup via ssh_config ─────────────────────────────

export interface SshHostEntry {
  host: string;
  user: string | null;
}

/** ~/.ssh/config's Host/HostName/User lines — names only, never keys. */
export function parseSshConfigText(text: string): Map<string, SshHostEntry> {
  const map = new Map<string, SshHostEntry>();
  let current: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!;
    if (key.toLowerCase() === 'host') {
      current = value.split(/\s+/).filter((a) => a && !a.includes('*'));
      for (const alias of current) if (!map.has(alias)) map.set(alias, { host: alias, user: null });
    } else if (key.toLowerCase() === 'hostname') {
      for (const alias of current) {
        const e = map.get(alias);
        if (e) e.host = value;
      }
    } else if (key.toLowerCase() === 'user') {
      for (const alias of current) {
        const e = map.get(alias);
        if (e && !e.user) e.user = value;
      }
    }
  }
  return map;
}

export function loadSshConfig(path: string): Map<string, SshHostEntry> {
  try {
    return parseSshConfigText(readFileSync(path, 'utf8'));
  } catch {
    return new Map();
  }
}

/** Resolve an ssh destination to its canonical host: an alias and its literal
 *  address collapse to one target (h200 and 195.242.30.141 are one machine). */
function canonicalHost(dest: string, aliases: Map<string, SshHostEntry>): { host: string; user: string | null } {
  const at = dest.indexOf('@');
  const user = at > 0 ? dest.slice(0, at) : null;
  const hostish = at > 0 ? dest.slice(at + 1) : dest;
  const entry = aliases.get(hostish);
  return { host: entry?.host ?? hostish, user: user ?? entry?.user ?? null };
}

/**
 * The hop ledger for an ssh/docker/kubectl-exec command. Nested ssh (`ssh a ssh b
 * cmd`) records one row per hop, with the inner command reduced to its skeleton.
 */
export function parseRemoteExec(
  callKey: string,
  name: string,
  args: unknown,
  ts: number | null,
  sshAliases: Map<string, SshHostEntry> = new Map(),
): RemoteExecRow[] {
  const cmd = commandOf(name, args);
  if (!cmd) return [];
  const rows: RemoteExecRow[] = [];
  for (const seg of commandSegments(cmd)) {
    let tokens = shellTokens(seg);
    let hop = 0;
    // Unwrap nested hops (ssh a -> ssh b -> cmd): one row per hop, each carrying
    // the skeleton of everything inside it. ponytail: capped at 3 hops; a deeper
    // chain keeps its innermost tail as one opaque skeleton.
    while (hop < 3) {
      const head = tokens[0];
      let dest: string | null = null;
      let rest: string[] = [];
      if (head === 'ssh') {
        const flagValues = FLAG_WITH_VALUE['ssh']!;
        for (let i = 1; i < tokens.length; i++) {
          const t = tokens[i] as string;
          if (t.startsWith('-')) {
            if (flagValues.has(t)) i++;
            continue;
          }
          dest = t;
          rest = tokens.slice(i + 1);
          break;
        }
      } else if (head === 'docker' || head === 'kubectl' || head === 'podman') {
        if (tokens[1] !== 'exec') break;
        dest = tokens[2] ?? null;
        rest = tokens.slice(3);
      } else break;

      const { host, user } = dest ? canonicalHost(dest, sshAliases) : { host: null, user: null };
      const inner = rest.join(' ');
      rows.push({
        call_key: callKey,
        hop: ++hop,
        host,
        user,
        inner_pattern: inner ? skeletonize('Bash', inner) : null,
        ts,
      });
      const nextHead = rest[0];
      if (nextHead !== 'ssh' && nextHead !== 'docker' && nextHead !== 'kubectl' && nextHead !== 'podman') break;
      tokens = rest;
    }
  }
  return rows;
}

// ── db_actions: statement class and object names, never the SQL ──────────────

const MIGRATION_RESETS: Array<[RegExp, string]> = [
  [/^(?:npx\s+)?drizzle-kit\s+push/, 'ddl'],
  [/^(?:npx\s+)?prisma\s+migrate\s+(reset|diff|deploy)/, 'migrate_reset'],
  [/^(?:npx\s+)?alembic\s+downgrade/, 'migrate_reset'],
  [/^(?:npx\s+)?knex\s+migrate:rollback/, 'migrate_reset'],
];

/** Classify a SQL statement by its leading keyword. null = unclassifiable, no row. */
export function classifySql(sql: string): DbActionRow['statement_class'] | null {
  const s = sql.trim().replace(/^\(+/, '').toUpperCase();
  if (/^SELECT|^WITH|^\(?\s*SELECT/.test(s)) return 'read';
  if (/^INSERT|^UPDATE|^DELETE|^REPLACE|^MERGE/.test(s)) return 'write';
  if (/^DROP/.test(s)) return 'drop';
  if (/^TRUNCATE/.test(s)) return 'truncate';
  if (/^CREATE|^ALTER|^GRANT|^REVOKE|^COMMENT\s+ON/.test(s)) return 'ddl';
  return null;
}

/** Identifier names only — the objects a statement named, never the statement. */
export function sqlObjectNames(sql: string): string[] {
  const names = new Set<string>();
  const re =
    /\b(?:from|into|update|table|truncate\s+table|truncate|drop\s+(?:table|index|view|database|schema)(?:\s+if\s+exists)?|join)\s+[`"[]?([A-Za-z_][\w.$]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) names.add(m[1] as string);
  return [...names].slice(0, 8);
}

/**
 * Parse database client invocations out of a command. Only emits a row when the
 * statement class is provable from the client's own argument — an unclassifiable
 * command yields no row rather than an invented class.
 */
export function parseDbActions(callKey: string, name: string, args: unknown, ts: number | null): DbActionRow[] {
  const cmd = commandOf(name, args);
  if (!cmd) return [];
  const out: DbActionRow[] = [];
  for (const seg of commandSegments(cmd)) {
    const tokens = shellTokens(seg);
    const head = tokens[0];
    if (!head) continue;

    const migration = MIGRATION_RESETS.find(([re]) => re.test(seg));
    if (migration) {
      out.push({ call_key: callKey, statement_class: migration[1] as DbActionRow['statement_class'], object_names: null, target_key: null, ts });
      continue;
    }

    // psql -c / mysql -e / mongosh --eval / sqlite3 <db> '<sql>'
    let sql: string | null = null;
    let target: string | null = null;
    if (head === 'psql' || head === 'pg_dump' || head === 'pg_restore') {
      const c = tokens.indexOf('-c');
      sql = c >= 0 ? (tokens[c + 1] ?? null) : null;
      const d = tokens.indexOf('-d');
      target = d >= 0 ? (tokens[d + 1] ?? null) : null;
    } else if (head === 'mysql') {
      const e = tokens.indexOf('-e');
      sql = e >= 0 ? (tokens[e + 1] ?? null) : null;
      const nonFlag = tokens.slice(1).find((t) => !t.startsWith('-'));
      target = nonFlag ?? null;
    } else if (head === 'mongosh') {
      const e = tokens.findIndex((t) => t === '--eval');
      sql = e >= 0 ? (tokens[e + 1] ?? null) : null;
      target = tokens.find((t) => !t.startsWith('-') && t !== head && t !== sql) ?? null;
    } else if (head === 'sqlite3') {
      // sqlite3 <db> '<sql>'
      const positional = tokens.slice(1).filter((t) => !t.startsWith('-'));
      target = positional[0] ?? null;
      sql = positional[1] ?? null;
    } else continue;

    if (!sql) continue;
    const cls = classifySql(sql);
    if (!cls) continue;
    out.push({ call_key: callKey, statement_class: cls, object_names: sqlObjectNames(sql).join(',') || null, target_key: target, ts });
  }
  return out;
}

// ── vcs_actions: gitOperation (structured) with a parsed fallback ────────────

/** The agent's own structured git record (toolUseResult.gitOperation). */
export function parseGitOperation(
  callKey: string,
  gitOperation: unknown,
  ts: number | null,
  repo: string | null,
): VcsActionRow[] {
  if (!gitOperation || typeof gitOperation !== 'object') return [];
  const g = gitOperation as Record<string, unknown>;
  const out: VcsActionRow[] = [];
  const push = g.push as Record<string, unknown> | undefined;
  if (push) {
    out.push({
      call_key: callKey,
      verb: 'push',
      repo,
      escape_state: 'pushed',
      push_evidence: JSON.stringify({ source: 'structured', branch: push.branch ?? null }),
      ts,
    });
  }
  const commit = g.commit as Record<string, unknown> | undefined;
  if (commit) {
    out.push({
      call_key: callKey,
      verb: 'commit',
      repo,
      escape_state: 'committed',
      push_evidence: JSON.stringify({ source: 'structured', branch: commit.branch ?? null, sha: commit.sha ?? null }),
      ts,
    });
  }
  const branch = g.branch as Record<string, unknown> | undefined;
  if (branch && typeof branch.action === 'string') {
    out.push({
      call_key: callKey,
      verb: branch.action,
      repo,
      escape_state: 'committed',
      push_evidence: JSON.stringify({ source: 'structured', ref: branch.ref ?? null }),
      ts,
    });
  }
  return out;
}

/** git verbs from the command string — escape_state from the verb, evidence NULL. */
export function parseVcsCommand(callKey: string, name: string, args: unknown, ts: number | null): VcsActionRow[] {
  const cmd = commandOf(name, args);
  if (!cmd) return [];
  const out: VcsActionRow[] = [];
  for (const seg of commandSegments(cmd)) {
    const tokens = shellTokens(seg);
    if (tokens[0] !== 'git') continue;
    const sub = tokens[1];
    if (sub === 'push') out.push({ call_key: callKey, verb: 'push', repo: null, escape_state: 'pushed', push_evidence: null, ts });
    else if (sub === 'commit') out.push({ call_key: callKey, verb: 'commit', repo: null, escape_state: 'committed', push_evidence: null, ts });
    else if (sub === 'merge' || sub === 'rebase') out.push({ call_key: callKey, verb: sub, repo: null, escape_state: 'local', push_evidence: null, ts });
  }
  return out;
}

// ── package_execs ─────────────────────────────────────────────────────────────

const INSTALL_HEADS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'cargo', 'go', 'brew', 'gem', 'uvx', 'npx', 'pnpx', 'bunx']);

/** Installs and fetch-and-runs (npx & friends), with registry provenance. */
export function parsePackageExecs(callKey: string, name: string, args: unknown, ts: number | null): PackageExecRow[] {
  const cmd = commandOf(name, args);
  if (!cmd) return [];
  const out: PackageExecRow[] = [];
  for (const seg of commandSegments(cmd)) {
    const tokens = shellTokens(seg);
    let head = tokens[0];
    let rest = tokens.slice(1);
    let fetch_and_run: 0 | 1 = 0;
    if (head === 'python3' || head === 'python') {
      if (rest[0] !== '-m' || rest[1] !== 'pip') continue;
      head = 'pip';
      rest = rest.slice(2);
    }
    if (!head || !INSTALL_HEADS.has(head)) continue;
    if (head === 'npx' || head === 'pnpx' || head === 'bunx' || head === 'uvx') fetch_and_run = 1;

    const registryFlag = rest.indexOf('--registry');
    const registry = registryFlag >= 0 ? (rest[registryFlag + 1] ?? null) : head === 'npm' || head === 'npx' ? 'npm' : head === 'pip' || head === 'pip3' || head === 'uv' || head === 'uvx' ? 'pypi' : head === 'cargo' ? 'crates.io' : head === 'go' ? 'go' : head === 'brew' ? 'homebrew' : head === 'gem' ? 'rubygems' : null;

    const isInstall = fetch_and_run === 1 || rest[0] === 'install' || rest[0] === 'i' || rest[0] === 'add' || (head === 'brew' && (rest[0] === 'install' || rest[0] === 'upgrade'));
    if (!isInstall) continue;

    const names = rest
      .slice(1)
      .filter((t) => !t.startsWith('-') && !t.includes('='))
      .map((t) => t.replace(/@[\w.\-^~]+$/, ''))
      .filter(Boolean);
    if (!names.length) {
      out.push({ call_key: callKey, package_name: null, registry, fetch_and_run, ts });
      continue;
    }
    for (const n of names.slice(0, 12)) out.push({ call_key: callKey, package_name: n, registry, fetch_and_run, ts });
  }
  return out;
}

// ── fetch_ingress ─────────────────────────────────────────────────────────────

/**
 * WebFetch's own receipt ({bytes, code, durationMs, url}) or a curl command's URL.
 * The host is the finding and is stored in clear; a curl without a parseable URL
 * yields no row (ingress unknown, never zero).
 */
export function parseFetchIngress(
  callKey: string,
  input: { url?: unknown; bytes?: unknown; code?: unknown } | string | null,
  ts: number | null,
): FetchIngressRow | null {
  if (input && typeof input === 'object') {
    const url = typeof input.url === 'string' ? input.url : null;
    const host = url ? hostOf(url) : null;
    if (!host && input.bytes === undefined && input.code === undefined) return null;
    return {
      call_key: callKey,
      url_host: host,
      status: typeof input.code === 'number' ? input.code : null,
      bytes: typeof input.bytes === 'number' ? input.bytes : null,
      ts,
    };
  }
  if (typeof input === 'string') {
    const url = shellTokens(input).find((t) => /^https?:\/\//.test(t) || /^[a-z0-9.\-]+\.[a-z]{2,}\//i.test(t));
    if (!url) return null;
    return { call_key: callKey, url_host: hostOf(url), status: null, bytes: null, ts };
  }
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).host || null;
  } catch {
    return null;
  }
}

// ── sensitive_access: the path-class pack ────────────────────────────────────

/** Versioned path-class pack v1 — the directory is the signal, never content. */
export const PATH_CLASS_PACK_VERSION = 1;
export const PATH_CLASS_PACK: Array<{ pattern_id: string; class: string; pattern: RegExp }> = [
  { pattern_id: 'ssh-private-key-v1', class: 'ssh_private_key', pattern: /(^|\/)\.ssh\/(id_rsa|id_ed25519|id_ecdsa|id_dsa|identity|authorized_keys|config)|\.pem$|\.key$/i },
  { pattern_id: 'dotenv-v1', class: 'dotenv', pattern: /(^|\/)\.env(\.[\w.]+)?$/i },
  { pattern_id: 'cloud-credentials-v1', class: 'cloud_credentials', pattern: /(^|\/)\.aws\/|(^|\/)\.config\/gcloud|(^|\/)\.azure\/|credentials\.json$/i },
  { pattern_id: 'agent-credentials-v1', class: 'agent_credentials', pattern: /(^|\/)\.claude\/\.credentials|(^|\/)\.codex\/auth\.json|(^|\/)\.gemini\/.*(oauth|credentials)|_api_key/i },
  { pattern_id: 'keychain-v1', class: 'keychain', pattern: /Keychains\/|\.keychain($|\/)|login\.keychain-db/i },
  { pattern_id: 'npm-token-v1', class: 'npm_token', pattern: /(^|\/)\.npmrc$/i },
  { pattern_id: 'kube-config-v1', class: 'kube_config', pattern: /(^|\/)\.kube\/config|kubeconfig/i },
  { pattern_id: 'browser-profile-v1', class: 'browser_profile', pattern: /Application Support\/[^/]+\/(Default|Profile \d)\/(Cookies|Login Data)|Library\/Cookies/i },
];

/** Classify a path against the pack. null = not a sensitive class. */
export function classifyPath(p: string): { pattern_id: string; class: string } | null {
  for (const entry of PATH_CLASS_PACK) {
    if (entry.pattern.test(p)) return { pattern_id: entry.pattern_id, class: entry.class };
  }
  return null;
}

/**
 * Salted digest of a normalised path — the matrix stores which class of path was
 * touched under which basis, never which path. ponytail: the salt is a build-time
 * constant; rotating it through the Keychain fingerprint key is the upgrade path
 * if path hashes ever need to be uncorrelatable across installs.
 */
export function pathHash(p: string): string {
  const normalised = p.replace(/\/+$/, '').replace(/^~\/?/, '$HOME/');
  return createHash('sha256').update(`vole:path:v${PATH_CLASS_PACK_VERSION}:${normalised}`).digest('hex').slice(0, 32);
}

/** Extract path-like tokens from tool arguments and reduce them to matrix rows. */
export function parseSensitiveAccess(
  callKey: string,
  name: string,
  args: unknown,
  authorizationBasis: string | null,
  ts: number | null,
): SensitiveAccessRow[] {
  const candidates = new Set<string>();
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    for (const k of ['file_path', 'path', 'notebook_path', 'filename', 'pattern']) {
      if (typeof a[k] === 'string') candidates.add(a[k] as string);
    }
  }
  const cmd = commandOf(name, args);
  if (cmd) {
    for (const seg of commandSegments(cmd)) {
      for (const t of shellTokens(seg)) {
        if (t.includes('/') || t.startsWith('~/') || /\.(pem|key|env|npmrc|keychain)/i.test(t)) candidates.add(t);
      }
    }
  } else if (typeof args === 'string') {
    candidates.add(args);
  }

  const window_start = ts !== null ? Math.floor(ts / 86400000) * 86400000 : 0;
  const out: SensitiveAccessRow[] = [];
  for (const p of candidates) {
    const cls = classifyPath(p);
    if (!cls) continue;
    out.push({ path_class: cls.class, path_hash: pathHash(p), authorization_basis: authorizationBasis, count: 1, window_start });
  }
  return out;
}

// ── destructive target scope (cwd-relative blast radius) ──────────────────────

const DESTRUCTIVE_VERBS = new Set(['rm', 'rmdir', 'shred', 'truncate', 'mkfs', 'unlink']);

export type TargetScope = 'inside_cwd' | 'outside_cwd' | 'home' | 'root' | 'unresolved';

const SYSTEM_ROOTS = new Set(['/', '/etc', '/usr', '/var', '/bin', '/sbin', '/System', '/Library', '/private', '/Applications', '/opt', '/etc/paths.d']);

/**
 * Resolve what a destructive command would have destroyed, relative to the entry's
 * own cwd. 'unresolved' whenever the operand carries a variable, substitution or
 * glob Vole cannot expand — never a guess. NULL cwd (unknown) also resolves to
 * 'unresolved' for non-absolute operands, never to a fictional cwd.
 */
export function resolveTargetScope(cmd: string, cwd: string | null): { scope: TargetScope; target: string | null } {
  for (const seg of commandSegments(cmd)) {
    const tokens = shellTokens(seg);
    const head = tokens[0];
    if (!head) continue;
    if (head === 'git' && (tokens[1] === 'clean' || tokens[1] === 'reset')) {
      return scopeOfOperand(tokens.slice(2).find((t) => !t.startsWith('-')) ?? '.', cwd);
    }
    if (!DESTRUCTIVE_VERBS.has(head)) continue;
    const operand = tokens.slice(1).find((t) => !t.startsWith('-'));
    if (operand === undefined) return { scope: 'unresolved', target: null };
    return scopeOfOperand(operand, cwd);
  }
  return { scope: 'unresolved', target: null };
}

function scopeOfOperand(operand: string, cwd: string | null): { scope: TargetScope; target: string } {
  // Unexpandable constructs degrade to 'unresolved' — the danger may live in the
  // variable, and classifying it as safe would be the one wrong answer.
  if (/\$\(|`|\$\{(?!\{)|\*|\?/.test(operand)) return { scope: 'unresolved', target: operand };
  if (/\$(?!HOME\b)[A-Za-z_]/.test(operand)) return { scope: 'unresolved', target: operand };

  let abs: string;
  if (operand.startsWith('~/') || operand === '~') {
    abs = operand.replace(/^~/, process.env.HOME ?? '/home');
  } else if (operand.startsWith('/')) {
    abs = operand;
  } else if (operand.startsWith('$HOME')) {
    abs = operand.replace(/^\$HOME/, process.env.HOME ?? '/home');
  } else {
    if (!cwd) return { scope: 'unresolved', target: operand };
    abs = `${cwd.replace(/\/+$/, '')}/${operand}`;
  }
  abs = normalizeAbs(abs);
  const home = process.env.HOME ?? '';
  if (cwd && (abs === normalizeAbs(cwd) || abs.startsWith(`${normalizeAbs(cwd)}/`))) return { scope: 'inside_cwd', target: operand };
  if (home && (abs === home || abs.startsWith(`${home}/`))) return { scope: 'home', target: operand };
  const systemPrefix = SYSTEM_ROOTS.has(abs) || [...SYSTEM_ROOTS].some((r) => abs.startsWith(`${r}/`));
  if (systemPrefix || abs.split('/').filter(Boolean).length <= 1) return { scope: 'root', target: operand };
  return { scope: 'outside_cwd', target: operand };
}

/** Lexically resolve . and .. — a shell-true resolver is out of scope by design. */
function normalizeAbs(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

// ── PATH precedence (agent_wrote_persistence's structured fact) ───────────────

export interface PathEntryFact {
  entry: string;
  position: 'prepend' | 'append';
  dir_writable_by_principal: boolean | null;
}

/** Parse the PATH assignment out of a shell rc text (export PATH="..." | PATH=...). */
export function parsePathAssignment(text: string): string[] | null {
  const m = /(?:export\s+)?PATH=(["']?)([^"'\n]+)\1/.exec(text);
  if (!m || !m[2]) return null;
  return m[2].split(':').filter(Boolean);
}

/**
 * Diff the PATH between pre- and post-image of a shell rc: which entries appeared
 * and whether they were prepended (decide which binary runs next login) or
 * appended. Writability is one stat of the directory — NULL when it cannot be
 * stated (missing dir), never a guess.
 */
export function pathPrecedenceFacts(oldText: string, newText: string): Omit<PathEntryFact, 'dir_writable_by_principal'>[] {
  const oldPath = parsePathAssignment(oldText);
  const newPath = parsePathAssignment(newText);
  if (!newPath) return [];
  const oldSet = new Set(oldPath ?? []);
  const facts: Omit<PathEntryFact, 'dir_writable_by_principal'>[] = [];
  for (let i = 0; i < newPath.length; i++) {
    const entry = newPath[i] as string;
    if (oldSet.has(entry)) continue;
    facts.push({ entry, position: i === 0 ? 'prepend' : 'append' });
  }
  return facts;
}

/** One stat: is this directory writable by its owning principal? NULL = unknown. */
export function dirWritableByPrincipal(dir: string): boolean | null {
  try {
    const st = statSync(dir);
    return (st.mode & 0o200) === 0o200; // owner-write bit
  } catch {
    return null;
  }
}

// ── call-scope resolution (cross_scope_read_then_publish) ─────────────────────

/**
 * The scope a call touched, from the MCP server's own argument names (owner, repo,
 * url, path, host). Returns null when the server's argument names resolve nothing —
 * the rule does not fire on a guess.
 */
export function resolveCallScope(name: string, args: unknown, cwd: string | null): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  if (typeof a.owner === 'string' && typeof a.repo === 'string') return `${a.owner}/${a.repo}`;
  if (typeof a.url === 'string') {
    try {
      const u = new URL(a.url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${u.host}/${parts[0]}/${parts[1]}`;
      return u.host;
    } catch {
      return null;
    }
  }
  if (typeof a.host === 'string') return a.host;
  if (typeof a.repository === 'string') return a.repository.replace(/^.*\//, '');
  if (typeof a.path === 'string' && cwd) {
    // Filesystem scope: the repo root the path resolves under, when one exists.
    const abs = a.path.startsWith('/') ? a.path : `${cwd.replace(/\/+$/, '')}/${a.path}`;
    let dir = abs;
    for (let i = 0; i < 8 && dir.includes('/'); i++) {
      if (existsSync(`${dir}/.git`)) return dir;
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
    return abs;
  }
  return null;
}

// ── writes ───────────────────────────────────────────────────────────────────

/** Upsert a parsed batch. Idempotent: re-emitting the same rows is a no-op. */
export function writeNetLedgers(db: DB, batch: NetLedgerBatch): number {
  let n = 0;
  const run = db.transaction(() => {
    const ce = db.prepare('INSERT OR IGNORE INTO context_edges (call_key, transport, verb, destination, direction, ts) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of batch.contextEdges ?? []) n += ce.run(r.call_key, r.transport, r.verb, r.destination, r.direction, r.ts).changes;
    const da = db.prepare('INSERT OR IGNORE INTO db_actions (call_key, statement_class, object_names, target_key, ts) VALUES (?, ?, ?, ?, ?)');
    for (const r of batch.dbActions ?? []) n += da.run(r.call_key, r.statement_class, r.object_names, r.target_key, r.ts).changes;
    const re = db.prepare('INSERT OR IGNORE INTO remote_exec (call_key, hop, host, user, inner_pattern, ts) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of batch.remoteExec ?? []) n += re.run(r.call_key, r.hop, r.host, r.user, r.inner_pattern, r.ts).changes;
    const va = db.prepare('INSERT OR IGNORE INTO vcs_actions (call_key, verb, repo, escape_state, push_evidence, ts) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of batch.vcsActions ?? []) n += va.run(r.call_key, r.verb, r.repo, r.escape_state, r.push_evidence, r.ts).changes;
    const pe = db.prepare('INSERT OR IGNORE INTO package_execs (call_key, package_name, registry, fetch_and_run, ts) VALUES (?, ?, ?, ?, ?)');
    for (const r of batch.packageExecs ?? []) n += pe.run(r.call_key, r.package_name, r.registry, r.fetch_and_run, r.ts).changes;
    const fi = db.prepare('INSERT OR IGNORE INTO fetch_ingress (call_key, url_host, status, bytes, ts) VALUES (?, ?, ?, ?, ?)');
    for (const r of batch.fetchIngress ?? []) n += fi.run(r.call_key, r.url_host, r.status, r.bytes, r.ts).changes;
    const sa = db.prepare(`INSERT INTO sensitive_access (path_class, path_hash, authorization_basis, count, window_start)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path_class, path_hash, window_start) DO UPDATE SET
        count = count + excluded.count,
        authorization_basis = COALESCE(sensitive_access.authorization_basis, excluded.authorization_basis)`);
    for (const r of batch.sensitiveAccess ?? []) n += sa.run(r.path_class, r.path_hash, r.authorization_basis, r.count, r.window_start).changes;
  });
  run();
  return n;
}

// ── from-store emission (the coarse half, no collector changes required) ─────

const CANDIDATE_HEADS = new Set([
  'ssh', 'scp', 'rsync', 'sshfs', 'mosh', 'docker', 'kubectl', 'podman', 'colima',
  'limactl', 'tart', 'runpod', 'vagrant', 'modal', 'devcontainer', 'gh', 'psql',
  'mysql', 'mongosh', 'sqlite3', 'drizzle-kit', 'prisma', 'alembic', 'git', 'npm',
  'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'npx', 'pnpx', 'bunx', 'uvx', 'cargo', 'go', 'brew', 'gem',
]);

/**
 * Derive ledger rows from the stored shapes: transport/git/install verbs with
 * destination and object names left NULL ("not recorded"). Rich rows come only
 * from bind-time parsing, where the raw arguments exist. Idempotent: a call with
 * a row in a ledger is never reprocessed for that ledger.
 */
export function emitNetLedgers(db: DB): { context_edges: number; vcs_actions: number; package_execs: number; remote_exec: number } {
  const presence = new Set<string>();
  for (const t of ['context_edges', 'db_actions', 'remote_exec', 'vcs_actions', 'package_execs', 'fetch_ingress']) {
    for (const r of db.prepare(`SELECT DISTINCT call_key AS k FROM ${t}`).all() as { k: string }[]) presence.add(r.k);
  }

  const rows = db
    .prepare(`SELECT tool_call_key AS key, tool, name, shape, session_id, ts FROM tool_calls WHERE shape IS NOT NULL`)
    .all() as { key: string; tool: string; name: string; shape: string; session_id: string | null; ts: number }[];

  const edges: ContextEdgeRow[] = [];
  const vcs: VcsActionRow[] = [];
  const pkgs: PackageExecRow[] = [];
  const rex: RemoteExecRow[] = [];
  const aliases = loadSshConfig(join(home(), '.ssh', 'config'));

  for (const r of rows) {
    const head = r.shape.split(' ')[0] ?? '';
    if (!CANDIDATE_HEADS.has(head)) continue;
    const cmd = r.shape; // the skeleton is all the store holds — coarse by design

    if (!presence.has(r.key)) {
      for (const seg of commandSegments(cmd)) {
        const row = parseSegmentCrossing(r.key, seg, r.ts, true);
        if (row) edges.push(row);
      }
    }
    if (!presence.has(r.key)) {
      // git verbs survive the skeleton; repos do not.
      const vr = parseVcsCommand(r.key, 'Bash', cmd, r.ts);
      if (vr.length) vcs.push(...vr);
    }
    if (!presence.has(r.key)) {
      const pr = parsePackageExecs(r.key, 'Bash', cmd, r.ts);
      if (pr.length) pkgs.push(...pr);
    }
    if (!presence.has(r.key) && (head === 'ssh' || head === 'docker' || head === 'kubectl')) {
      const rr = parseRemoteExec(r.key, 'Bash', cmd, r.ts, aliases);
      if (rr.length) rex.push(...rr);
    }
  }

  writeNetLedgers(db, { contextEdges: edges, vcsActions: vcs, packageExecs: pkgs, remoteExec: rex });
  return { context_edges: edges.length, vcs_actions: vcs.length, package_execs: pkgs.length, remote_exec: rex.length };
}

import type { DB } from '../db';

/**
 * The versioned command/path pattern pack (tier 5 feature 15 + 38): ONE pack
 * with ONE version stamps command skeletons (pattern_id on tool_calls), path
 * classes (the path_classes table), the destructive classifier and the
 * target-extraction rules — never a second parser. Bump COMMAND_PACK_VERSION
 * only with a coordinated content change; pattern_ids are stable identities,
 * so a bumped pack can re-scan retained evidence under the new version.
 */

export const COMMAND_PACK_VERSION = 1;

export interface CommandPattern {
  pattern_id: string;
  class: string;
  /** Matched against the segment string after prefix-stripping. */
  re: RegExp;
}

/** Command-shape classes. `destructive` feeds the blast-radius counters. */
export const COMMAND_PATTERNS: CommandPattern[] = [
  { pattern_id: 'cmd/rm', class: 'destructive', re: /^rm\b/ },
  { pattern_id: 'cmd/dd', class: 'destructive', re: /^dd\b/ },
  { pattern_id: 'cmd/mkfs', class: 'destructive', re: /^mkfs\b/ },
  { pattern_id: 'cmd/shred', class: 'destructive', re: /^shred\b/ },
  { pattern_id: 'cmd/truncate', class: 'destructive', re: /^truncate\b/ },
  { pattern_id: 'cmd/sudo', class: 'privileged', re: /^sudo\b/ },
  { pattern_id: 'cmd/base64-decode', class: 'decode', re: /^base64\s+(-\w*)?d/ },
  { pattern_id: 'cmd/curl', class: 'network_fetch', re: /^curl\b/ },
  { pattern_id: 'cmd/wget', class: 'network_fetch', re: /^wget\b/ },
  { pattern_id: 'cmd/ssh', class: 'remote_transport', re: /^ssh\b/ },
  { pattern_id: 'cmd/scp', class: 'remote_transport', re: /^scp\b/ },
  { pattern_id: 'cmd/rsync', class: 'remote_transport', re: /^rsync\b/ },
  { pattern_id: 'cmd/git', class: 'vcs', re: /^git\b/ },
  { pattern_id: 'cmd/gh', class: 'vcs', re: /^gh\b/ },
  { pattern_id: 'cmd/psql', class: 'db_client', re: /^psql\b/ },
  { pattern_id: 'cmd/mysql', class: 'db_client', re: /^mysql\b/ },
  { pattern_id: 'cmd/npm-install', class: 'package_install', re: /^(npm|pnpm|yarn|bun)\s+install\b/ },
  { pattern_id: 'cmd/pip-install', class: 'package_install', re: /^(pip|pip3|uv|uvx)\s+install\b/ },
  { pattern_id: 'cmd/brew-install', class: 'package_install', re: /^brew\s+(install|upgrade)\b/ },
  { pattern_id: 'cmd/npx', class: 'package_fetch_run', re: /^(npx|pnpm)\s+(dlx|exec)\b/ },
  { pattern_id: 'cmd/pipx-run', class: 'package_fetch_run', re: /^pipx\s+run\b/ },
  { pattern_id: 'cmd/kubectl', class: 'k8s', re: /^kubectl\b/ },
  { pattern_id: 'cmd/docker', class: 'container', re: /^docker\b/ },
];

export interface PathClassPattern {
  pattern_id: string;
  class: string;
  re: RegExp;
  /** Envelope writes change configuration, permissions or persistence — the
   *  change_risk_class the security_envelope rules weight. */
  envelope: boolean;
}

/** The path-class pack: what a written/read path IS, never what it contains. */
export const PATH_CLASSES: PathClassPattern[] = [
  { pattern_id: 'path/ssh-private-key', class: 'ssh_private_key', re: /(^|\/)\.ssh\/|(^|\/)id_(rsa|ed25519|ecdsa)\b|\.pem$/i, envelope: true },
  { pattern_id: 'path/dotenv', class: 'dotenv', re: /(^|\/)\.env(\.|$)/i, envelope: true },
  { pattern_id: 'path/kube-config', class: 'kube_config', re: /(^|\/)\.?kube\/?config|kubeconfig/i, envelope: true },
  { pattern_id: 'path/aws-credentials', class: 'aws_credentials', re: /(^|\/)\.aws\/(credentials|config)$/i, envelope: true },
  { pattern_id: 'path/netrc', class: 'netrc', re: /(^|\/)\.netrc$/i, envelope: true },
  { pattern_id: 'path/shell-rc', class: 'shell_rc', re: /(^|\/)\.(zshrc|bashrc|bash_profile|profile|zprofile|zshenv)$/i, envelope: true },
  { pattern_id: 'path/agent-config', class: 'agent_config', re: /(^|\/)\.claude\/settings|settings\.local\.json|\.codex\/config|\.vole\//i, envelope: true },
  { pattern_id: 'path/launch-agent', class: 'launch_agent', re: /LaunchAgents|LaunchDaemons|\/etc\/periodic|StartupItems/i, envelope: true },
  { pattern_id: 'path/crontab', class: 'crontab', re: /crontab/i, envelope: true },
  { pattern_id: 'path/git-hook', class: 'git_hook', re: /\/\.git\/hooks\//i, envelope: true },
  { pattern_id: 'path/vcs-state', class: 'vcs_state', re: /\/\.git\//i, envelope: false },
  { pattern_id: 'path/manifest', class: 'manifest', re: /(^|\/)(package|pyproject|cargo|go|gemfile)(\-lock)?\.(json|toml|lock|mod|rb)$/i, envelope: false },
  { pattern_id: 'path/ignorefile', class: 'ignorefile', re: /(^|\/)\.(gitignore|dockerignore)$/i, envelope: false },
];

/** Sync the path-class portion of the pack into path_classes (idempotent —
 *  pattern_id + pack_version is the key, first_seen is written once). */
export function syncPathClasses(db: DB): number {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO path_classes (pattern_id, pack_version, class, pattern, first_seen)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const p of PATH_CLASSES) n += stmt.run(p.pattern_id, COMMAND_PACK_VERSION, p.class, p.re.source, now).changes;
  return n;
}

/** Split a command on top-level &&, ||, ; and |, honouring quotes. */
export function splitCommandSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let i = 0;
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) { cur += c + cmd[i + 1]!; i += 2; continue; }
      if (c === quote) quote = null;
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '|' && cmd[i + 1] === '|') {
      push(); i += 2; continue;
    } else if (c === '&' && cmd[i + 1] === '&') {
      push(); i += 2; continue;
    } else if (c === ';' || c === '|' || c === '\n') {
      push();
    } else {
      cur += c;
    }
    i++;
  }
  push();
  return out;
}

/** Tokenise one segment on whitespace, honouring quotes. */
export function tokenize(segment: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Strip leading `VAR=...` assignments and a leading `cd <dir>` pair (spec: the
 *  cd is a location change, not the action being classified). */
export function stripPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  if (tokens[i] === 'cd' && i + 1 < tokens.length) i += 2;
  return tokens.slice(i);
}

/** First pack pattern whose shape matches any segment, else NULL. */
export function classifyCommand(command: string): { pattern_id: string; pack_version: number } | null {
  for (const seg of splitCommandSegments(command)) {
    const head = stripPrefixes(tokenize(seg));
    if (!head.length) continue;
    for (const p of COMMAND_PATTERNS) {
      if (p.re.test(head.join(' ')) || p.re.test(head[0]!)) {
        return { pattern_id: p.pattern_id, pack_version: COMMAND_PACK_VERSION };
      }
    }
  }
  return null;
}

/** Classify a path against the versioned path pack. */
export function classifyPath(p: string): { pattern_id: string; class: string; change_risk_class: 'envelope' | 'content' } | null {
  for (const pc of PATH_CLASSES) {
    if (pc.re.test(p)) {
      return { pattern_id: pc.pattern_id, class: pc.class, change_risk_class: pc.envelope ? 'envelope' : 'content' };
    }
  }
  return null;
}

/** The command-shape skeleton (spec 15): head + known flags + host names kept,
 *  paths/args collapsed, variables and substitutions opaque. Quoted for incident
 *  detail lines — the ledger stores pattern_id, never this string's content. */
export function commandSkeleton(command: string): string {
  const FLAGGED: Record<string, string[]> = {
    rm: ['-rf', '-fr', '-r', '-f'],
    ssh: ['-t', '-p'],
    scp: ['-r', '-P'],
    rsync: ['-a', '-v', '-z', '--delete'],
    docker: ['exec', 'run', 'ps', 'build', 'kill', 'rm'],
    kubectl: ['exec', 'get', 'delete', 'apply', 'logs'],
    git: ['push', 'pull', 'commit', 'reset', 'checkout', 'clone', 'clean'],
    curl: ['-X', '-d', '-H', '-L', '-s'],
    psql: ['-c', '-U', '-h'],
    mysql: ['-e', '-u', '-h'],
    base64: ['-d'],
  };
  const tokenShape = (t: string): string => {
    if (/^\$\{?[A-Za-z_]/.test(t) || /\$\(/.test(t) || /`/.test(t)) return '<var>';
    // user@host and user@host:path — the host is the finding, the path is not.
    const hostish = /^(?:[\w.-]+@)?([\w.-]+\.[A-Za-z]{2,})(?::|$)/.exec(t);
    if (hostish) return hostish[1]!;
    if (/^~?\//.test(t) || t.includes('/')) return '*';
    if (/^-/.test(t)) return t; // flags kept verbatim
    if (/^[A-Za-z0-9._-]+\.[A-Za-z]{2,}$/.test(t)) return t; // a bare host — kept
    return '*';
  };
  return splitCommandSegments(command)
    .map((seg) => {
      const raw = stripPrefixes(tokenize(seg));
      if (!raw.length) return '';
      const head = raw[0]!; // the program name survives verbatim
      const toks = raw.slice(1).map(tokenShape);
      const known = FLAGGED[head];
      // Keep known flags and host tokens; everything else already collapsed.
      const kept = toks.filter((t) => t !== '*' && t !== '<var>' && (known?.includes(t) || /^[A-Za-z0-9._-]+\.[A-Za-z]{2,}$/.test(t)));
      return kept.length ? `${head} ${kept.join(' ')}` : head;
    })
    .filter(Boolean)
    .join(' && ');
}

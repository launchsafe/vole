import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { agentHomes, editorRoots, paths, AGENT_HOME_ENV_VARS } from '../paths';
import { openDb, insertAnomalies } from '../db';
import type { DB, Scanner } from '../db';
import type { Anomaly } from '../types';

/**
 * The agent-home census (tier 2 features 7/30/31): every root an agent could
 * keep state under, enumerated by marker and declaration rather than a name
 * list, written to agent_roots every pass so agent_home_moved can fire on any
 * session that lives outside the census. Roots are probed with the four-state
 * read test into scan_access — existsSync is not a permission oracle.
 */

/** The four-state read probe: ok | absent | eperm | error, with errno. */
export function probeRoot(root: string): { state: 'ok' | 'absent' | 'eperm' | 'error'; errno: string | null; entries: number | null } {
  try {
    const entries = readdirSync(root).length;
    return { state: 'ok', errno: null, entries };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { state: 'absent', errno: null, entries: null };
    if (e.code === 'EACCES' || e.code === 'EPERM') return { state: 'eperm', errno: e.code ?? null, entries: null };
    return { state: 'error', errno: e.code ?? String(e.message), entries: null };
  }
}

export interface RootRow {
  root_path: string;
  tool: string;
  discovered_by: string;
}

/** Editor roots by marker, plus their on-disk profiles — the resolved dimension. */
export function editorRootRows(): RootRow[] {
  const out: RootRow[] = [];
  for (const r of editorRoots()) {
    out.push({ root_path: r.root, tool: `editor:${r.app}`, discovered_by: 'marker:User/globalStorage/storage.json' });
    try {
      const profiles = join(r.root, 'User', 'profiles');
      for (const id of readdirSync(profiles)) {
        out.push({ root_path: join(profiles, id), tool: `editor:${r.app}`, discovered_by: 'profile' });
      }
    } catch {
      /* no profiles dir: this root has only the default profile */
    }
  }
  return out;
}

/** The full census: agent homes from every discovery channel plus editor roots. */
export function censusRoots(): RootRow[] {
  const agent = agentHomes().map((h) => ({ root_path: h.path, tool: h.tool, discovered_by: h.granted_by }));
  return [...agent, ...editorRootRows()];
}

/** Upsert the census. Keys are the migration-20 UNIQUE keys; a stored
 *  discovered_by is never overwritten by a re-derivation (NULL-only widening). */
export function upsertAgentRoots(db: DB, roots: RootRow[], now: number): number {
  const stmt = db.prepare(`
    INSERT INTO agent_roots (root_path, tool, discovered_by, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(root_path) DO UPDATE SET
      last_seen = excluded.last_seen,
      tool = excluded.tool,
      discovered_by = COALESCE(agent_roots.discovered_by, excluded.discovered_by)`);
  for (const r of roots) stmt.run(r.root_path, r.tool, r.discovered_by, now, now);
  return roots.length;
}

/** Record the four-state probe for each root under our own launch_context. */
export function recordScanAccess(db: DB, roots: RootRow[], now: number): { ok: number; notOk: number } {
  const stmt = db.prepare(`
    INSERT INTO scan_access (root, launch_context, state, errno, entries, last_ok_ts, last_ok_entries, last_result, first_seen, last_seen)
    VALUES (?, 'scanner:homes', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root, launch_context) DO UPDATE SET
      state = excluded.state,
      errno = excluded.errno,
      entries = excluded.entries,
      last_ok_ts = CASE WHEN excluded.state = 'ok' THEN excluded.last_ok_ts ELSE scan_access.last_ok_ts END,
      last_ok_entries = CASE WHEN excluded.state = 'ok' THEN excluded.entries ELSE scan_access.last_ok_entries END,
      last_result = excluded.last_result,
      last_seen = excluded.last_seen`);
  let ok = 0;
  let notOk = 0;
  for (const r of roots) {
    const p = probeRoot(r.root_path);
    if (p.state === 'ok') ok++;
    else notOk++;
    stmt.run(r.root_path, p.state, p.errno, p.entries, p.state === 'ok' ? now : null, p.state === 'ok' ? p.entries : null, p.state, now, now);
  }
  return { ok, notOk };
}

export interface LiveSessionFile {
  pid: number;
  sessionId: string;
  file: string;
}

/** Live Claude Code sessions: <claude home>/sessions/<pid>.json {pid, sessionId, …}. */
export function liveSessionFiles(claudeDir: string): LiveSessionFile[] {
  const out: LiveSessionFile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(join(claudeDir, 'sessions'));
  } catch {
    return out;
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const info = JSON.parse(readFileSync(join(claudeDir, 'sessions', f), 'utf8')) as { pid?: number; sessionId?: string };
      if (typeof info.sessionId === 'string') {
        out.push({ pid: info.pid ?? -1, sessionId: info.sessionId, file: join(claudeDir, 'sessions', f) });
      }
    } catch {
      /* malformed session file: skip */
    }
  }
  return out;
}

/** Which project root (if any) holds this session's transcript. */
export function transcriptRootFor(sessionId: string, projectRoots: string[]): string | null {
  for (const root of projectRoots) {
    try {
      for (const slug of readdirSync(root)) {
        if (existsSync(join(root, slug, `${sessionId}.jsonl`))) return root;
      }
    } catch {
      /* unreadable project root: it cannot vouch for the session */
    }
  }
  return null;
}

/** Parses KEY=VALUE tokens out of a `ps -E` command line (a live agent's environment). */
export function parsePsEnv(cmdline: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of cmdline.matchAll(/(?:^|\s)(CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_HOME|XDG_CONFIG_HOME|ANTHROPIC_BASE_URL)=([^\s"']+)/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

/** Env-var → tool, typed against the Tool union (no string casts into it). */
const ENV_TOOL: Record<string, Anomaly['tool']> = {
  CLAUDE_CONFIG_DIR: 'claude_code',
  CODEX_HOME: 'codex',
  GEMINI_HOME: 'gemini',
};

function psEnvironment(pid: number): Record<string, string> {
  if (pid <= 0) return {};
  try {
    // Same-uid processes only; ps -E shows the environment on macOS.
    const out = execFileSync('ps', ['-E', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return parsePsEnv(out);
  } catch {
    return {}; /* dead pid, other uid, or ps unavailable: no env evidence */
  }
}

/**
 * agent_home_moved, on the two exact signals: a LIVE session whose transcript
 * exists under no known root, or a redirect env name in a live agent's own
 * environment resolving outside every root in the census. ps sees only what is
 * alive at this instant — an agent that exited between passes leaves an
 * orphan-session trace that cannot say where it went.
 */
export function checkAgentHomeMoved(db: DB, now: number): Anomaly[] {
  const knownRoots = new Set(
    (db.prepare('SELECT root_path FROM agent_roots').all() as { root_path: string }[]).map((r) => r.root_path),
  );
  for (const h of agentHomes()) knownRoots.add(h.path);
  const projectRoots = paths.claudeCodeProjectRoots();
  const anomalies: Anomaly[] = [];
  const base = { severity: 'warn', model: null, baseline: null, threshold: null, confidence: 'exact', source: 'live' } as const;

  for (const s of liveSessionFiles(paths.claudeConfigDir())) {
    const root = transcriptRootFor(s.sessionId, projectRoots);
    if (root) continue;
    anomalies.push({
      anomaly_key: `agent_home_moved:session:${s.sessionId}`,
      rule: 'agent_home_moved',
      tool: 'claude_code',
      session_id: s.sessionId,
      window_start: now,
      window_end: now,
      title: 'Agent home moved: live session outside every known root',
      detail:
        `Live session ${s.sessionId} (pid file ${s.file}) has no transcript under any of the ` +
        `${projectRoots.length} known Claude Code project root(s) — the agent's state lives under a home ` +
        `this census cannot see (a CLAUDE_CONFIG_DIR redirect outside every discovered root).`,
      observed: 1,
      detected_at: now,
      ...base,
    });
  }

  for (const s of liveSessionFiles(paths.claudeConfigDir())) {
    for (const [envVar, value] of Object.entries(psEnvironment(s.pid))) {
      const meta = (AGENT_HOME_ENV_VARS as readonly string[]).includes(envVar) ? envVar : undefined;
      const inside = [...knownRoots].some((r) => value === r || value.startsWith(`${r}/`));
      if (meta && !inside) {
        anomalies.push({
          anomaly_key: `agent_home_moved:env:${envVar}:${value}`,
          rule: 'agent_home_moved',
          tool: ENV_TOOL[envVar]!,
          session_id: s.sessionId,
          window_start: now,
          window_end: now,
          title: `Agent home moved: ${envVar} points outside the census`,
          detail:
            `A live agent (pid ${s.pid}, session ${s.sessionId}) runs with ${envVar}=${value}, which is ` +
            `outside every root the census knows — its transcripts are invisible to the default collectors.`,
          observed: 1,
          detected_at: now,
          ...base,
        });
      }
    }
  }
  return anomalies;
}

export const homesScanner: Scanner = {
  name: 'agent-homes',
  cadenceMs: 5 * 60_000,
  run: () => {
    const db: DB = openDb();
    const now = Date.now();
    const roots = censusRoots();
    upsertAgentRoots(db, roots, now);
    const access = recordScanAccess(db, roots, now);
    const anomalies = checkAgentHomeMoved(db, now);
    if (anomalies.length) insertAnomalies(db, anomalies);
    const editorCount = roots.filter((r) => r.tool.startsWith('editor:')).length;
    return {
      ok: true,
      notes:
        `${roots.length} root(s) in the census (${editorCount} editor root/profile rows), ` +
        `${access.ok} readable, ${access.notOk} absent/denied/error` +
        (anomalies.length ? ` · ${anomalies.length} agent_home_moved signal(s)` : ''),
    };
  },
};

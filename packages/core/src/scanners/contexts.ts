import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { editorRoots, home } from '../paths';
import { Database } from '../sqlite';
import { openDb } from '../db';
import type { DB, Scanner } from '../db';

/**
 * execution_contexts (tier 2 feature 36): where the work actually ran — every
 * execution context this machine has evidence of, from five local reads and
 * zero network calls. There is no execution_contexts table yet (the foundation
 * seam stops at the execution_context_id columns), so the census lives in
 * ai_surfaces rows with identifier = context_key, kind = 'context', and this
 * scanner stamps context_key onto live usage_events/anomalies — NULL-only,
 * never overwriting a stored fact.
 *
 * A workspace URI proves an editor window, not an agent run; an SSH Host alias
 * proves configuration, not use. No tokens are ever estimated for a context.
 */

export interface ExecutionContext {
  /** Stamped on usage_events.execution_context_id; stable across passes. */
  context_key: string;
  kind: 'workspace' | 'remote_workspace' | 'ssh' | 'docker' | 'remote_host' | 'runtime';
  label: string;
  /** The folder URI, host alias or context name the key was derived from. */
  detail: string | null;
  evidence: string;
}

/** A stable, deterministic context key for a workspace URI (sha256, 12 hex). */
function keyFor(uri: string): string {
  return `ws:${createHash('sha256').update(uri).digest('hex').slice(0, 12)}`;
}

/** Same, for remote workspace URIs. */
function remoteKeyFor(uri: string): string {
  return `rws:${createHash('sha256').update(uri).digest('hex').slice(0, 12)}`;
}

/** file:// → filesystem path; null for anything that is not a local folder. */
export function localPathOf(folderUri: string): string | null {
  try {
    const u = new URL(folderUri);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname);
    return null;
  } catch {
    return null;
  }
}

/** workspace.json + storage.json + state.vscdb folder URIs for one editor root. */
export function workspaceContexts(root: string, app: string): ExecutionContext[] {
  const out: ExecutionContext[] = [];
  const seen = new Set<string>();
  const add = (uri: string, evidence: string) => {
    const k = keyFor(uri);
    if (seen.has(k)) return;
    seen.add(k);
    let remote: string | null = null;
    try {
      const u = new URL(uri);
      if (u.protocol === 'vscode-remote:') remote = u.hostname || u.host;
    } catch {
      /* not a URI: treat as local */
    }
    if (remote) {
      out.push({ context_key: remoteKeyFor(uri), kind: 'remote_workspace', label: `${remote} (remote workspace)`, detail: uri, evidence });
    } else {
      out.push({ context_key: k, kind: 'workspace', label: localPathOf(uri) ?? uri, detail: uri, evidence });
    }
  };

  // (1) workspaceStorage/<hash>/workspace.json — one folder URI each.
  try {
    const wsRoot = join(root, 'User', 'workspaceStorage');
    for (const h of readdirSync(wsRoot)) {
      try {
        const w = JSON.parse(readFileSync(join(wsRoot, h, 'workspace.json'), 'utf8')) as { folder?: string };
        if (w.folder) add(w.folder, `${app} workspaceStorage/${h}/workspace.json`);
      } catch {
        /* no workspace.json in this hash dir: skip */
      }
    }
  } catch {
    /* no workspaceStorage */
  }

  // (2) globalStorage/storage.json — profile associations, backups, window state.
  try {
    const st = JSON.parse(readFileSync(join(root, 'User', 'globalStorage', 'storage.json'), 'utf8')) as {
      profileAssociations?: { workspaces?: Record<string, unknown> };
      backupWorkspaces?: { folders?: { folderUri?: string }[] };
      windowsState?: { lastActiveWindow?: { folder?: string } };
    };
    for (const uri of Object.keys(st.profileAssociations?.workspaces ?? {})) {
      add(uri, `${app} storage.json profileAssociations.workspaces`);
    }
    for (const f of st.backupWorkspaces?.folders ?? []) {
      if (f.folderUri) add(f.folderUri, `${app} storage.json backupWorkspaces.folders`);
    }
    const last = st.windowsState?.lastActiveWindow?.folder;
    if (last) add(last, `${app} storage.json windowsState.lastActiveWindow`);
  } catch {
    /* no readable storage.json */
  }

  // (3) state.vscdb ItemTable['history.recentlyOpenedPathsList'].
  const vscdb = join(root, 'User', 'globalStorage', 'state.vscdb');
  if (existsSync(vscdb)) {
    try {
      const db = new Database(vscdb, { readonly: true, fileMustExist: true });
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'").get() as { value: string } | undefined;
      db.close();
      const parsed = row ? (JSON.parse(row.value) as { entries?: { folderUri?: string }[] }) : null;
      for (const e of parsed?.entries ?? []) {
        if (e.folderUri) add(e.folderUri, `${app} state.vscdb history.recentlyOpenedPathsList`);
      }
    } catch {
      /* unreadable vscdb: the other two reads still run */
    }
  }
  return out;
}

/** ~/.ssh/config Host aliases — configuration, not use. */
export function sshContexts(): ExecutionContext[] {
  let text: string;
  try {
    text = readFileSync(join(home(), '.ssh', 'config'), 'utf8');
  } catch {
    return [];
  }
  const out: ExecutionContext[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^Host\s+(.+)$/i);
    if (!m) continue;
    for (const name of m[1]!.split(/\s+/)) {
      if (!name || name.includes('*') || name === '!') continue;
      out.push({ context_key: `ssh:${name}`, kind: 'ssh', label: name, detail: name, evidence: '~/.ssh/config Host alias' });
    }
  }
  return out;
}

/** Docker contexts (config.json currentContext + contexts/meta/&lt;hash&gt;/meta.json). */
export function dockerContexts(): ExecutionContext[] {
  const out: ExecutionContext[] = [];
  try {
    const cfg = JSON.parse(readFileSync(join(home(), '.docker', 'config.json'), 'utf8')) as { currentContext?: string };
    if (cfg.currentContext && cfg.currentContext !== 'default') {
      out.push({ context_key: `docker:${cfg.currentContext}`, kind: 'docker', label: cfg.currentContext, detail: cfg.currentContext, evidence: '~/.docker/config.json currentContext' });
    }
  } catch {
    /* no docker config */
  }
  try {
    const meta = join(home(), '.docker', 'contexts', 'meta');
    for (const h of readdirSync(meta)) {
      try {
        const m = JSON.parse(readFileSync(join(meta, h, 'meta.json'), 'utf8')) as { Name?: string; Endpoints?: Record<string, { Host?: string }> };
        if (m.Name) {
          out.push({
            context_key: `docker:${m.Name}`,
            kind: 'docker',
            label: m.Name,
            detail: m.Endpoints?.docker?.Host ?? null,
            evidence: `~/.docker/contexts/meta/${h}/meta.json`,
          });
        }
      } catch {
        /* malformed meta: skip */
      }
    }
  } catch {
    /* no contexts dir */
  }
  return out;
}

/** Container-runtime install evidence: binaries on PATH, apps, app-support dirs. */
export function runtimeContexts(): ExecutionContext[] {
  const out: ExecutionContext[] = [];
  const pathDirs = (process.env.PATH ?? '').split(':');
  for (const bin of ['docker', 'colima', 'limactl', 'podman', 'orbctl']) {
    const hit = pathDirs.some((d) => existsSync(join(d, bin)));
    if (hit) out.push({ context_key: `runtime:${bin}`, kind: 'runtime', label: bin, detail: null, evidence: `${bin} on PATH` });
  }
  for (const app of ['Docker.app', 'OrbStack.app']) {
    if (existsSync(join('/Applications', app))) {
      out.push({ context_key: `runtime:${app}`, kind: 'runtime', label: app, detail: null, evidence: `/Applications/${app}` });
    }
  }
  if (existsSync(join(home(), 'Library', 'Application Support', 'OrbStack'))) {
    out.push({ context_key: 'runtime:OrbStack', kind: 'runtime', label: 'OrbStack', detail: null, evidence: 'OrbStack app-support dir' });
  }
  return out;
}

/** This machine acting as somebody else's remote host. */
export function remoteHostContexts(): ExecutionContext[] {
  const out: ExecutionContext[] = [];
  for (const [dir, name] of [['.vscode-server', 'VS Code remote host'], ['.cursor-server', 'Cursor remote host']] as const) {
    const p = join(home(), dir);
    if (existsSync(p)) out.push({ context_key: `remote-host:${dir}`, kind: 'remote_host', label: name, detail: null, evidence: `~/${dir}` });
  }
  return out;
}

export function enumerateContexts(): ExecutionContext[] {
  const all = [
    ...editorRoots().flatMap((r) => workspaceContexts(r.root, r.app)),
    ...sshContexts(),
    ...dockerContexts(),
    ...runtimeContexts(),
    ...remoteHostContexts(),
  ];
  // One context_key = one context (docker's currentContext and its meta.json
  // name the same context; workspace URIs dedupe by key inside each reader).
  const byKey = new Map(all.map((c) => [c.context_key, c]));
  return [...byKey.values()];
}

function upsertSurface(db: DB, c: ExecutionContext, now: number): void {
  db.prepare(`
    INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, extra, identifier, scanner, first_seen, last_seen)
    VALUES (?, 'context', ?, ?, ?, ?, ?, 'contexts', ?, ?)
    ON CONFLICT(surface_key) DO UPDATE SET
      last_seen = excluded.last_seen, evidence = excluded.evidence, extra = excluded.extra`).run(
    `exec-context:${c.context_key}`,
    c.label,
    localPathOf(c.detail ?? '') ?? c.detail,
    `${c.kind}: ${c.evidence} — proves a context existed, never that an agent ran in it`,
    JSON.stringify({ context_key: c.context_key, kind: c.kind, detail: c.detail }),
    c.context_key,
    now,
    now,
  );
}

/**
 * Stamp execution_context_id on live rows — NULL-only, never overwriting a
 * stored fact with a re-derived one. Only a file:// workspace folder can be
 * matched to a usage row's project path; ssh/docker/runtime contexts carry no
 * matchable project and stay unstamped.
 */
export function stampExecutionContexts(db: DB, contexts: ExecutionContext[]): { events: number; anomalies: number } {
  // A workspace context OVERRIDES the insert-time collector context: both are
  // facts about this machine, but 'this call ran in workspace X' is the finer
  // truth, and the collector stamp is only the default before one is known.
  const stmt = db.prepare(`
    UPDATE usage_events SET execution_context_id = ?
    WHERE source = 'live' AND project = ?`);
  let events = 0;
  for (const c of contexts) {
    if (c.kind !== 'workspace' || !c.detail) continue;
    const p = localPathOf(c.detail);
    if (!p) continue;
    events += stmt.run(c.context_key, p).changes;
  }
  const anomalies = db.prepare(`
    UPDATE anomalies SET execution_context_id = (
      SELECT u.execution_context_id FROM usage_events u
      WHERE u.session_id = anomalies.session_id AND u.execution_context_id IS NOT NULL LIMIT 1)
    WHERE source = 'live'
      AND EXISTS (SELECT 1 FROM usage_events u
                  WHERE u.session_id = anomalies.session_id AND u.execution_context_id IS NOT NULL)`).run().changes;
  return { events, anomalies };
}

export const contextsScanner: Scanner = {
  name: 'execution-contexts',
  cadenceMs: 15 * 60_000,
  run: () => {
    const db: DB = openDb();
    const now = Date.now();
    const contexts = enumerateContexts();
    for (const c of contexts) upsertSurface(db, c, now);
    const stamped = stampExecutionContexts(db, contexts);
    return {
      ok: true,
      notes:
        `${contexts.length} execution context(s) seen — ` +
        `${stamped.events} live event(s) and ${stamped.anomalies} anomaly row(s) stamped ` +
        `(a workspace URI proves an editor window, not an agent run)`,
    };
  },
};

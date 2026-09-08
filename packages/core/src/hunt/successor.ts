import type { DB } from '../db';

/**
 * The successor window (tier 6 #32): the "and what happened next" half of a
 * hunt hit. A bounded join forward from the matched evidence row — same
 * session_id (subagents share it, so the agent tree rides along) — default 30
 * minutes, declared on the view and never inferred.
 *
 * Nothing here is causal and the caption must say so: the window is a time
 * filter, so widening it strictly widens the noise, and every count is printed
 * with its window length.
 */

export type SuccessorKind =
  | 'tool_call'
  | 'context_edge'
  | 'package_exec'
  | 'vcs_action'
  | 'action_target'
  | 'secret_sighting';

export interface SuccessorConsequence {
  minute_offset: number;
  kind: SuccessorKind;
  label: string;
  /** The four-state authority of the tool call behind the row, when there is one. */
  authority: string | null;
  ts: number;
}

export interface SuccessorWindow {
  window_minutes: number;
  caption: string;
  consequences: SuccessorConsequence[];
}

export interface SuccessorAnchor {
  session_id?: string | null;
  ts: number;
}

/**
 * Runs the bounded forward join. Read-only. Ledgers without a session_id join
 * through tool_calls on their call_key; secret_sightings (no session linkage
 * at all) are included by first_seen-in-window only, which is exactly why the
 * caption forbids causal reading.
 */
export function successorWindow(
  db: DB,
  anchor: SuccessorAnchor,
  opts: { minutes?: number } = {},
): SuccessorWindow {
  const minutes = opts.minutes ?? 30; // declared default, never inferred
  const t0 = anchor.ts;
  const t1 = t0 + minutes * 60_000;
  const s = anchor.session_id ?? null;
  const out: SuccessorConsequence[] = [];
  const push = (kind: SuccessorKind, ts: number, label: string, authority: string | null) => {
    if (ts < t0 || ts > t1) return;
    out.push({ minute_offset: (ts - t0) / 60_000, kind, label, authority, ts });
  };

  const calls = (
    db
      .prepare(
        'SELECT name, shape, authority, ts FROM tool_calls WHERE session_id = ? AND ts BETWEEN ? AND ?',
      )
      .all(s, t0, t1) as Array<{ name: string; shape: string | null; authority: string | null; ts: number }>
  );
  for (const c of calls) push('tool_call', c.ts, `${c.name} ${c.shape ?? ''}`.trim(), c.authority);

  const edges = (
    db
      .prepare(
        `SELECT ce.destination AS dest, ce.direction AS dir, ce.ts AS ts
           FROM context_edges ce JOIN tool_calls tc ON tc.tool_call_key = ce.call_key
          WHERE tc.session_id = ? AND ce.ts BETWEEN ? AND ?`,
      )
      .all(s, t0, t1) as Array<{ dest: string; dir: string; ts: number }>
  );
  for (const e of edges) push('context_edge', e.ts, `${e.dir} ${e.dest}`, null);

  const pkgs = (
    db
      .prepare(
        `SELECT pe.package_name AS pkg, pe.ts AS ts, tc.authority AS authority
           FROM package_execs pe JOIN tool_calls tc ON tc.tool_call_key = pe.call_key
          WHERE tc.session_id = ? AND pe.ts BETWEEN ? AND ?`,
      )
      .all(s, t0, t1) as Array<{ pkg: string; ts: number; authority: string | null }>
  );
  for (const p of pkgs) push('package_exec', p.ts, `package ${p.pkg}`, p.authority);

  const vcs = (
    db
      .prepare(
        `SELECT va.verb AS verb, va.repo AS repo, va.ts AS ts, tc.authority AS authority
           FROM vcs_actions va JOIN tool_calls tc ON tc.tool_call_key = va.call_key
          WHERE tc.session_id = ? AND va.ts BETWEEN ? AND ?`,
      )
      .all(s, t0, t1) as Array<{ verb: string; repo: string; ts: number; authority: string | null }>
  );
  for (const v of vcs) push('vcs_action', v.ts, `${v.verb} ${v.repo}`, v.authority);

  const targets = (
    db
      .prepare(
        `SELECT at.target_kind AS kind, at.target_label AS label, tc.ts AS ts, tc.authority AS authority
           FROM action_targets at JOIN tool_calls tc ON tc.tool_call_key = at.call_key
          WHERE tc.session_id = ? AND tc.ts BETWEEN ? AND ?`,
      )
      .all(s, t0, t1) as Array<{ kind: string; label: string; ts: number; authority: string | null }>
  );
  for (const t of targets) push('action_target', t.ts, `${t.kind} ${t.label}`, t.authority);

  const sightings = (
    db
      .prepare('SELECT sink_key, first_seen FROM secret_sightings WHERE first_seen BETWEEN ? AND ?')
      .all(t0, t1) as Array<{ sink_key: string; first_seen: number }>
  );
  for (const ss of sightings) push('secret_sighting', ss.first_seen, `first sighting in ${ss.sink_key}`, null);

  out.sort((x, y) => x.ts - y.ts);
  return {
    window_minutes: minutes,
    caption: `adjacency, not causation — ${minutes}-minute window; widening it strictly widens the counts`,
    consequences: out,
  };
}

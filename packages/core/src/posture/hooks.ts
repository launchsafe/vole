import { createHash } from 'node:crypto';
import type { DB } from '../db';
import { bumpCounter, sha } from './shared';

/**
 * The hook execution ledger. Claude Code writes two records and they disagree
 * in exactly the way that matters:
 *
 *  - attachment.type='hook_success' carries {hookName, hookEvent, command,
 *    exitCode, durationMs, ...} — but its `command` field is the hook's DISPLAY
 *    LABEL, not the shell command (verified: "Loading ponytail mode...").
 *  - system subtype='stop_hook_summary'.hookInfos[].command carries the REAL
 *    command string.
 *
 * So the command HASH comes from stop_hook_summary only; hook_success rows
 * count executions per event (the exit-code/duration posture_hook_runs columns
 * are an integration need — hook_ledger has nowhere for them). stdout/content
 * carry the full injected prompt verbatim, so only sha256 and length are ever
 * stored.
 */

export interface HookRun {
  hook_event: string;
  hook_name: string | null;
  command_sha: string | null; // null when only the display label was available
  display_label: string | null;
  exit_code: number | null;
}

export function hookRunsFromLine(line: Record<string, unknown>): HookRun[] {
  if (line.type === 'attachment') {
    const a = line.attachment as {
      type?: string; hookName?: string; hookEvent?: string; command?: string;
      exitCode?: number;
    } | undefined;
    if (a?.type !== 'hook_success') return [];
    // hookEvent is usually absent; the hookName's prefix ("SessionStart:startup")
    // names the event the run belongs to.
    const hookEvent = a.hookEvent ?? a.hookName?.split(':')[0] ?? null;
    if (!hookEvent) return [];
    return [{
      hook_event: hookEvent,
      hook_name: a.hookName ?? null,
      command_sha: null, // hook_success.command is the display label — see above
      display_label: a.command ?? null,
      exit_code: typeof a.exitCode === 'number' ? a.exitCode : null,
    }];
  }
  if (line.type === 'system' && line.subtype === 'stop_hook_summary') {
    const infos = (line.hookInfos ?? []) as { command?: string; hookEvent?: string; hookName?: string }[];
    return infos
      .filter((i) => typeof i.command === 'string' && i.command)
      .map((i) => ({
        hook_event: i.hookEvent ?? 'Stop',
        hook_name: i.hookName ?? null,
        command_sha: createHash('sha256').update(i.command!).digest('hex'),
        display_label: null,
        exit_code: null,
      }));
  }
  return [];
}

/**
 * The per-file flush. A command that CHANGED is a new fact: the key includes
 * the hash, so a re-pointed hook lands as a second row (first-seen preserved)
 * instead of silently mutating the old one. Execution counts are per
 * (event, file) with MAX semantics — one transcript file is one session, so
 * re-reading an unchanged file is a no-op and an appended one only grows.
 */
export function recordHookRuns(db: DB, file: string, runs: HookRun[], now: number): number {
  const fileKey = sha(file).slice(0, 12);
  const byEvent = new Map<string, number>();
  for (const r of runs) byEvent.set(r.hook_event, (byEvent.get(r.hook_event) ?? 0) + 1);
  for (const [event, n] of byEvent) {
    bumpCounter(db, `hooks:${event}:${fileKey}`, 'executions', n, now);
  }
  const upsert = db.prepare(`
    INSERT INTO hook_ledger (hook_key, agent, hook_event, command_hash, source_file, first_seen, last_seen)
    VALUES (?, 'claude_code', ?, ?, ?, ?, ?)
    ON CONFLICT(hook_key) DO UPDATE SET last_seen = excluded.last_seen`);
  let n = 0;
  for (const r of runs) {
    if (!r.command_sha) continue;
    upsert.run(
      `hook:claude_code:${r.hook_event}:${r.command_sha.slice(0, 16)}:${file}`,
      r.hook_event, r.command_sha, file,
      now, now, // first_seen is the first OBSERVATION, not the transcript's own ts
    );
    n++;
  }
  return n;
}

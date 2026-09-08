/**
 * Tier 7 control intents: a notification action records a REQUEST, never a
 * completed action. Vole is out of the request path — an intent is honoured
 * only where a consumer exists, and today that is Claude Code alone (an
 * exact-PID signal via ~/.claude/sessions/<pid>.json). Codex, OpenCode,
 * Grok, Cursor, Devin and Antigravity have no consumer at all, so their
 * rows expire unenforced or go stale unsent, and the UI must render that
 * state rather than implying the action happened.
 *
 * State machine (monotone; no state is ever un-expired):
 *   requested -> enforced            (a consumer signalled it acted)
 *   requested -> expired_unenforced  (deadline passed; a consumer existed)
 *   requested -> stale_not_sent       (no consumer exists for that tool)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import { paths } from '../paths';

export type IntentKind = 'pause_session' | 'quarantine_repo' | 'snooze_1h' | 'open_evidence';
export type IntentState = 'requested' | 'enforced' | 'expired_unenforced' | 'stale_not_sent';

/** Only this tool has a consumer today — the list is honest, not aspirational. */
export const INTENT_CONSUMERS: readonly string[] = ['claude_code'];

export interface ControlIntent {
  intent: IntentKind;
  session_id: string | null;
  pid: number | null;
  actor: string;
  requested_at: number;
  /** Snooze/pause windows must expire, exactly like a mute. */
  expires_at: number | null;
  tool?: string | null;
}

/** Deterministic: the same request content is the same intent, so re-spooling converges. */
export function intentId(i: Omit<ControlIntent, never>): string {
  const h = createHash('sha256');
  h.update(`${i.intent}|${i.session_id ?? ''}|${i.pid ?? ''}|${i.actor}|${i.requested_at}`);
  return `ci:${h.digest('hex').slice(0, 24)}`;
}

/** The exact-PID mapping: ~/.claude/sessions/<pid>.json {pid,sessionId,cwd,startedAt,...}. */
export interface PidSession {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
}

export function readPidSession(pid: number, claudeDir: string = paths.claudeConfigDir()): PidSession | null {
  const file = join(claudeDir, 'sessions', `${pid}.json`);
  if (!existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8')) as Partial<PidSession>;
    if (d.pid === pid && typeof d.sessionId === 'string') return d as PidSession;
    return null; // present but not an exact match: an exact-PID gate never guesses
  } catch {
    return null;
  }
}

/** Every live PID mapping, for the "which sessions COULD be controlled" census. */
export function readPidSessions(claudeDir: string = paths.claudeConfigDir()): PidSession[] {
  const dir = join(claudeDir, 'sessions');
  const out: PidSession[] = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const pid = Number(f.replace(/\.json$/, ''));
    if (!Number.isInteger(pid)) continue;
    const s = readPidSession(pid, claudeDir);
    if (s) out.push(s);
  }
  return out;
}

/** Appends an intent row. Idempotent on intent_id (UNIQUE, INSERT OR IGNORE). */
export function recordIntent(db: DB, i: ControlIntent): { intent_id: string; inserted: boolean } {
  const intent_id = intentId(i);
  const r = db.prepare(
    `INSERT OR IGNORE INTO control_intents
       (intent_id, intent, session_id, pid, actor, requested_at, expires_at, state, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?)`,
  ).run(intent_id, i.intent, i.session_id, i.pid, i.actor, i.requested_at, i.expires_at, i.tool ?? null);
  return { intent_id, inserted: r.changes > 0 };
}

/** A consumer existed: mark the intent enforced. Machine transition, never silent. */
export function markEnforced(db: DB, intent_id: string): number {
  return db.prepare(
    "UPDATE control_intents SET state = 'enforced' WHERE intent_id = ? AND state = 'requested'",
  ).run(intent_id).changes;
}

export interface IntentRow {
  intent_id: string;
  intent: string;
  session_id: string | null;
  pid: number | null;
  requested_at: number;
  expires_at: number | null;
  state: string;
  source: string | null;
}

/**
 * The sweep: advances the state machine. An intent with an exact-PID consumer
 * mapping (or one that ever had a consumer for its tool) whose deadline has
 * passed without enforcement expires unenforced; an intent whose tool has NO
 * consumer goes stale_not_sent — recorded, honest, never rendered as done.
 * Pure over rows so it is testable; the caller commits.
 */
export function sweepIntents(rows: IntentRow[], now: number, consumers: readonly string[] = INTENT_CONSUMERS): IntentRow[] {
  const out: IntentRow[] = [];
  for (const r of rows) {
    if (r.state !== 'requested') continue;
    const hasConsumer = consumers.includes(r.source ?? '') || (r.pid !== null && r.session_id !== null);
    if (!hasConsumer) {
      out.push({ ...r, state: 'stale_not_sent' });
      continue;
    }
    if (r.expires_at !== null && now > r.expires_at) {
      out.push({ ...r, state: 'expired_unenforced' });
    }
  }
  return out;
}

/** Applies the sweep to the store. Returns the number of state transitions. */
export function applyIntentSweep(db: DB, now: number = Date.now()): number {
  const rows = db
    .prepare('SELECT intent_id, intent, session_id, pid, requested_at, expires_at, state, source FROM control_intents')
    .all() as IntentRow[];
  const upd = db.prepare('UPDATE control_intents SET state = ? WHERE intent_id = ? AND state = ?');
  let n = 0;
  for (const t of sweepIntents(rows, now)) {
    n += upd.run(t.state, t.intent_id, 'requested').changes;
  }
  return n;
}

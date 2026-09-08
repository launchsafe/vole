import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Same resolution rule as paths.ts: an override root wins, else the real home. */
const home = () => process.env.VOLE_HOME_OVERRIDE ?? homedir();
import { skeletonize, type ToolCallRow } from '../toolcalls/bind';
import type { DB } from '../db';
import { advanceCursor, getCursor, readSlice } from '../cursors';
import type { CollectorResult } from '../types';

/**
 * Kiro ACP ledger (tier 5 #47): tool calls carrying the vendor's own policy
 * verdict and the human's answer.
 *
 * ~/.kiro/logs/<launchStamp>/kiro.log is plain JSONL {timestamp, level,
 * message}; agent_controller.triggered lines carry {agentType, autonomyMode,
 * modelId} as a JSON payload in the message. Those become tool_calls rows —
 * the approval lane (allow / ask, and for asks the human's answer and how long
 * they took) rides on authority + status, filled by the matching approval
 * response line in the same launch when one exists.
 *
 * The log carries NO token counts and 'Request payload: 78987 chars' is
 * characters — it is never divided by four to fabricate tokens, so no
 * usage_events rows are emitted at all. Log directories are per-launch with no
 * rotation contract, so a pruned launch is an evidence gap and is counted in
 * the notes, not silently skipped. Kiro is not in the Tool union yet — this
 * ledger exists purely in tool_calls until the union widens (integration).
 */

interface KiroLine {
  timestamp?: string;
  level?: string;
  message?: string;
}

/** agent_controller.triggered {"agentType":..,"autonomyMode":..,"modelId":..} */
interface TriggeredPayload {
  agentType?: string;
  autonomyMode?: string;
  modelId?: string;
}

/** approval.requested / approval.resolved lines, joined to the pending ask. */
interface ApprovalPayload {
  allowed?: boolean;
  capability?: string;
  toolCallId?: string;
  answer?: string;
  latencyMs?: number;
}

/** message -> [name, payload] for the "<name> {json}" shapes kiro.log writes. */
function splitMessage(message: string): { name: string; payload: Record<string, unknown> | null } {
  const m = message.match(/^([a-zA-Z0-9_.]+)\s*(\{.*\})\s*$/s);
  if (m) {
    try {
      return { name: m[1]!, payload: JSON.parse(m[2]!) as Record<string, unknown> };
    } catch {
      /* fall through to the bare name */
    }
  }
  return { name: message.trim(), payload: null };
}

function payloadOf<T>(p: Record<string, unknown> | null): T | null {
  if (!p) return null;
  return p as T;
}

/**
 * CollectorResult with the tool string loosened: 'kiro' is not in the Tool
 * union yet (types.ts is a coordinated seam), and kiro.log carries no token
 * data, so no usage_events row can honestly exist — the result exists only to
 * carry the ledger rows. When the union widens, tighten this to CollectorResult
 * and register the collector in collectors/index (integration).
 */
export interface KiroResult extends Omit<CollectorResult, 'tool'> {
  tool: string;
}

export function collectKiro(db: DB): KiroResult {
  const root = join(home(), '.kiro', 'logs');
  const notes: string[] = [];
  const calls: ToolCallRow[] = [];

  if (!existsSync(root)) {
    return { tool: 'kiro', events: [], filesScanned: 0, notes: ['No Kiro logs'], sourceState: 'no_source' };
  }

  let launches = 0;
  let prunedOrEmpty = 0;
  let launchesScanned = 0;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .sort();
  for (const launchDir of dirs) {
    launches++;
    const logPath = join(launchDir, 'kiro.log');
    let text: string;
    let st;
    try {
      text = readFileSync(logPath, 'utf8');
      st = statSync(logPath);
    } catch {
      prunedOrEmpty++;
      continue;
    }
    launchesScanned++;

    // Approval asks in this launch, joined to their resolution by order: the
    // first resolution answers the oldest open ask.
    const openAsks: { toolCallId: string; ts: number; capability: string | null }[] = [];

    for (const [i, line] of text.split('\n').filter((l) => l.trim()).entries()) {
      let e: KiroLine;
      try {
        e = JSON.parse(line) as KiroLine;
      } catch {
        continue;
      }
      const ts = e.timestamp ? Date.parse(e.timestamp) : Math.trunc(st.mtimeMs); // explicit fallback: the file's clock
      const { name, payload } = splitMessage(e.message ?? '');

      if (name === 'agent_controller.triggered' || name.endsWith('.triggered')) {
        const p = payloadOf<TriggeredPayload>(payload);
        const agentType = p?.agentType ?? 'kiro_agent';
        const autonomy = p?.autonomyMode ?? null;
        calls.push({
          // Source-native: the launch directory (its launchStamp) plus the
          // line index — kiro.log mints no call ids.
          tool_call_key: `kiro:${launchDir}:${i}`,
          tool: 'kiro',
          name: agentType,
          shape: skeletonize(agentType, null),
          args_digest: null, // payload content stays out of the ledger
          session_id: null,
          agent_id: null,
          ts,
          // The vendor's own verdict on the gate: 'allow' was ungated,
          // 'ask' awaited a human — resolved by the approval lane below.
          authority: autonomy === 'allow' ? 'pre_authorised' : null,
          raw_ref: `${logPath}#${i}`,
        });
        continue;
      }
      if (name.includes('approval.requested') || name.includes('approvalRequested')) {
        const p = payloadOf<ApprovalPayload>(payload);
        const id = p?.toolCallId ?? `${launchDir}:ask:${i}`;
        openAsks.push({ toolCallId: id, ts, capability: p?.capability ?? null });
        continue;
      }
      if (name.includes('approval.') || name.includes('approval')) {
        // A resolution (allowed / denied / timeout) for the oldest open ask.
        const p = payloadOf<ApprovalPayload>(payload);
        const ask = openAsks.shift();
        if (!ask) continue;
        const allowed = p?.allowed ?? (p?.answer === 'allow' ? true : p?.answer === 'deny' ? false : null);
        calls.push({
          tool_call_key: `kiro:${launchDir}:approval:${ask.toolCallId}`,
          tool: 'kiro',
          name: ask.capability ?? 'approval',
          shape: null,
          args_digest: null,
          session_id: null,
          agent_id: null,
          ts,
          status: allowed === true ? 'success' : allowed === false ? 'denied' : null,
          status_source: 'log_flag',
          duration_ms:
            typeof p?.latencyMs === 'number' && p.latencyMs > 0 ? p.latencyMs
            : ts > ask.ts && ts - ask.ts < 3_600_000 ? ts - ask.ts
            : null,
          duration_kind: 'turn_scoped',
          authority: allowed === false ? 'denied' : null,
          raw_ref: `${logPath}#${i}`,
        });
      }
    }

    // The declared cursor: the byte offset + chained prefix digest per launch
    // log, so the Coverage strip sees where Kiro reading stopped.
    const prev = getCursor(db, logPath);
    advanceCursor(db, {
      sourceKey: logPath,
      tool: 'kiro',
      offset: st.size,
      mtimeMs: st.mtimeMs,
      newBytes: readSlice(logPath, Math.min(prev?.last_offset ?? 0, st.size), st.size),
      stat: { ino: st.ino, birthtimeMs: st.birthtimeMs },
    });
  }

  if (prunedOrEmpty > 0) {
    notes.push(`${prunedOrEmpty} of ${launches} launch log directory(ies) held no readable kiro.log — evidence gap`);
  }
  notes.push(`kiro: ${launchesScanned} launch log(s) parsed; no token figures exist in kiro.log`);
  return { tool: 'kiro', events: [], filesScanned: launchesScanned, notes, toolCalls: calls };
}

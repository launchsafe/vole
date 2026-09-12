/**
 * `vole guard` — the budget guard, as a Claude Code PreToolUse hook.
 *
 * Reads the hook payload on stdin, compares spend against the configured caps, and
 * denies the tool call when a hard cap is reached. Register it with:
 *
 *   pnpm budget --install-hook      (prints the settings.json block to paste)
 *
 * Contract, per the Claude Code hooks reference:
 *   stdin  { session_id, cwd, tool_name, tool_input, ... }
 *   deny   exit 2, plus
 *          { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *            "permissionDecision": "deny", "permissionDecisionReason": "..." } }
 *   allow  exit 0 and no decision — the call goes through the normal permission flow.
 *
 * FAILING OPEN IS THE RULE HERE. A guard that cannot read its store, or that throws,
 * must let the call through: a monitoring tool has no business bricking someone's agent
 * because its own database was locked. Only a definite, measured breach denies.
 */
import { openDbReadOnly } from '../db';
import {
  loadBudget, spendSince, startOfLocalDay, evaluateBudget, breachMessage,
} from '../budget';

interface HookPayload {
  session_id?: string;
  tool_name?: string;
  cwd?: string;
}

function allow(): never {
  // Silence is consent: no decision means the normal permission flow continues.
  process.exit(0);
}

function deny(reason: string): never {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  // Exit 2 is what actually blocks; the JSON supplies the message.
  process.exit(2);
}

async function main(): Promise<void> {
  const cfg = loadBudget();
  if (cfg.session.hard === null && cfg.daily.hard === null
      && cfg.session.soft === null && cfg.daily.soft === null) {
    allow(); // nothing configured; do not even open the store
  }

  let payload: HookPayload = {};
  try {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) payload = JSON.parse(raw) as HookPayload;
  } catch {
    allow(); // unreadable payload is not evidence of a breach
  }

  const now = Date.now();
  const db = openDbReadOnly();
  const session = payload.session_id
    ? spendSince(db, 0, payload.session_id)
    : { exact: 0, estimated: 0, unmeasuredCalls: 0, calls: 0 };
  const daily = spendSince(db, startOfLocalDay(now));

  const breach = evaluateBudget(cfg, session, daily);
  if (breach.level !== 'hard') allow();

  deny(breachMessage(breach, breach.scope === 'daily' ? daily : session, cfg));
}

main().catch(() => {
  // Fail open, loudly enough to debug but never blocking.
  process.stderr.write('vole guard: check failed; allowing the call\n');
  process.exit(0);
});

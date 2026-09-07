import type { Anomaly, UsageEvent } from '../types';
import { bucketOf, groupBy, worstConfidence, fmt, shortId } from './util';

/**
 * Rerouted-model detection — read straight from the stored model column, which
 * already holds the proof: a Claude Code row whose model is not an Anthropic id
 * was answered by something else (a local gateway, a router, a proxy). On the
 * machine this was built on, that was 2,540 rows including a "claude" whose hex
 * alias decodes to a qwen model served from a raw IP.
 *
 * First-party shapes, per tool with a known vendor:
 *   claude_code → claude-*          codex → gpt-*
 * OpenCode carries honest provider prefixes (github-copilot/…, openrouter/…) and
 * is excluded; a NULL model can never be classified and is skipped — an honest
 * unknown, not an "all clear".
 *
 * The model string proves which model answered, not which host served it: a
 * self-hosted Anthropic-compatible endpoint returning "claude-sonnet-5" is
 * indistinguishable from the real thing here. The rule says "not first-party",
 * never "exfiltrated".
 */

const FIRST_PARTY: Record<string, RegExp> = {
  claude_code: /^claude/i,
  codex: /^gpt/i,
};

/** Decodes a hex alias embedded in a model id (the claude-code-router trick). */
export function decodeHexAlias(model: string): string | null {
  // A run of ≥ 16 hex chars that decodes to printable ASCII.
  const m = model.match(/[0-9a-f]{16,}/g);
  if (!m) return null;
  for (const hex of m) {
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
      const c = parseInt(hex.slice(i, i + 2), 16);
      if (c < 0x20 || c > 0x7e) {
        out = '';
        break;
      }
      out += String.fromCharCode(c);
    }
    if (out.length >= 8) return out;
  }
  return null;
}

export function detectReroutedModels(events: UsageEvent[], now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const usable = events.filter((e) => {
    const pattern = FIRST_PARTY[e.tool];
    return pattern && e.model !== null && e.confidence !== 'activity_only';
  });

  // One incident per (tool, upstream model, session): the same reroute across
  // many calls is one finding, with its row count as the figure.
  const groups = new Map<string, UsageEvent[]>();
  for (const e of usable) {
    // Not first-party: either the id is not the vendor's shape, or it carries a
    // hex alias — a real Anthropic id is never a hex blob, and a router's rewrite
    // ("claude-ccr-h7177656e…") starts with "claude" precisely to look legit.
    const aliased = decodeHexAlias(e.model!) !== null;
    if (!aliased && FIRST_PARTY[e.tool]!.test(e.model!)) continue;
    const key = `${e.tool}::${e.model}::${e.session_id ?? 'none'}`;
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }

  for (const [key, evs] of groups) {
    const [tool = '', model = '', session = ''] = key.split('::');
    const first = evs[0];
    if (!first) continue;
    const alias = decodeHexAlias(model);
    const bucket = bucketOf(evs[0]!.ts, 24 * 3600_000); // day-granular, stable key

    out.push({
      anomaly_key: `rerouted_model:${tool}:${model}:${session}:${bucket}`,
      rule: 'rerouted_model',
      severity: 'warn',
      tool: first.tool,
      session_id: first.session_id,
      model: model || null,
      window_start: Math.min(...evs.map((e) => e.ts)),
      window_end: Math.max(...evs.map((e) => e.ts)),
      title: `Rerouted model on ${tool}: ${model}`,
      detail:
        `${evs.length} call(s) on ${tool} were answered by "${model}", which is not a first-party ` +
        `${tool === 'claude_code' ? 'Anthropic' : 'OpenAI'} model id.` +
        (alias ? ` The embedded hex alias decodes to "${alias}" — a router rewrote the model name.` : '') +
        ` The model string proves which model answered, not which host served it. ` +
        `Session ${shortId(first.session_id)}.`,
      observed: evs.length,
      baseline: null,
      threshold: null,
      confidence: worstConfidence(evs),
      source: first.source,
      detected_at: now,
    });
  }
  void fmt;
  return out;
}

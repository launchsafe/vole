/**
 * The guardrail-bypass and scope-crossing pairers (tier 5 #27, #52) as pure
 * functions over a session's ordered calls, so the pairing logic is testable
 * without a store and the SQL layer stays a dumb supplier.
 */

export interface PairCall {
  id: number;
  tool_call_key: string;
  tool: string;
  name: string;
  shape: string | null;
  args_digest: string | null;
  status: string | null;
  ts: number;
}

/** Bash-shaped tools that read the same thing a denied Read wanted. */
const READ_CLASS = new Set(['Read', 'cat', 'head', 'tail', 'less', 'zcat', 'bat', 'nl']);
/** Bash-shaped tools that change the same thing a denied Edit wanted. */
const EDIT_CLASS = new Set(['Edit', 'Write', 'sed -i', 'tee', 'python3 -c', 'perl -i', 'awk']);

export function intentClassOf(c: { name: string; shape: string | null }): 'read' | 'edit' | null {
  if (READ_CLASS.has(c.name)) return 'read';
  if (EDIT_CLASS.has(c.name)) return 'edit';
  if (c.shape) {
    const head = c.shape.split(' ')[0] ?? '';
    if (READ_CLASS.has(head)) return 'read';
    if (EDIT_CLASS.has(head)) return 'edit';
  }
  return null;
}

export interface DeniedPair {
  denied: PairCall;
  achieved: PairCall;
  /** identical: same (name, args). cross_tool_class: a different tool, same intent class. */
  kind: 'identical' | 'cross_tool_class';
  target_class: string;
}

const K_ORDINALS = 10;

/**
 * denied_then_achieved. Two signatures:
 *  - identical: the same (name, args_digest) call later succeeded;
 *  - cross_tool_class: a DIFFERENT tool with the same intent class succeeded
 *    within K subsequent calls (Bash cat after a denied Read, sed -i after a
 *    denied Edit). The full target-hash pairing (normalised path or verb+path,
 *    hashed, matched across tools) needs the collector-side target hash; the
 *    intent class is the coarse half that the stored shape can prove.
 */
export function pairDeniedThenAchieved(calls: PairCall[]): DeniedPair[] {
  const sorted = [...calls].sort((a, b) => a.id - b.id);
  const out: DeniedPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i]!;
    if (d.status !== 'denied' || !d.args_digest) continue;
    for (let j = i + 1; j < sorted.length && j <= i + K_ORDINALS; j++) {
      const a = sorted[j]!;
      if (a.status !== 'success') continue;
      if (a.args_digest === d.args_digest && a.name === d.name) {
        out.push({ denied: d, achieved: a, kind: 'identical', target_class: d.name });
        break;
      }
      if (a.tool !== d.tool || a.name === d.name) continue;
      const di = intentClassOf(d);
      const ai = intentClassOf(a);
      if (di && di === ai) {
        out.push({ denied: d, achieved: a, kind: 'cross_tool_class', target_class: `${di} intent` });
        break;
      }
    }
  }
  return out;
}

export interface DenialReshape {
  denied: PairCall;
  reshaped: PairCall;
}

/** denial_then_reshape: denied, then a different-args call of the same tool succeeded. */
export function pairDenialThenReshape(calls: PairCall[], withinMs = 30 * 60_000): DenialReshape[] {
  const sorted = [...calls].sort((a, b) => a.id - b.id);
  const out: DenialReshape[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i]!;
    if (d.status !== 'denied' || !d.args_digest) continue;
    const match = sorted.find(
      (a) => a.name === d.name && a.args_digest !== null && a.args_digest !== d.args_digest &&
        a.status === 'success' && a.ts > d.ts && a.ts - d.ts < withinMs,
    );
    if (match) out.push({ denied: d, reshaped: match });
  }
  return out;
}

// ── cross_scope_read_then_publish ────────────────────────────────────────────

/** Publish-class tool names, versioned list v1. */
export const PUBLISH_TOOLS_V1 = [
  'create_pull_request',
  'create_or_update_file',
  'push_files',
  'add_issue_comment',
  'create_issue',
  'create_issue_comment',
];

export function isPublishClass(c: { name: string; shape: string | null }): boolean {
  if (PUBLISH_TOOLS_V1.some((t) => c.name.includes(t))) return true;
  if (/__send/.test(c.name)) return true;
  const shape = c.shape ?? '';
  return /^(git push|gh pr create|gh issue comment|gh release create)\b/.test(shape);
}

export function isReadClassCall(c: { name: string; shape: string | null }): boolean {
  if (/(get_file|read_file|get_contents|list_files|search_code|fetch|read)/i.test(c.name) && !isPublishClass(c)) return true;
  return /^(cat|head|tail|less|git log|git show)\b/.test(c.shape ?? '');
}

export interface CrossScopePair {
  read: PairCall;
  publish: PairCall;
  read_scope: string | null;
  publish_scope: string | null;
}

/**
 * cross_scope_read_then_publish: a read-class call followed within the window by
 * a publish-class call. Scopes are carried when the caller resolved them (MCP
 * owner/repo/url); null scopes are reported as 'not recorded', never as matching.
 */
export function pairCrossScope(calls: PairCall[], withinMs = 30 * 60_000, scopes: Map<string, string | null> = new Map()): CrossScopePair[] {
  const sorted = [...calls].sort((a, b) => a.id - b.id);
  const out: CrossScopePair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (!isReadClassCall(r)) continue;
    const p = sorted.find(
      (c) => c.ts > r.ts && c.ts - r.ts <= withinMs && isPublishClass(c),
    );
    if (!p) continue;
    const rs = scopes.get(r.tool_call_key) ?? null;
    const ps = scopes.get(p.tool_call_key) ?? null;
    if (rs !== null && ps !== null && rs === ps) continue; // same resolved scope: not a crossing
    out.push({ read: r, publish: p, read_scope: rs, publish_scope: ps });
  }
  return out;
}

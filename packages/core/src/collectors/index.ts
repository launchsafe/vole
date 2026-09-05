import type { DB } from '../db';
import type { CollectorResult, Tool } from '../types';
import { collectClaudeCode } from './claude-code';
import { collectCodex } from './codex';
import { collectCursor } from './cursor';
import { collectAntigravity } from './antigravity';
import { collectOpencode } from './opencode';
import { collectGrok } from './grok';
import { collectDevin } from './devin';

export {
  collectClaudeCode,
  collectCodex,
  collectCursor,
  collectAntigravity,
  collectOpencode,
  collectGrok,
  collectDevin,
};

const REGISTRY: { tool: Tool; run: (db: DB) => CollectorResult }[] = [
  { tool: 'claude_code', run: collectClaudeCode },
  { tool: 'codex', run: collectCodex },
  { tool: 'cursor', run: collectCursor },
  { tool: 'antigravity', run: collectAntigravity },
  { tool: 'opencode', run: collectOpencode },
  { tool: 'grok', run: collectGrok },
  { tool: 'devin', run: collectDevin },
];

/** Runs every collector, isolating failures so one bad source cannot stop the others. */
export function collectAll(db: DB): CollectorResult[] {
  const results: CollectorResult[] = [];
  for (const { tool, run } of REGISTRY) {
    try {
      results.push(run(db));
    } catch (err) {
      results.push({
        tool,
        events: [],
        filesScanned: 0,
        notes: [`collector failed: ${(err as Error).message}`],
      });
    }
  }
  return results;
}

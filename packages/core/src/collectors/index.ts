import type { DB } from '../db';
import type { CollectorResult, Tool } from '../types';
import { collectClaudeCode } from './claude-code';
import { collectCodex } from './codex';
import { collectCursor } from './cursor';
import { collectAntigravity } from './antigravity';
import { collectOpencode } from './opencode';
import { collectGrok } from './grok';
import { collectDevin } from './devin';
import { collectGemini } from './gemini';
import { collectAider, collectGoose, collectAmp, collectContinue, collectCopilotCli, collectVscodeStores, collectOllamaLog } from './stores';

export {
  collectClaudeCode,
  collectCodex,
  collectCursor,
  collectAntigravity,
  collectOpencode,
  collectGrok,
  collectDevin,
  collectGemini,
  collectAider,
  collectGoose,
  collectAmp,
  collectContinue,
  collectCopilotCli,
  collectVscodeStores,
  collectOllamaLog,
};

const REGISTRY: { tool: Tool; run: (db: DB) => CollectorResult }[] = [
  { tool: 'claude_code', run: collectClaudeCode },
  { tool: 'codex', run: collectCodex },
  { tool: 'cursor', run: collectCursor },
  { tool: 'antigravity', run: collectAntigravity },
  { tool: 'opencode', run: collectOpencode },
  { tool: 'grok', run: collectGrok },
  { tool: 'devin', run: collectDevin },
  { tool: 'gemini', run: collectGemini },
  { tool: 'aider', run: collectAider },
  { tool: 'goose', run: collectGoose },
  { tool: 'amp', run: collectAmp },
  { tool: 'continue', run: collectContinue },
  { tool: 'copilot_cli', run: collectCopilotCli },
  { tool: 'vscode_chat', run: collectVscodeStores },
  { tool: 'ollama_local', run: collectOllamaLog },
];

/** Runs every collector, isolating failures so one bad source cannot stop the others. */
export function collectAll(db: DB): CollectorResult[] {
  const results: CollectorResult[] = [];
  for (const { tool, run } of REGISTRY) {
    const started = Date.now();
    try {
      const r = run(db);
      r.durationMs = Date.now() - started;
      if (!r.sourceState) r.sourceState = 'ok';
      results.push(r);
    } catch (err) {
      results.push({
        tool,
        events: [],
        filesScanned: 0,
        notes: [`collector failed: ${(err as Error).message}`],
        sourceState: 'error',
        durationMs: Date.now() - started,
      });
    }
  }
  return results;
}

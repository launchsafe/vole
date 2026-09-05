import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Source locations default to the standard per-user install paths of each tool, resolved
 * at runtime against whoever runs Vole — no absolute paths are baked into the code.
 *
 * Configuration, in priority order:
 *   1. A per-source env var (VOLE_CLAUDE_PROJECTS, VOLE_CODEX_SESSIONS, …) points that
 *      one source at a non-standard location.
 *   2. VOLE_HOME_OVERRIDE relocates the entire default layout under one root (tests use
 *      it to point every source at fixtures instead of the real home directory).
 */
const home = () => process.env.VOLE_HOME_OVERRIDE ?? homedir();

export const paths = {
  /** Where Vole stores its own database. */
  db: () => process.env.VOLE_DB ?? join(home(), '.vole', 'vole.db'),

  /** Per-installation pricing override merged over the built-in rate table. */
  pricingOverride: () => process.env.VOLE_PRICING ?? join(home(), '.vole', 'pricing.json'),

  /** Claude Code session transcripts: ~/.claude/projects/<slug>/<session-id>.jsonl */
  claudeCodeProjects: () => process.env.VOLE_CLAUDE_PROJECTS ?? join(home(), '.claude', 'projects'),

  /** Codex rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl */
  codexSessions: () => process.env.VOLE_CODEX_SESSIONS ?? join(home(), '.codex', 'sessions'),

  /** Cursor AI attribution DB. Contains models and sessions but no token counts. */
  cursorTrackingDb: () =>
    process.env.VOLE_CURSOR_DB ?? join(home(), '.cursor', 'ai-tracking', 'ai-code-tracking.db'),

  /** Antigravity conversation payloads (encrypted) and their readable sibling artifacts. */
  antigravityConversations: () =>
    process.env.VOLE_ANTIGRAVITY_CONVERSATIONS ??
    join(home(), '.gemini', 'antigravity-ide', 'conversations'),
  antigravityBrain: () =>
    process.env.VOLE_ANTIGRAVITY_BRAIN ?? join(home(), '.gemini', 'antigravity-ide', 'brain'),

  /** OpenCode's SQLite store. `message` rows carry exact per-response tokens and cost. */
  opencodeDb: () =>
    process.env.VOLE_OPENCODE_DB ?? join(home(), '.local', 'share', 'opencode', 'opencode.db'),

  /** Grok CLI (xAI): unified log with per-turn token usage, plus per-session summaries. */
  grokUnifiedLog: () => process.env.VOLE_GROK_LOG ?? join(home(), '.grok', 'logs', 'unified.jsonl'),
  grokSessionsDir: () => process.env.VOLE_GROK_SESSIONS ?? join(home(), '.grok', 'sessions'),

  /** Devin editor ACP conversation stores. Content only — no token data. */
  devinAcpMessages: () =>
    process.env.VOLE_DEVIN_MESSAGES ??
    join(home(), 'Library', 'Application Support', 'Devin', 'User', 'acp-messages'),
};

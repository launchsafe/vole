import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache, insertEvents } from '../db';
import type { DB } from '../db';
import type { UsageEvent } from '../types';

/**
 * Test helper: a fully migrated store in a fresh temp dir, pointed at by
 * VOLE_DB / VOLE_HOME_OVERRIDE, so collectors can write every table the
 * foundation migrations created (the plain SCHEMA constant stops at the base
 * tables and predates agent_edges, event_links, upload_decisions, …).
 */

export interface Store {
  db: DB;
  home: string;
  done(): void;
}

export function makeStore(prefix: string): Store {
  const home = mkdtempSync(join(tmpdir(), `vole-${prefix}-`));
  const dbFile = join(home, 'vole.db');
  process.env.VOLE_HOME_OVERRIDE = home;
  process.env.VOLE_DB = dbFile;
  const db = openDb(dbFile);
  return {
    db,
    home,
    done() {
      resetDbCache();
      delete process.env.VOLE_HOME_OVERRIDE;
      delete process.env.VOLE_DB;
    },
  };
}

/** A minimal live usage_events row for backfill/ledger tests. */
export function seedEvent(db: DB, over: Partial<UsageEvent>): void {
  insertEvents(db, [{
    event_key: 'k',
    tool: 'codex',
    model: null,
    session_id: null,
    project: null,
    git_branch: null,
    ts: 1_000,
    input_tokens: 1,
    output_tokens: 1,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 2,
    cost_usd: null,
    confidence: 'exact',
    is_error: 0,
    stop_reason: null,
    source: 'live',
    raw_ref: null,
    tools: null,
    agent_id: null,
    context_window: null,
    duration_ms: null,
    duration_kind: null,
    ...over,
  }]);
}

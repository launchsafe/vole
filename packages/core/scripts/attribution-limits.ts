#!/usr/bin/env node
/**
 * The attribution-limits statement (tier 3 #41): a shipped, enumerated and
 * falsifiable statement of the limits of local per-employee attribution,
 * GENERATED from this machine's own store counts rather than written as a
 * disclaimer. Run wired into CI (and manually):
 *
 *   cd packages/core && node --import tsx scripts/attribution-limits.ts [--json]
 *
 * Correct only for the tools and versions Vole parses today — agent log
 * formats are explicitly internal and version-unstable, so without this
 * regeneration step the statement becomes the nineteenth stale claim. It is a
 * statement about attribution, not about coverage.
 */
import { existsSync } from 'node:fs';
import { Database } from '../src/sqlite';
import { paths } from '../src/paths';
import { principalCount } from '../src/governance/view-gate';

function n(db: Database, sql: string, ...args: (string | number)[]): number | null {
  const row = db.prepare(sql).get(...args) as { n: number | null } | undefined;
  return row?.n ?? null;
}

/** A missing column/table on an older store means "not recorded yet" — NULL, never 0. */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).some((c) => c.name === col);
}

function build(): {
  generated_at: number;
  store: string;
  statements: { claim: string; basis: string; count: number | null }[];
} {
  const file = paths.db();
  const out = {
    generated_at: Date.now(),
    store: file,
    statements: [] as { claim: string; basis: string; count: number | null }[],
  };
  if (!existsSync(file)) {
    out.statements.push({
      claim: 'no store exists yet — every attribution limit holds vacuously',
      basis: 'no database file',
      count: 0,
    });
    return out;
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const hasTable = (t: string) =>
    !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(t);
  const total = n(db, "SELECT COUNT(*) AS n FROM usage_events WHERE source = 'live'") ?? 0;
  const noUser = n(db, "SELECT COUNT(*) AS n FROM usage_events WHERE source = 'live' AND user IS NULL") ?? 0;
  const principals = hasTable('principals')
    ? n(db, 'SELECT COUNT(DISTINCT principal_key) AS n FROM principals')
    : null;
  const unbound = hasTable('session_identity')
    ? n(
        db,
        `SELECT COUNT(DISTINCT u.session_id) AS n FROM usage_events u
         WHERE u.source = 'live' AND u.session_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM session_identity si WHERE si.session_id = u.session_id)`,
      )
    : null;
  const bedrockish = n(
    db,
    `SELECT COUNT(DISTINCT session_id) AS n FROM usage_events
     WHERE source = 'live' AND session_id IS NOT NULL
       AND (model LIKE 'anthropic.%%' OR model LIKE 'us.anthropic.%%' OR model LIKE 'amazon.%%' OR model LIKE 'google.%%' OR model LIKE 'projects/%%')`,
  );
  // Older stores predate the context column: "not recorded yet" is NULL, never 0.
  const hasCtx = hasColumn(db, 'usage_events', 'execution_context_id');
  const noContext = hasCtx
    ? n(db, "SELECT COUNT(*) AS n FROM usage_events WHERE source = 'live' AND execution_context_id IS NULL")
    : null;
  const foreignCtx = hasCtx
    ? n(
        db,
        "SELECT COUNT(*) AS n FROM usage_events WHERE source = 'live' AND execution_context_id IS NOT NULL AND execution_context_id != (SELECT execution_context_id FROM usage_events WHERE execution_context_id IS NOT NULL GROUP BY execution_context_id ORDER BY COUNT(*) DESC LIMIT 1)",
      )
    : null;
  db.close();

  out.statements.push(
    {
      claim: 'There is no proof the OS user is the human at the keyboard — a row is attributed to an account, not a person.',
      basis: `${total - noUser} of ${total} live rows carry an OS-asserted user; the assertion source is whoever controls the laptop`,
      count: noUser,
    },
    {
      claim: 'No SSO principal exists anywhere on disk — local evidence cannot tie a session to a corporate identity.',
      basis: `${principals} pseudonymous principal(s) in the store, every one derived from the OS username or a declared file, never from a signed-in identity provider`,
      count: principals,
    },
    {
      claim: `A Bedrock/Vertex session's IAM identity never appears in a transcript — its rows cannot be attributed to a seat.`,
      basis: `${bedrockish ?? 0} session(s) match IAM-routed model-id shapes with no identity artifact to join on`,
      count: bedrockish,
    },
    {
      claim: 'Sessions with no binding evidence are attributed only by account, never by person.',
      basis: 'session_identity has no row for these sessions — the binding_evidence rank is absent, not zero',
      count: unbound,
    },
    {
      claim: 'Rows collected before the context column existed have unknown origin and are never merged into a named principal.',
      basis: 'execution_context_id is NULL on these rows; NULL is unknown, not local',
      count: noContext,
    },
    {
      claim: 'Rows stamped with a different execution context are quarantined, not merged — they may be another machine\'s work on a synced root.',
      basis: 'counted against the dominant (collector\'s own) context',
      count: foreignCtx,
    },
    {
      claim: 'Nothing here can distinguish work done inside a personal session on a corporate repo — attribution follows the path, not the intent.',
      basis: 'project-path classification is the only signal, and it is an inference stated on every row',
      count: null,
    },
  );
  return out;
}

const result = build();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Attribution limits — generated ${new Date(result.generated_at).toISOString()} from ${result.store}`);
  console.log('What Vole cannot know (per-employee attribution):\n');
  for (const s of result.statements) {
    const count = s.count === null ? 'unquantifiable' : `${s.count}`;
    console.log(`  - ${s.claim}`);
    console.log(`    basis: ${s.basis} [count: ${count}]`);
  }
}

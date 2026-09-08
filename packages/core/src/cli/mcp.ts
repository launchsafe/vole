/**
 * `vole mcp` — a stdio MCP server over the same queries the dashboard uses.
 * Tier 3 made it scoped and logged (feature 15): a master off switch, caller
 * identity recorded per query, and every tool invocation written to the
 * access_log — for a product whose pitch is that it never stores prompts, an
 * unscoped inventory of every session on the machine would be the exact leak
 * it detects.
 *
 * stdio MCP carries no authenticated caller identity — parent pid and cwd are
 * the strongest evidence available and both are trivially spoofable by the
 * same agent, so the log is a record, not a control.
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, openDbReadOnly, type DB } from '../db';
import { paths } from '../paths';
import {
  getAnomalies, getBreakdown, getDigest, getLiveSessions, getSessionDetail, getSummary, getWhatIf,
  type BreakdownBy, type Range,
} from '../queries';
import { callerIdentity, logAccess, mcpEnabled, restrictToCallerPrincipal } from '../identity/access';
import { whoamiModel } from '../identity/chain';
import { principalKey } from '../identity';
import { loadIdentityPolicy } from '../identity/policy';

// The master off switch: honoured before any store is opened, so an off
// configuration serves nothing at all.
const gate = mcpEnabled();
if (!gate.enabled) {
  console.error(`MCP access is OFF (${gate.source}). Turn it on by removing that declaration.`);
  process.exit(1);
}

// The query log needs write access to the store; the queries themselves stay
// read-only connections semantics. A missing store is an error, never created
// by a reader.
if (!existsSync(paths.db())) {
  console.error(`No Vole store at ${paths.db()} yet — run the collector first: pnpm collect --once`);
  process.exit(1);
}
const db: DB = (() => {
  try {
    return openDb(); // writable: the access_log is the point of the feature
  } catch {
    return openDbReadOnly();
  }
})();

const RANGE = { type: 'string', enum: ['24h', '7d', '30d', 'all'], description: 'Time range; default 24h' };
const range = (a: Record<string, unknown>): Range =>
  (['24h', '7d', '30d', 'all'] as const).find((r) => r === a.range) ?? '24h';

const caller = callerIdentity();
const accessor = `mcp:ppid=${caller.pid}:user=${caller.user ?? 'unknown'}:cwd=${caller.cwd}`;

/** Every tool call lands in the view-governance ledger before it runs. */
function record(view: string): void {
  try {
    logAccess(db, accessor, 'mcp_query', view);
  } catch {
    /* a read-only store must still serve the query, unlogged */
  }
}

const TOOLS: { name: string; description: string; inputSchema: object; run: (a: Record<string, unknown>) => unknown }[] = [
  {
    name: 'vole_summary',
    description: 'Totals for a range across every AI coding tool on this machine: calls, exact tokens, equivalent cost, sessions, cache hit ratio, errors, truncated calls, per-tool split.',
    inputSchema: { type: 'object', properties: { range: RANGE } },
    run: (a) => {
      record('vole_summary');
      return getSummary(db, range(a), false);
    },
  },
  {
    name: 'vole_live_sessions',
    description: 'Sessions active recently: context carried vs the model window, tokens per minute, cost, cache expiry time, last tools, open incidents. Pass session_id to look up one session regardless of age.',
    inputSchema: {
      type: 'object',
      properties: {
        since_minutes: { type: 'number', description: 'Look-back window, default 30' },
        session_id: { type: 'string' },
      },
    },
    run: (a) => {
      record('vole_live_sessions');
      return getLiveSessions(db, {
        sinceMs: (typeof a.since_minutes === 'number' ? a.since_minutes : 30) * 60_000,
        sessionId: typeof a.session_id === 'string' ? a.session_id : undefined,
      });
    },
  },
  {
    name: 'vole_session',
    description: 'One session in depth: totals, per-agent tree, the calls that grew the context most and which tools caused it, incidents, and the latest calls.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, last_calls: { type: 'number', description: 'How many recent calls to include, default 20' } }, required: ['session_id'] },
    run: (a) => {
      record('vole_session');
      const d = getSessionDetail(db, String(a.session_id));
      if (!d) return { error: 'no such session' };
      const n = typeof a.last_calls === 'number' ? a.last_calls : 20;
      return { ...d, calls_list: d.calls_list.slice(-n) };
    },
  },
  {
    name: 'vole_incidents',
    description: 'Anomalies Vole detected: burn spikes, runaway loops, retry storms, rate-limit and context pressure. Each carries the exact figures that fired it.',
    inputSchema: { type: 'object', properties: { range: RANGE, limit: { type: 'number' } } },
    run: (a) => {
      record('vole_incidents');
      return getAnomalies(db, range(a), false, typeof a.limit === 'number' ? a.limit : 50);
    },
  },
  {
    name: 'vole_breakdown',
    description: 'Usage grouped by model, project (working directory) or git branch.',
    inputSchema: { type: 'object', properties: { range: RANGE, by: { type: 'string', enum: ['model', 'project', 'branch'] } } },
    run: (a) => {
      record('vole_breakdown');
      return getBreakdown(db, range(a), false, (['model', 'project', 'branch'] as const).find((b) => b === a.by) as BreakdownBy | undefined);
    },
  },
  {
    name: 'vole_whatif',
    description: 'Arithmetic only: the same exact token split priced at other models\' list rates. Says nothing about whether another model would have done the job.',
    inputSchema: { type: 'object', properties: { range: RANGE } },
    run: (a) => {
      record('vole_whatif');
      return getWhatIf(db, range(a), false);
    },
  },
  {
    name: 'vole_digest',
    description: 'A period digest: totals, cache re-warm spend, top projects and models, incidents, biggest session, busiest day.',
    inputSchema: { type: 'object', properties: { range: RANGE } },
    run: (a) => {
      record('vole_digest');
      return getDigest(db, range(a), false);
    },
  },
  {
    // Tier 3 (feature 42): the eighth tool — the CLI and MCP mirror of
    // Settings → Identity. Truncated ids only; auth_shape rows are never
    // exposed. Honours the people_view gate: on a multi-principal store only
    // the caller's own principal is returned.
    name: 'vole_identity',
    description: 'Identity of this machine and its AI accounts: the resolved principal and its source, machine id and hostname history, and per tool the account class, plan, truncated org id and binding evidence. Truncated ids only.',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      record('vole_identity');
      const policy = loadIdentityPolicy();
      const restricted = restrictToCallerPrincipal(db, policy);
      const model = whoamiModel(db, restricted && caller.user ? principalKey(caller.user) : null);
      return {
        ...model,
        restricted_to_caller: restricted,
        note: 'MCP exposure returns truncated ids and never auth-shape rows; the caller identity (ppid/cwd) is spoofable evidence, not authentication.',
      };
    },
  },
];

interface Req { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: Record<string, unknown> }
const send = (msg: object): void => {
  process.stdout.write(JSON.stringify(msg) + '\n');
};

function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function handle(req: Req): void {
  const { id, method, params = {} } = req;
  if (id === undefined || id === null) return; // notification (e.g. notifications/initialized)
  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'vole', version: serverVersion() },
          instructions: 'Local usage, cost and reliability data for the AI coding agents on this machine. Every token count is exact; cost is equivalent API value at list price. Every query is logged with the caller pid and cwd.',
        },
      });
    case 'ping':
      return send({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } });
      try {
        const out = tool.run((params.arguments as Record<string, unknown>) ?? {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
      } catch (err) {
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: (err as Error).message }], isError: true } });
      }
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line) as Req);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
});

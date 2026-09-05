/**
 * `vole mcp` — a stdio MCP server over the same queries the dashboard uses, so an agent
 * can ask what its own session has cost, how full its context is, and whether Vole has
 * flagged it. Newline-delimited JSON-RPC on stdin/stdout, no dependencies; stdout
 * carries protocol messages only.
 */
import { createInterface } from 'node:readline';
import { openDb } from '../db';
import {
  getAnomalies, getBreakdown, getDigest, getLiveSessions, getSessionDetail, getSummary, getWhatIf,
  type BreakdownBy, type Range,
} from '../queries';

const db = openDb();
const RANGE = { type: 'string', enum: ['24h', '7d', '30d', 'all'], description: 'Time range; default 24h' };
const range = (a: Record<string, unknown>): Range =>
  (['24h', '7d', '30d', 'all'] as const).find((r) => r === a.range) ?? '24h';

const TOOLS: { name: string; description: string; inputSchema: object; run: (a: Record<string, unknown>) => unknown }[] = [
  {
    name: 'vole_summary',
    description: 'Totals for a range across every AI coding tool on this machine: calls, exact tokens, equivalent cost, sessions, cache hit ratio, errors, truncated calls, per-tool split.',
    inputSchema: { type: 'object', properties: { range: RANGE } },
    run: (a) => getSummary(db, range(a), false),
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
    run: (a) =>
      getLiveSessions(db, {
        sinceMs: (typeof a.since_minutes === 'number' ? a.since_minutes : 30) * 60_000,
        sessionId: typeof a.session_id === 'string' ? a.session_id : undefined,
      }),
  },
  {
    name: 'vole_session',
    description: 'One session in depth: totals, per-agent tree, the calls that grew the context most and which tools caused it, incidents, and the latest calls.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, last_calls: { type: 'number', description: 'How many recent calls to include, default 20' } }, required: ['session_id'] },
    run: (a) => {
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
    run: (a) => getAnomalies(db, range(a), false, typeof a.limit === 'number' ? a.limit : 50),
  },
  {
    name: 'vole_breakdown',
    description: 'Usage grouped by model, project (working directory) or git branch.',
    inputSchema: { type: 'object', properties: { range: RANGE, by: { type: 'string', enum: ['model', 'project', 'branch'] } } },
    run: (a) => getBreakdown(db, range(a), false, (['model', 'project', 'branch'] as const).find((b) => b === a.by) as BreakdownBy | undefined),
  },
  {
    name: 'vole_whatif',
    description: 'Arithmetic only: the same exact token split priced at other models\' list rates. Says nothing about whether another model would have done the job.',
    inputSchema: { type: 'object', properties: { range: RANGE } },
    run: (a) => getWhatIf(db, range(a), false),
  },
  {
    name: 'vole_digest',
    description: 'A period digest: totals, cache re-warm spend, top projects and models, incidents, biggest session, busiest day.',
    inputSchema: { type: 'object', properties: { range: RANGE } },
    run: (a) => getDigest(db, range(a), false),
  },
];

interface Req { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: Record<string, unknown> }
const send = (msg: object): void => {
  process.stdout.write(JSON.stringify(msg) + '\n');
};

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
          serverInfo: { name: 'vole', version: '0.1.0' },
          instructions: 'Local usage, cost and reliability data for the AI coding agents on this machine. Every token count is exact; cost is equivalent API value at list price.',
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

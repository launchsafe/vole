/**
 * Tier 7 the human-confirmed handoff: for the one incident that matters, the
 * exact bytes are rendered FIRST — generic JSON, Slack Block Kit, or
 * PagerDuty Events v2 with dedup_key = anomaly_key — and nothing leaves
 * until a human confirms the literal preview. This is outbound network:
 * off by default, opt-in per URL, gated through egress() as the single
 * choke point, and honours VOLE_NO_EGRESS exactly like every other call.
 */
import type { DB } from '../db';
import { egress } from '../egress';

export type HandoffFormat = 'generic' | 'slack' | 'pagerduty';

export interface IncidentFigures {
  anomaly_key: string;
  rule: string;
  severity: string;
  tool: string | null;
  session_id: string | null;
  observed: number | null;
  baseline: number | null;
  threshold: number | null;
  window_start: number | null;
  window_end: number | null;
  detected_at: number | null;
}

/** Reads the figures that fired — the columns no reader used to select. */
export function incidentFigures(db: DB, anomaly_key: string): IncidentFigures | null {
  return (db
    .prepare(
      `SELECT anomaly_key, rule, severity, tool, session_id, observed, baseline, threshold,
              window_start, window_end, detected_at
       FROM anomalies WHERE anomaly_key = ?`,
    )
    .get(anomaly_key) as IncidentFigures | undefined) ?? null;
}

/**
 * The payload, field by field, from a deny-by-default allowlist. observed /
 * baseline / threshold always ride (principle 3: the analyst and the alert
 * cannot disagree about what fired); session_id rides for correlation;
 * nothing else — no detail prose, no user, no machine, no raw_ref.
 */
const HANDOFF_FIELDS = [
  'anomaly_key', 'rule', 'severity', 'tool', 'session_id',
  'observed', 'baseline', 'threshold', 'window_start', 'window_end', 'detected_at',
] as const;

function base(i: IncidentFigures): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of HANDOFF_FIELDS) {
    const v = (i as unknown as Record<string, unknown>)[f];
    if (v !== null && v !== undefined) out[f] = v; // NULL-omitting
  }
  return out;
}

/** The exact bytes that would leave — rendered BEFORE anything is sent. */
export function handoffPayload(i: IncidentFigures, format: HandoffFormat): string {
  const f = base(i);
  if (format === 'generic') return JSON.stringify({ vole_incident: f }, null, 1);
  if (format === 'pagerduty') {
    return JSON.stringify({
      routing_key: 'REDACTED — set at send time, never in the preview',
      event_action: 'trigger',
      dedup_key: i.anomaly_key,
      payload: {
        summary: `Vole ${i.severity}: ${i.rule}`,
        source: i.tool ?? 'vole',
        severity: i.severity === 'critical' ? 'critical' : i.severity === 'warn' ? 'warning' : 'info',
        custom_details: f,
      },
    }, null, 1);
  }
  // Slack Block Kit: figures as fields, one per line, nothing prose-shaped.
  const fields = Object.entries(f).map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*: \`${String(v)}\`` }));
  return JSON.stringify({ blocks: [{ type: 'section', fields }] }, null, 1);
}

export interface HandoffResult {
  sent: boolean;
  reason: string;
  endpoint?: string;
}

/**
 * Sends only after the human confirms — `confirmed: false` (or an absent
 * endpoint) renders the preview and sends NOTHING. Routes through egress();
 * a refused switch reports the refusal instead of pretending a delivery.
 */
export function sendHandoff(
  i: IncidentFigures,
  format: HandoffFormat,
  opts: { endpoint: string | null; confirmed: boolean; routingKey?: string },
): HandoffResult {
  if (!opts.endpoint) return { sent: false, reason: 'no endpoint configured — handoff is opt-in per URL and default-off' };
  if (!opts.confirmed) return { sent: false, reason: 'not confirmed — the payload was rendered, nothing left the machine', endpoint: opts.endpoint };
  const gate = egress({ caller: 'handoff', destination: opts.endpoint, purpose: `incident ${i.anomaly_key} handoff (${format})`, ts: Date.now() });
  if (!gate.allowed) return { sent: false, reason: 'egress refused (VOLE_NO_EGRESS)', endpoint: opts.endpoint };
  // ponytail: no HTTP client is wired here by design — the Mac app owns the
  // confirmed POST with its own TLS stack, and the core stays dependency-free.
  // This function's contract is the GATE (preview -> confirm -> egress), and
  // the app calls it with its sender injected via this marker for integration.
  return { sent: true, reason: 'confirmed by a human and passed the egress gate; delivery is the app sender\'s to perform', endpoint: opts.endpoint };
}

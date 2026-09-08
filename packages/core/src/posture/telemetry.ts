import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DB } from '../db';
import { RULE_IDS } from '../detect';
import { home, readJson, readJsonc, parseToml, parseHost, upsertLever } from './shared';

/**
 * Native-telemetry and prompt-logging posture, and the vendor lever cards.
 *
 * A config file proves what is WRITTEN, not what runs — a CLI flag, env var or
 * MDM profile can override it — so a card can say 'hardened' about a session
 * that is not. Keys absent from the file render 'not set', never the vendor's
 * default. And a snapshot must never be stamped onto historical rows: a flag
 * flipped yesterday says nothing about last week.
 */

export interface TelemetryLevers {
  lever: string;
  observed: string | null;
  host: string | null;
}

/** The telemetry/prompt-logging levers for one settings layer (names + host only). */
export function telemetryLeversFromEnv(env: Record<string, unknown>): TelemetryLevers[] {
  const out: TelemetryLevers[] = [];
  const get = (k: string): string | null => (typeof env[k] === 'string' ? env[k] as string : null);
  const rows: [string, string | null][] = [
    ['CLAUDE_CODE_ENABLE_TELEMETRY', get('CLAUDE_CODE_ENABLE_TELEMETRY')],
    ['OTEL_EXPORTER_OTLP_PROTOCOL', get('OTEL_EXPORTER_OTLP_PROTOCOL')],
    ['OTEL_EXPORTER_OTLP_HEADERS', env.OTEL_EXPORTER_OTLP_HEADERS != null ? '<names only>' : null],
    ['OTEL_LOG_USER_PROMPTS', get('OTEL_LOG_USER_PROMPTS')],
    ['OTEL_LOG_TOOL_CONTENT', get('OTEL_LOG_TOOL_CONTENT')],
  ];
  const endpoint = get('OTEL_EXPORTER_OTLP_ENDPOINT');
  if (endpoint !== null) rows.push(['OTEL_EXPORTER_OTLP_ENDPOINT', endpoint]);
  for (const [lever, observed] of rows) {
    if (observed === null) continue;
    out.push({
      lever: `env:${lever}`,
      observed: lever === 'OTEL_EXPORTER_OTLP_ENDPOINT' ? parseHost(observed) ?? observed : observed,
      host: lever === 'OTEL_EXPORTER_OTLP_ENDPOINT' ? parseHost(observed) : null,
    });
  }
  return out;
}

/** Read the Claude settings layers in precedence order (managed > user > local):
 *  the first layer that carries the key wins — the file that decided it is stored. */
export function sweepTelemetryPosture(db: DB, now: number): number {
  let n = 0;
  const layers = [
    { file: '/Library/Application Support/ClaudeCode/managed-settings.json', cls: 'managed' },
    { file: join(home(), '.claude', 'settings.json'), cls: 'user' },
    { file: join(home(), '.claude', 'settings.local.json'), cls: 'user' },
  ];
  for (const { file } of layers) {
    const cfg = readJson(file) as { env?: Record<string, unknown> } | undefined;
    if (!cfg?.env) continue;
    for (const l of telemetryLeversFromEnv(cfg.env)) {
      upsertLever(db, 'claude_code', l.lever, l.observed, 'unset', file, now);
      n++;
    }
  }
  // Codex: [otel] exporter in config.toml.
  const codexToml = join(home(), '.codex', 'config.toml');
  if (existsSync(codexToml)) {
    try {
      const otel = parseToml(readFileSync(codexToml, 'utf8')).sections.get('otel');
      const exporter = otel?.get('exporter');
      if (typeof exporter === 'string') {
        upsertLever(db, 'codex', 'otel:exporter', parseHost(exporter) ?? exporter, 'unset', codexToml, now);
        n++;
      }
    } catch { /* malformed */ }
  }
  return n;
}

// ── Vendor lever cards ─────────────────────────────────────────────────────────

/**
 * Each tool's own permission config, observed beside the hardened value. The
 * hardened values are Vole's editorial recommendation (the product's position,
 * versioned here), and 'not set' means absent from the file — never the vendor
 * default, which Vole does not model.
 */
export const HARDENED_LEVERS: Record<string, Record<string, string>> = {
  opencode: { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' },
  grok: { yolo: 'false', permission_mode: 'default' },
  codex: { approval_policy: 'untrusted', sandbox_mode: 'write-dangerous-strict' },
};

export function sweepVendorLevers(db: DB, now: number): number {
  let n = 0;
  // opencode.jsonc permission block.
  const opencode = join(home(), '.config', 'opencode', 'opencode.jsonc');
  const oc = readJsonc(opencode) as { permission?: Record<string, string> } | undefined;
  const perm = oc?.permission;
  for (const [lever, hardened] of Object.entries(HARDENED_LEVERS.opencode!)) {
    const observed = perm ? (perm[lever] ?? null) : null;
    upsertLever(db, 'opencode', `permission:${lever}`, observed, hardened, opencode, now);
    n++;
  }
  // Grok config.toml.
  const grokToml = join(home(), '.grok', 'config.toml');
  if (existsSync(grokToml)) {
    try {
      const top = parseToml(readFileSync(grokToml, 'utf8')).sections.get('')!;
      for (const [lever, hardened] of Object.entries(HARDENED_LEVERS.grok!)) {
        const v = top.get(lever);
        upsertLever(db, 'grok', lever, v === undefined ? null : String(v), hardened, grokToml, now);
        n++;
      }
    } catch { /* malformed */ }
  }
  // Codex config.toml.
  const codexToml = join(home(), '.codex', 'config.toml');
  if (existsSync(codexToml)) {
    try {
      const top = parseToml(readFileSync(codexToml, 'utf8')).sections.get('')!;
      for (const [lever, hardened] of Object.entries(HARDENED_LEVERS.codex!)) {
        const v = top.get(lever);
        upsertLever(db, 'codex', lever, v === undefined ? null : String(v), hardened, codexToml, now);
        n++;
      }
    } catch { /* malformed */ }
  }
  return n;
}

// ── detection_epochs ─────────────────────────────────────────────────────────

/**
 * Rules have a birthday: a retro-hunt applies today's knowledge to yesterday's
 * evidence, which makes 'no incidents before March' ambiguous between nothing
 * happened and nothing was looking. One row per distinct rule-set identity,
 * inserted only when that identity is new — idempotent on the sha, and the
 * epoch number is derived from what is already stored, never from now().
 */
export function ruleSetSha(): string {
  return createHash('sha256').update(RULE_IDS.join('\n')).digest('hex');
}

export function recordDetectionEpoch(db: DB, now: number): number {
  const sha = ruleSetSha();
  const prev = db.prepare('SELECT epoch FROM detection_epochs WHERE rule_set_sha256 = ?').get(sha) as { epoch: number } | undefined;
  if (prev) return prev.epoch;
  const max = db.prepare('SELECT MAX(epoch) AS m FROM detection_epochs').get() as { m: number | null };
  const epoch = (max.m ?? 0) + 1;
  db.prepare('INSERT INTO detection_epochs (epoch, rule_set_sha256, created_at) VALUES (?, ?, ?)').run(epoch, sha, now);
  return epoch;
}

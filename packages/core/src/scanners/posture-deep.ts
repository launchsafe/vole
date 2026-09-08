import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DB, Scanner } from '../db';
import { openDb, insertAnomalies } from '../db';
import {
  home, sha, loadState, saveState, bumpCounter, walkClaudeTranscripts, tryReaddir,
} from '../posture/shared';
import {
  sweepMcpServers, mcpSpendJoin, detectShadowMcp, recordInstructionSightings,
  recordToolSurface, instructionSightingsFromLine, toolSurfaceFromLine,
} from '../posture/mcp';
import { recordHookRuns, hookRunsFromLine } from '../posture/hooks';
import {
  widenGrantPrecedence, blanketInventory, sweepOverrides, sweepKiro, sweepXcodePosture,
  sweepWorkspaceTrust, sweepInjections, sweepPolicyLayers, recordPerTurnGrants,
} from '../posture/grants';
import { sweepOsGrants } from '../posture/tcc';
import { sweepTelemetryPosture, sweepVendorLevers, recordDetectionEpoch } from '../posture/telemetry';
import { sweepPlugins, sweepEditorSyncedSkills } from '../posture/plugins';
import { sweepSigning } from '../posture/signing';

/**
 * Tier 6 deep: the posture scanners — the config-level attacks the 2025-26
 * incident record is made of. Each read is a local config or the agents' own
 * logs; nothing phones home, and env values / prompt text never reach the store.
 *
 *  1. Instruction-file hidden-Unicode scan (the Rules File Backdoor) with the
 *     full codepoint classes, line numbers, the include graph and plugin files.
 *  2. The MCP plane: registration sweep keyed on endpoint identity, the
 *     registered-vs-observed spend join, shadow servers, the instruction
 *     rug-pull detector and the offered-tool-surface ledger.
 *  3. The grants plane: precedence chain, overrides, blanket-approval inventory,
 *     the Kiro always-accept click, the Xcode skip-permissions default,
 *     workspace-trust transitions, cross-agent injection, managed layers.
 *  4. os_grants (TCC), telemetry posture, vendor levers, hooks, plugins,
 *     signing — and detection_epochs, the rule-set birthday record.
 */

// ── 1. Hidden-Unicode scan ────────────────────────────────────────────────────

/** The dangerous Unicode classes, by name — findings store (file, class,
 *  codepoint, count, line_no), never the surrounding text. */
const HIDDEN_CLASSES: [string, RegExp][] = [
  ['zero_width', /[\u200B-\u200F\u2060]/g],
  ['bidi', /[\u202A-\u202E\u2066-\u2069\u061C]/g],
  ['unicode_tags', /[\u{E0000}-\u{E007F}]/gu],
  ['soft_hyphen', /\u00AD/g],
  ['bom_in_body', /\uFEFF/g],
];

export interface HiddenUnicodeFinding {
  file: string;
  cls: string;
  codepoint: string;
  count: number;
  line_no: number;
}

export function scanHiddenUnicode(file: string): HiddenUnicodeFinding[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: HiddenUnicodeFinding[] = [];
  const lines = text.split('\n');
  for (const [cls, re] of HIDDEN_CLASSES) {
    for (let i = 0; i < lines.length; i++) {
      const line = i === 0 && cls === 'bom_in_body' ? lines[0]!.slice(1) : lines[i]!; // a BOM at offset 0 is the file's own encoding marker
      const hits = line.match(re);
      if (!hits) continue;
      out.push({
        file,
        cls,
        codepoint: `U+${hits[0]!.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
        count: hits.length,
        line_no: i + 1,
      });
    }
  }
  return out;
}

/** The include graph: @path references instruction files load from other files. */
export function includesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@(~?[^\s`*]+)/g)) {
    const p = m[1]!.replace(/[.,;:)]+$/, ''); // strip sentence punctuation
    // An include is a path: it carries a separator. '@username' and email
    // locals are not includes.
    if (p.includes('/')) out.push(p);
  }
  return out;
}

function instructionFiles(db: DB, extra: string[]): string[] {
  const files = new Set<string>(extra);
  const h = home();
  for (const f of ['.claude/CLAUDE.md', 'CLAUDE.md', 'AGENTS.md', '.windsurfrules']) {
    files.add(join(h, f));
  }
  // The cursor rules glob the first pass skipped by design — now covered.
  const cursorRules = tryReaddir(join(h, '.cursor', 'rules'));
  if (cursorRules.ok) {
    for (const f of cursorRules.entries) if (f.endsWith('.mdc')) files.add(join(h, '.cursor', 'rules', f));
  }
  // Every plugin's own AGENTS.md — instruction packs with a marketplace provenance.
  const pluginRoot = join(h, '.claude', 'plugins');
  const walkPlugins = (dir: string, depth: number): void => {
    if (depth > 3) return;
    const entries = tryReaddir(dir);
    if (!entries.ok) return;
    for (const e of entries.entries) {
      const p = join(dir, e);
      if (e === 'AGENTS.md' || e === 'CLAUDE.md') files.add(p);
      else {
        try {
          if (readdirSync(p).length >= 0) walkPlugins(p, depth + 1);
        } catch { /* not a dir */ }
      }
    }
  };
  if (existsSync(pluginRoot)) walkPlugins(pluginRoot, 0);
  // Project-level instruction files from live evidence.
  for (const { project } of db.prepare(
    "SELECT DISTINCT project FROM usage_events WHERE project IS NOT NULL AND source = 'live' LIMIT 100",
  ).all() as { project: string }[]) {
    for (const f of ['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.github/copilot-instructions.md', 'GEMINI.md']) {
      files.add(join(project, f));
    }
  }
  return [...files].filter((f) => existsSync(f) && f.startsWith('/'));
}

function scanInstructionFiles(db: DB, extra: string[], now: number): { found: number; files: number } {
  const files = instructionFiles(db, extra);
  let found = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const findings = scanHiddenUnicode(file);
    // The instruction-file inventory: bytes, include count, hidden hits.
    bumpCounter(db, `instructions:${sha(file)}`, 'bytes', Buffer.byteLength(text), now);
    bumpCounter(db, `instructions:${sha(file)}`, 'includes', includesIn(text).length, now);
    if (findings.length) bumpCounter(db, `instructions:${sha(file)}`, 'hidden_codepoints', findings.reduce((a, f) => a + f.count, 0), now);
    if (!findings.length) continue;
    found++;
    insertAnomalies(db, [{
      anomaly_key: `hidden_unicode:${createHash('sha256').update(file).digest('hex').slice(0, 24)}`,
      rule: 'hidden_unicode_instruction',
      severity: 'warn', // a flag for human review, never a verdict — RTL text and ZWJ are legitimate
      tool: 'claude_code' as never,
      session_id: null,
      model: null,
      window_start: now,
      window_end: now,
      title: `Hidden Unicode in instruction file`,
      detail:
        `${file.replace(homedir(), '~')} carries invisible/bidi characters: ` +
        findings.map((f) => `${f.cls} ${f.codepoint} ×${f.count} at line ${f.line_no}`).join(', ') +
        `. The Rules File Backdoor shape: instructions that read differently to human and machine. ` +
        `Text is not stored.`,
      observed: findings.reduce((a, f) => a + f.count, 0),
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    }]);
  }
  return { found, files: files.length };
}

// ── The scanner ────────────────────────────────────────────────────────────────

export const postureScanner: Scanner = {
  name: 'posture-deep',
  cadenceMs: 10 * 60_000,
  run: () => {
    const db: DB = openDb();
    const now = Date.now();
    const state = loadState();

    const synced = sweepEditorSyncedSkills(db, now);
    const unicode = scanInstructionFiles(db, synced.skillFiles, now);

    // MCP plane.
    const mcp = sweepMcpServers(db, now);
    const shadow = detectShadowMcp(db, now);
    const spend = mcpSpendJoin(db, now);

    // Transcript plane (bounded, cursor-gated): hooks, rug pulls, tool surface.
    // All three accumulate PER FILE and flush on file change — the counters are
    // absolute-per-file with MAX semantics, so a re-read of an unchanged file is
    // a no-op and polling stays idempotent.
    let hookRows = 0;
    let rugPulls = 0;
    let offered = 0;
    let perTurn = 0;
    let curFile = '';
    let hookBatch: ReturnType<typeof hookRunsFromLine> = [];
    let sightBatch: ReturnType<typeof instructionSightingsFromLine> = [];
    let surfBatch: ReturnType<typeof toolSurfaceFromLine> = [];
    let perTurnBatch: string[] = [];
    const flush = (): void => {
      if (!curFile) return;
      hookRows += recordHookRuns(db, curFile, hookBatch, now);
      rugPulls += recordInstructionSightings(db, state, curFile, sightBatch, now);
      offered += recordToolSurface(db, surfBatch, now).offered;
      if (perTurnBatch.length) perTurn += recordPerTurnGrants(db, perTurnBatch, curFile, now);
      hookBatch = [];
      sightBatch = [];
      surfBatch = [];
      perTurnBatch = [];
    };
    const walk = walkClaudeTranscripts((ev) => {
      if (ev.file !== curFile) {
        flush();
        curFile = ev.file;
      }
      hookBatch.push(...hookRunsFromLine(ev.line));
      sightBatch.push(...instructionSightingsFromLine(ev.line));
      surfBatch.push(...toolSurfaceFromLine(ev.session, ev.line));
      if (ev.line.type === 'attachment') {
        const a = ev.line.attachment as { type?: string; allowedTools?: string[] } | undefined;
        if (a?.type === 'command_permissions' && a.allowedTools?.length) {
          perTurnBatch.push(...a.allowedTools);
        }
      }
    }, state);
    flush();

    // Grants plane.
    const widened = widenGrantPrecedence(db, now);
    const blanket = blanketInventory(db, now);
    const overrides = sweepOverrides(db, now);
    const kiro = sweepKiro(db, now);
    const xcode = sweepXcodePosture(db, now);
    const trust = sweepWorkspaceTrust(db, state, now);
    const inject = sweepInjections(db, now);
    const layers = sweepPolicyLayers(db, now);

    // OS, telemetry, plugins, signing, epochs.
    const tcc = sweepOsGrants(db, now);
    const telemetry = sweepTelemetryPosture(db, now);
    const levers = sweepVendorLevers(db, now);
    const plugins = sweepPlugins(db, now);
    const signing = sweepSigning(db, state, now);
    const epoch = recordDetectionEpoch(db, now);

    saveState(state);
    return {
      ok: true,
      notes:
        `${unicode.found} hidden-unicode finding(s) over ${unicode.files} instruction file(s) · ` +
        `${mcp.registered} MCP registration(s) (${mcp.aliases} alias group(s)), ${shadow} shadow, ${spend.dormant} dormant · ` +
        `${walk.read} transcript(s) read: ${hookRows} hook hash(es), ${rugPulls} rug-pull(s), ${offered} offered tool name(s) · ` +
        `${widened} grant(s) widened, ${blanket.entries} inventoried (${blanket.wildcardCalls} wildcard-authorised, ${blanket.postureCalls} posture), ` +
        `${overrides} override(s), ${kiro.rules} kiro rule(s), xcode skip=${xcode === null ? 'unknown' : xcode} · ` +
        `${trust.incidents} untrusted-execution incident(s), ${inject.cells} injection cell(s) (${inject.credentialShaped} credential-shaped) · ` +
        `${layers.layers} policy layer(s) (${layers.managedAgents} agent(s) managed) · ` +
        `TCC ${tcc.grants} AI-app grant(s), ${tcc.denied} db denied · ${telemetry} telemetry lever(s), ${levers} vendor lever(s) · ` +
        `${plugins.plugins} plugin row(s), ${plugins.marketplaces} marketplace(s) · ` +
        `${signing.binaries} binar(ies) swept (${signing.adhoc} adhoc/unknown) · detection epoch ${epoch}`,
    };
  },
};

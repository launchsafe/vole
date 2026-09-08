import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from '../db';
import type { Anomaly } from '../types';
import { parseJsonc, sha256hex, structDiff } from './util';
import { readIgnorePatterns, readTrackedPaths, trackedStateFor } from './tracked';
import { originSlug } from './roots';

/**
 * The bounded repo sweep (tier 6 §51): a scanner that may only open files
 * named literally in the shipped repo_artifact_manifest. readdir is permitted
 * only on the manifest's declared directory prefixes at the manifest's
 * declared depth. Every read is sha'd (drift proof, never intent), sized and
 * mtime'd; over-budget files are skipped and counted, never silently dropped.
 */

export interface ManifestEntry {
  /** relative glob under the work root */
  glob: string;
  kind: string;
  /** hash-only artifacts (lockfiles): name, bytes, mtime, sha256 — never contents */
  hashOnly?: boolean;
  /** glob to exclude within the matched set (e.g. *.sample hooks) */
  exclude?: string;
}

export const MANIFEST_VERSION = 3;

export const REPO_ARTIFACT_MANIFEST: ManifestEntry[] = [
  { glob: '.claude/settings.json', kind: 'claude_settings' },
  { glob: '.claude/settings.local.json', kind: 'claude_settings_local' },
  { glob: '.claude/hooks/*', kind: 'claude_hook' },
  { glob: '.claude/skills/*/SKILL.md', kind: 'claude_skill' },
  { glob: '.mcp.json', kind: 'mcp_json' },
  { glob: '.cursorrules', kind: 'cursor_rules' },
  { glob: '.cursor/rules/**', kind: 'cursor_rules' },
  { glob: '.cursor/mcp.json', kind: 'mcp_json' },
  { glob: '.cursor/hooks', kind: 'cursor_hooks' },
  { glob: '.github/copilot-instructions.md', kind: 'copilot_instructions' },
  { glob: '.github/workflows/**', kind: 'ci_workflow' },
  { glob: 'AGENTS.md', kind: 'agent_instructions' },
  { glob: 'CLAUDE.md', kind: 'agent_instructions' },
  { glob: 'GEMINI.md', kind: 'agent_instructions' },
  { glob: '.devcontainer/devcontainer.json', kind: 'devcontainer' },
  { glob: '.devcontainer/*/devcontainer.json', kind: 'devcontainer' },
  { glob: 'devcontainer.json', kind: 'devcontainer' },
  { glob: '.continue/config.yaml', kind: 'continue_config' },
  { glob: '.clinerules', kind: 'agent_instructions' },
  { glob: '.roomodes', kind: 'agent_instructions' },
  { glob: '.vscode/settings.json', kind: 'vscode_settings' },
  { glob: '.git/hooks/*', kind: 'git_hook', exclude: '*.sample' },
  { glob: 'compose.yaml', kind: 'container_manifest' },
  { glob: 'docker-compose*.yml', kind: 'container_manifest' },
  { glob: 'docker-compose*.yaml', kind: 'container_manifest' },
  // Lockfiles: hash-only artifact kinds (spec §53) — the sha change across an
  // install window is the Keyv-worm corroboration, contents are never parsed.
  { glob: 'package-lock.json', kind: 'lockfile', hashOnly: true },
  { glob: 'pnpm-lock.yaml', kind: 'lockfile', hashOnly: true },
  { glob: 'yarn.lock', kind: 'lockfile', hashOnly: true },
  { glob: 'Cargo.lock', kind: 'lockfile', hashOnly: true },
  { glob: 'uv.lock', kind: 'lockfile', hashOnly: true },
  { glob: 'poetry.lock', kind: 'lockfile', hashOnly: true },
  { glob: 'go.sum', kind: 'lockfile', hashOnly: true },
  { glob: 'Gemfile.lock', kind: 'lockfile', hashOnly: true },
];

// ── glob expansion at declared depth only ───────────────────────────────────

function starMatch(seg: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  return re.test(seg);
}

/**
 * Expand one manifest glob under a root. `**` walks at most `maxDepth`
 * directory levels (the manifest's declared depth); `*` matches one segment.
 * No readdir outside the declared prefixes.
 */
export function expandGlob(rootPath: string, glob: string, exclude?: string | undefined, maxDepth = 4): string[] {
  const segs = glob.split('/').filter((s) => s.length > 0);
  let current: string[][] = [[]]; // list of matched relative segment lists
  for (const seg of segs) {
    const next: string[][] = [];
    for (const base of current) {
      const abs = join(rootPath, ...base);
      if (seg === '**') {
        // depth-bounded recursive walk (ponytail: capped at maxDepth)
        const walk = (rel: string[], depth: number) => {
          let entries: Dirent[] = [];
          try {
            entries = readdirSync(join(rootPath, ...rel), { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const child = [...rel, e.name];
            next.push(child);
            if (e.isDirectory() && depth + 1 < maxDepth) walk(child, depth + 1);
          }
        };
        walk(base, 0);
      } else if (seg.includes('*')) {
        let entries: Dirent[] = [];
        try {
          entries = readdirSync(abs, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (exclude && starMatch(e.name, exclude)) continue;
          if (starMatch(e.name, seg)) next.push([...base, e.name]);
        }
      } else {
        if (existsSync(join(abs, seg))) next.push([...base, seg]);
      }
    }
    current = next;
  }
  return current
    .map((segsList) => segsList.join('/'))
    .filter((rel) => {
      try {
        return statSync(join(rootPath, rel)).isFile();
      } catch {
        return false;
      }
    });
}

// ── the sweep ───────────────────────────────────────────────────────────────

export interface GrantExtraction {
  relPath: string;
  artifactSha: string;
  ruleText: string;
  trackedState: 'tracked' | 'untracked' | 'unknown';
}

export interface SweepChange {
  relPath: string;
  kind: string;
  fromSha: string | null;
  toSha: string;
}

export interface SweepReceipt {
  rootPath: string;
  state: 'ok' | 'unreadable' | 'not_present';
  files: number;
  bytes: number;
  skippedOverBudget: { relPath: string; sizeBytes: number }[];
  manifestVersion: number;
  newArtifacts: { relPath: string; kind: string; sha256: string }[];
  changedArtifacts: SweepChange[];
  grants: GrantExtraction[];
  tracked: { parsed: boolean; paths: Set<string> };
}

const ARTIFACT_KEY = (root: string, rel: string) => sha256hex(`${root}\n${rel}`);

/**
 * Sweep one root against the declared manifest within the byte budget.
 * Idempotent: artifact_key = sha256(root|rel) (no now()-derived input), the
 * upsert refreshes current-state columns (sha/size/mtime/tracked_state) and
 * first_seen stays the original observation.
 */
export function sweepRoot(db: DB, rootPath: string, now: number, byteBudget = 5 * 1024 * 1024): SweepReceipt {
  const receipt: SweepReceipt = {
    rootPath, state: 'ok', files: 0, bytes: 0, skippedOverBudget: [],
    manifestVersion: MANIFEST_VERSION, newArtifacts: [], changedArtifacts: [], grants: [],
    tracked: readTrackedPaths(rootPath),
  };
  if (!existsSync(rootPath)) {
    receipt.state = 'not_present';
    return receipt;
  }
  try {
    statSync(rootPath);
  } catch {
    receipt.state = 'unreadable';
    return receipt;
  }
  const upsert = db.prepare(
    `INSERT INTO repo_artifacts (artifact_key, root_path, rel_path, kind, tracked_state, sha256, size_bytes, mtime, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_key) DO UPDATE SET
       last_seen = excluded.last_seen, sha256 = excluded.sha256, size_bytes = excluded.size_bytes,
       mtime = excluded.mtime, tracked_state = excluded.tracked_state, kind = excluded.kind`,
  );
  const prior = db.prepare(`SELECT sha256, first_seen FROM repo_artifacts WHERE artifact_key = ?`);
  const ignorePatterns = readIgnorePatterns(rootPath);
  let budget = byteBudget;
  for (const entry of REPO_ARTIFACT_MANIFEST) {
    for (const rel of expandGlob(rootPath, entry.glob, entry.exclude)) {
      let st;
      let bytes: Buffer;
      try {
        st = statSync(join(rootPath, rel));
        if (st.size > budget) {
          receipt.skippedOverBudget.push({ relPath: rel, sizeBytes: st.size });
          continue;
        }
        bytes = readFileSync(join(rootPath, rel));
      } catch {
        continue; // unreadable file: skipped, counted below as absent next pass
      }
      budget -= st!.size;
      const sha = sha256hex(bytes!);
      const tracked = trackedStateFor(rel, receipt.tracked);
      const key = ARTIFACT_KEY(rootPath, rel);
      const before = prior.get(key) as { sha256: string | null; first_seen: number } | undefined;
      upsert.run(key, rootPath, rel, entry.kind, tracked, sha, st!.size, Math.round(st!.mtimeMs), before?.first_seen ?? now, now);
      receipt.files++;
      receipt.bytes += st!.size;
      if (!before) receipt.newArtifacts.push({ relPath: rel, kind: entry.kind, sha256: sha });
      else if (before.sha256 !== sha) receipt.changedArtifacts.push({ relPath: rel, kind: entry.kind, fromSha: before.sha256, toSha: sha });
      if (!entry.hashOnly) extractGrants(bytes!, entry.kind, rel, sha, tracked, receipt, ignorePatterns);
    }
  }
  // A budget-starved pass is not a completed scan: it leaves the previous
  // cursor and receipt intact rather than clobbering them with a partial one.
  if (receipt.skippedOverBudget.length === 0) {
    db.prepare(
      `INSERT INTO repo_scan_state (root_path, cursor_int, bytes_scanned, last_scan_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(root_path) DO UPDATE SET
         cursor_int = excluded.cursor_int, bytes_scanned = excluded.bytes_scanned, last_scan_at = excluded.last_scan_at`,
    ).run(rootPath, receipt.files, receipt.bytes, now);
  }
  return receipt;
}

export function sweepAllRoots(db: DB, now: number, byteBudget?: number): SweepReceipt[] {
  const roots = db
    .prepare(`SELECT root_path FROM work_roots WHERE exists_now = 1`)
    .all() as { root_path: string }[];
  return roots.map((r) => sweepRoot(db, r.root_path, now, byteBudget));
}

/** The footer sentence from spec §51: 'read 88 KB across 12 files in 3 roots, 0 skipped over budget, manifest v3'. */
export function sweepFooter(receipts: SweepReceipt[]): string {
  const files = receipts.reduce((n, r) => n + r.files, 0);
  const bytes = receipts.reduce((n, r) => n + r.bytes, 0);
  const skipped = receipts.reduce((n, r) => n + r.skippedOverBudget.length, 0);
  const roots = receipts.filter((r) => r.state === 'ok').length;
  const kb = bytes >= 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${bytes} B`;
  return `read ${kb} across ${files} files in ${roots} roots, ${skipped} skipped over budget, manifest v${MANIFEST_VERSION}`;
}

// ── grant extraction from artifact bytes (repo_carried_grant, §15) ──────────

const GRANT_KINDS = new Set(['claude_settings', 'claude_settings_local', 'mcp_json', 'vscode_settings', 'cursor_hooks']);

function extractGrants(
  bytes: Buffer,
  kind: string,
  relPath: string,
  sha: string,
  tracked: 'tracked' | 'untracked' | 'unknown',
  receipt: SweepReceipt,
  _ignorePatterns: unknown,
): void {
  if (!GRANT_KINDS.has(kind)) return;
  const parsed = parseJsonc<Record<string, unknown>>(bytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object') return;
  if (kind === 'mcp_json' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
    for (const name of Object.keys(parsed.mcpServers as object)) {
      receipt.grants.push({ relPath, artifactSha: sha, ruleText: `mcp:${name}`, trackedState: tracked });
    }
    return;
  }
  const perms = parsed.permissions as Record<string, unknown> | undefined;
  if (perms && Array.isArray(perms.allow)) {
    for (const rule of perms.allow) {
      if (typeof rule === 'string') receipt.grants.push({ relPath, artifactSha: sha, ruleText: rule, trackedState: tracked });
    }
  }
}

/** repo_carried_grant (§15): a committed grant installs itself on every clone. */
export function detectRepoCarriedGrant(db: DB, now: number, receipts: SweepReceipt[]): Anomaly[] {
  const originByRoot = new Map(
    (db.prepare(`SELECT root_path, origin_slug FROM work_roots`).all() as { root_path: string; origin_slug: string | null }[])
      .map((r) => [r.root_path, r.origin_slug]),
  );
  const out: Anomaly[] = [];
  for (const receipt of receipts) {
    for (const g of receipt.grants) {
      if (g.trackedState !== 'tracked') continue; // only staged-in-the-index grants travel
      const origin = originByRoot.get(receipt.rootPath) ?? null;
      out.push({
        anomaly_key: `repo_carried_grant:${sha256hex(`${receipt.rootPath}|${g.artifactSha}|${sha256hex(g.ruleText)}`)}`,
        rule: 'repo_carried_grant' as const,
        severity: 'warn' as const,
        tool: 'claude_code' as const,
        session_id: null,
        model: null,
        window_start: now,
        window_end: now,
        title: `Permission rule travels with the clone: ${g.ruleText}`,
        detail:
          `${g.relPath} is staged in this repo's index, so the rule "${g.ruleText}" installs itself on every ` +
          `clone, teammate checkout and CI runner without an approval prompt (staged in this repo — ` +
          `whether it was pushed and how many clones exist is not observable from this laptop). ` +
          `Origin: ${origin ?? 'unknown (no remote) — blast radius unknown, not one'}. Artifact sha256 ${g.artifactSha}.`,
        observed: 1,
        baseline: null,
        threshold: null,
        confidence: 'exact' as const,
        source: 'live' as const,
        detected_at: now,
      });
    }
  }
  return out;
}

/**
 * agent_config_with_dependency (§53): the Keyv-worm shape — a config artifact
 * first observed inside a package-install window for the same root, with the
 * root's lockfile sha changing across the same boundary. The install's cwd is
 * resolved through package_execs -> tool_calls.session_id -> usage_events.project
 * (the evidence chain already in the store).
 */
export function detectAgentConfigWithDependency(db: DB, now: number, receipts: SweepReceipt[]): Anomaly[] {
  const out: Anomaly[] = [];
  const sessionProject = db.prepare(`SELECT DISTINCT project FROM usage_events WHERE session_id = ? AND project IS NOT NULL`);
  const installAt = db.prepare(
    `SELECT pe.ts AS ts FROM package_execs pe
     JOIN tool_calls tc ON tc.tool_call_key = pe.call_key
     WHERE tc.session_id = ? ORDER BY pe.ts DESC LIMIT 20`,
  );
  const priorScan = db.prepare(`SELECT last_scan_at FROM repo_scan_state WHERE root_path = ?`);
  for (const receipt of receipts) {
    const lockChanged = receipt.changedArtifacts.some((c) => c.kind === 'lockfile');
    if (!lockChanged) continue;
    const newGrant = receipt.newArtifacts.find((a) => GRANT_KINDS.has(a.kind));
    if (!newGrant) continue;
    // prior-clean-pass gate: the root must have been scanned before, so
    // first_seen really is "first observed" relative to a clean earlier pass.
    const prev = (priorScan.get(receipt.rootPath) as { last_scan_at: number | null } | undefined)?.last_scan_at ?? null;
    if (prev === null) continue;
    // Install window: any package execution in a session whose project
    // resolves to this root, inside (prev, now].
    const sessions = db
      .prepare(`SELECT DISTINCT session_id FROM tool_calls WHERE ts > ? AND ts <= ?`)
      .all(prev, now) as { session_id: string | null }[];
    let installTs: number | null = null;
    for (const s of sessions) {
      if (!s.session_id) continue;
      const projects = sessionProject.all(s.session_id) as { project: string }[];
      if (!projects.some((p) => p.project === receipt.rootPath || p.project.startsWith(`${receipt.rootPath}/`))) continue;
      const row = installAt.get(s.session_id) as { ts: number | null } | undefined;
      if (row?.ts && row.ts > prev && row.ts <= now) {
        installTs = row.ts;
        break;
      }
    }
    if (installTs === null) continue;
    out.push({
      anomaly_key: `agent_config_with_dependency:${sha256hex(`${receipt.rootPath}|${newGrant.sha256}`)}`,
      rule: 'agent_config_with_dependency' as const,
      severity: 'warn' as const,
      tool: 'claude_code' as const,
      session_id: null,
      model: null,
      window_start: installTs,
      window_end: now,
      title: `Agent config first observed during a package install window`,
      detail:
        `A ${newGrant.relPath} was first observed in ${receipt.rootPath} around a package execution at ` +
        `${new Date(installTs).toISOString()}, and the root's lockfile sha changed in the same window — ` +
        `the Keyv-worm shape (first observed, never 'created': mtime is writer-controlled corroboration, not proof). ` +
        `Prior clean pass at ${new Date(prev).toISOString()}.`,
      observed: 1,
      baseline: null,
      threshold: null,
      confidence: 'exact' as const,
      source: 'live' as const,
      detected_at: now,
    });
  }
  return out;
}

// ── devcontainer / compose manifest reader (spec §64) ──────────────────────

export interface DevcontainerPosture {
  agentInstalled: boolean | null;
  homeMounted: boolean | null;
  bypassDeclared: boolean | null;
  evidence: { image?: string; features: string[]; mounts: string[]; postCreateCommand?: string; runArgs: string[] };
}

const AGENT_FEATURE = /claude|anthropic|copilot|codex|continue|aider|gemini|cline|roo/i;

export function readDevcontainer(text: string): DevcontainerPosture | null {
  const doc = parseJsonc<Record<string, unknown>>(text);
  if (!doc) return null;
  const features = Object.keys((doc.features as Record<string, unknown>) ?? {});
  const mounts = (Array.isArray(doc.mounts) ? doc.mounts : []).map(String);
  const runArgs = (Array.isArray(doc.runArgs) ? doc.runArgs : []).map(String);
  const postCreate = typeof doc.postCreateCommand === 'string' ? doc.postCreateCommand : Array.isArray(doc.postCreateCommand) ? doc.postCreateCommand.join(' ') : undefined;
  const image = typeof doc.image === 'string' ? doc.image : undefined;
  return {
    // null = the manifest declares nothing on this axis (three-state, never false-by-default)
    agentInstalled: features.length > 0 || image !== undefined ? features.some((f) => AGENT_FEATURE.test(f)) || (image ? AGENT_FEATURE.test(image) : false) : null,
    homeMounted: mounts.length > 0 ? mounts.some((m) => /\/root\/|\/home\/[a-z]|~\//i.test(m)) : null,
    bypassDeclared: postCreate !== undefined || runArgs.length > 0
      ? /curl|wget|sh -c|sudo|--privileged|--cap-add/i.test(`${postCreate ?? ''} ${runArgs.join(' ')}`)
      : null,
    evidence: { image, features, mounts, postCreateCommand: postCreate, runArgs },
  };
}

export interface ComposePosture {
  images: string[];
  volumes: string[];
  commands: string[];
}

export function readCompose(text: string): ComposePosture {
  const images: string[] = [];
  const volumes: string[] = [];
  const commands: string[] = [];
  let inVolumes = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (/^volumes:\s*$/.test(line)) {
      inVolumes = true;
      continue;
    }
    if (inVolumes && line && !/^-\s+/.test(line)) inVolumes = false;
    if (inVolumes && /^-\s+/.test(line)) {
      volumes.push(line.replace(/^-\s+/, ''));
      continue;
    }
    const img = /^\s*image:\s*(.+)$/.exec(raw);
    if (img) images.push(img[1]!.trim());
    const cmd = /^\s*command:\s*(.+)$/.exec(raw);
    if (cmd) commands.push(cmd[1]!.trim());
  }
  return { images, volumes, commands };
}

/**
 * Store devcontainer/compose posture as three-state lever rows (observed
 * beside hardened, the vendor-lever-card idiom). Uses posture_levers because
 * no dedicated contexts table exists — flagged in integrationNeeds.
 */
export function writeContextLevers(db: DB, rootPath: string, relPath: string, now: number, posture: DevcontainerPosture): void {
  const upsert = db.prepare(
    `INSERT INTO posture_levers (agent, lever, observed_value, hardened_value, source_file, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent, lever, source_file) DO UPDATE SET observed_value = excluded.observed_value, last_seen = excluded.last_seen`,
  );
  const file = join(rootPath, relPath);
  const chips: [string, boolean | null, string][] = [
    ['agent_installed', posture.agentInstalled, 'false'],
    ['home_mounted', posture.homeMounted, 'false'],
    ['bypass_declared', posture.bypassDeclared, 'false'],
  ];
  for (const [lever, observed, hardened] of chips) {
    upsert.run('devcontainer', lever, observed === null ? null : String(observed), hardened, file, now, now);
  }
}

// ── agent reach: ~/.ssh/config + known_hosts (spec §59) ─────────────────────

export interface SshHostPolicy {
  host: string;
  identityFile: string | null;
  identityClass: string | null; // ssh_private_key path-class when the file names a key
  forwardAgent: string | null;
  strictHostKeyChecking: string | null;
  proxyJump: string | null;
}

const SSH_CONFIG = () => process.env.VOLE_SSH_CONFIG ?? join(homedir(), '.ssh', 'config');
const KNOWN_HOSTS = () => process.env.VOLE_SSH_KNOWN_HOSTS ?? join(homedir(), '.ssh', 'known_hosts');

export function parseSshConfig(text: string, depth = 0, readFile: (p: string) => string | null = readTextOrNull): SshHostPolicy[] {
  const out: SshHostPolicy[] = [];
  // "Host prod web" is one block applying to several aliases: every setting
  // lands on each alias, and the Reach row per context stays exact.
  let block: SshHostPolicy[] = [];
  const apply = (fn: (h: SshHostPolicy) => void): void => {
    for (const h of block) fn(h);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const host = /^Host\s+(.+)$/i.exec(line);
    if (host) {
      out.push(...block);
      const aliases = host[1]!.trim().split(/\s+/).filter((a) => a !== '*');
      block = aliases.map((a) => ({ host: a, identityFile: null, identityClass: null, forwardAgent: null, strictHostKeyChecking: null, proxyJump: null }));
      continue;
    }
    if (block.length === 0) continue;
    const kv = /^([A-Za-z]+)\s+(.+)$/.exec(line);
    if (!kv) continue;
    const [, keyRaw, value] = kv;
    const key = keyRaw!.toLowerCase();
    if (key === 'host') continue;
    if (key === 'identityfile') {
      const idFile = value!.trim();
      const idClass = /id_rsa|id_ed25519|id_ecdsa|\.pem|identity$/i.test(idFile) ? 'ssh_private_key' : 'other_key_file';
      apply((h) => {
        h.identityFile = idFile;
        h.identityClass = idClass;
      });
    } else if (key === 'forwardagent') apply((h) => (h.forwardAgent = value!.trim().toLowerCase()));
    else if (key === 'stricthostkeychecking') apply((h) => (h.strictHostKeyChecking = value!.trim().toLowerCase()));
    else if (key === 'proxyjump') apply((h) => (h.proxyJump = value!.trim()));
    else if (key === 'include' && depth < 5) {
      // ponytail: Include is followed with a depth cap of 5; no glob expansion.
      const inc = readFile(value!.trim().replace(/^~/, homedir()));
      if (inc) out.push(...parseSshConfig(inc, depth + 1, readFile));
    }
  }
  out.push(...block);
  return out;
}

function readTextOrNull(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export interface AgentReach {
  hosts: SshHostPolicy[];
  knownHostsLines: number | null;
  /** -A / -i / -o StrictHostKeyChecking argument shapes from command text */
  flaggedCommandShapes: { shape: string; identityPathClass: string | null }[];
}

/** Extract ssh reach arguments from a command string (the collector's command-shape pass feeds this). */
export function sshReachFromCommand(command: string): { shape: string; identityPathClass: string | null }[] {
  const out: { shape: string; identityPathClass: string | null }[] = [];
  if (/\bssh\b[^|;&]*\s-A\b/.test(command)) out.push({ shape: 'ssh -A (agent forwarding)', identityPathClass: null });
  const id = /(?:^|\s)-i\s+(\S+)/.exec(command);
  if (id) {
    out.push({
      shape: 'ssh -i <path>',
      // An -i argument proves what was typed, not that the key existed or was
      // used (spec §59 limit) — Vole never opens the key file.
      identityPathClass: /id_rsa|id_ed25519|\.pem|identity$/i.test(id[1]!) ? 'ssh_private_key' : 'other_key_file',
    });
  }
  const sho = /-o\s+StrictHostKeyChecking=(\S+)/.exec(command);
  if (sho) out.push({ shape: `ssh -o StrictHostKeyChecking=${sho[1]}`, identityPathClass: null });
  return out;
}

/** Read the reach evidence from disk (local reads only, no network). */
export function readAgentReach(): AgentReach {
  const cfg = readTextOrNull(SSH_CONFIG());
  const kh = readTextOrNull(KNOWN_HOSTS());
  return {
    hosts: cfg ? parseSshConfig(cfg) : [],
    knownHostsLines: kh ? kh.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length : null,
    flaggedCommandShapes: [],
  };
}

/** Store reach as observed-versus-hardened lever rows (the Reach row per host). */
export function writeAgentReach(db: DB, now: number, reach: AgentReach): void {
  const upsert = db.prepare(
    `INSERT INTO posture_levers (agent, lever, observed_value, hardened_value, source_file, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent, lever, source_file) DO UPDATE SET observed_value = excluded.observed_value, last_seen = excluded.last_seen`,
  );
  const file = SSH_CONFIG();
  for (const h of reach.hosts) {
    upsert.run('ssh', `reach:${h.host}`, JSON.stringify({ identity_class: h.identityClass, forward_agent: h.forwardAgent, strict_host_key_checking: h.strictHostKeyChecking, proxy_jump: h.proxyJump }),
      JSON.stringify({ forward_agent: 'no', strict_host_key_checking: 'yes' }), file, now, now);
  }
  if (reach.knownHostsLines !== null) {
    upsert.run('ssh', 'known_hosts_lines', String(reach.knownHostsLines), null, KNOWN_HOSTS(), now, now);
  }
  for (const f of reach.flaggedCommandShapes) {
    upsert.run('ssh', 'command_shape', JSON.stringify(f), null, 'command_shape_pass', now, now);
  }
}

// ── IDE agent posture from editor settings backups (spec §65, §66) ─────────

export const IDE_LEVERS: { key: string; hardened: string }[] = [
  { key: 'claudeCode.allowDangerouslySkipPermissions', hardened: 'false' },
  { key: 'chat.agent.maxRequests', hardened: '<= 50' },
  { key: 'chat.agent.sandbox.enabled', hardened: 'on' },
];

export const VSCODE_USER_SETTINGS = () =>
  process.env.VOLE_VSCODE_USER_DIR ?? join(homedir(), 'Library', 'Application Support', 'Code', 'User');
export const VSCODE_SYNC_SETTINGS_DIR = () => join(VSCODE_USER_SETTINGS(), 'sync', 'settings');

/** Observed lever values from one settings.json text. */
export function idePostureFromSettings(text: string): Record<string, unknown> {
  const doc = parseJsonc<Record<string, unknown>>(text);
  if (!doc) return {};
  const out: Record<string, unknown> = {};
  for (const lever of IDE_LEVERS) {
    // VS Code settings keys are FLAT strings that happen to contain dots —
    // look the whole key up first, fall back to a nested traversal.
    let v: unknown = doc[lever.key];
    if (v === undefined) {
      const parts = lever.key.split('.');
      let cur: unknown = doc;
      for (const p of parts) cur = (cur as Record<string, unknown> | undefined)?.[p];
      v = cur;
    }
    if (v !== undefined) out[lever.key] = v;
  }
  return out;
}

export interface IdeLane {
  sourceFile: string;
  /** UTC timestamp from the filename (Settings Sync lanes), null for live settings.json */
  capturedAt: number | null;
  observed: Record<string, unknown>;
}

/**
 * Discover the IDE posture lanes: the live user settings plus every dated
 * Settings Sync backup (~/Library/Application Support/Code/User/sync/settings/
 * <YYYYMMDDTHHMMSS>.json). The timestamp is IN THE FILENAME — deterministic,
 * no now(). Absent sync dir (Cursor/Kiro/Antigravity have none) degrades to
 * 'history unavailable, snapshot only'.
 */
export function discoverIdeLanes(): IdeLane[] {
  const lanes: IdeLane[] = [];
  const live = join(VSCODE_USER_SETTINGS(), 'settings.json');
  const text = readTextOrNull(live);
  if (text !== null) lanes.push({ sourceFile: live, capturedAt: null, observed: idePostureFromSettings(text) });
  try {
    const files = readdirSync(VSCODE_SYNC_SETTINGS_DIR()).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const m = /^(\d{8}T\d{6})/.exec(f);
      const t = readTextOrNull(join(VSCODE_SYNC_SETTINGS_DIR(), f));
      if (!t) continue;
      const stamp = m ? Date.parse(`${m[1]!.slice(0, 4)}-${m[1]!.slice(4, 6)}-${m[1]!.slice(6, 8)}T${m[1]!.slice(9, 11)}:${m[1]!.slice(11, 13)}:${m[1]!.slice(13, 15)}Z`) : NaN;
      lanes.push({
        sourceFile: join(VSCODE_SYNC_SETTINGS_DIR(), f),
        capturedAt: Number.isFinite(stamp) ? stamp : null,
        observed: idePostureFromSettings(t),
      });
    }
  } catch {
    /* no sync dir: forward-only polling */
  }
  return lanes;
}

/** Store the lanes as lever rows keyed by source file — the dated history. */
export function writeIdePostureLanes(db: DB, now: number, lanes: IdeLane[]): void {
  const upsert = db.prepare(
    `INSERT INTO posture_levers (agent, lever, observed_value, hardened_value, source_file, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent, lever, source_file) DO UPDATE SET observed_value = excluded.observed_value, last_seen = excluded.last_seen`,
  );
  for (const lane of lanes) {
    for (const lever of IDE_LEVERS) {
      if (!(lever.key in lane.observed)) continue;
      const first = lane.capturedAt ?? now;
      upsert.run('vscode', lever.key, JSON.stringify(lane.observed[lever.key]), lever.hardened, lane.sourceFile, first, now);
    }
  }
}

// ── retroactive config history from rotating backups (spec §60) ─────────────

export interface ConfigBackup {
  file: string;
  /** parsed from the filename (epoch-ms or ISO), null when not encoded */
  capturedAt: number | null;
  text: string;
}

const CLAUDE_BACKUP_DIR = () => process.env.VOLE_CLAUDE_BACKUPS ?? join(homedir(), '.claude', 'backups');

/**
 * Discover the agents' own rotating config backups:
 * ~/.claude/backups/.claude.json.backup.<epoch_ms> and
 * ~/.claude/settings.json.{bak-pre-ccr,ccr-original,ccr-backup-<iso>,reset-backup-<iso>}.
 */
export function discoverConfigBackups(): ConfigBackup[] {
  const out: ConfigBackup[] = [];
  const push = (file: string, capturedAt: number | null) => {
    const text = readTextOrNull(file);
    if (text !== null) out.push({ file, capturedAt, text });
  };
  try {
    for (const f of readdirSync(CLAUDE_BACKUP_DIR())) {
      const m = /^\.claude\.json\.backup\.(\d{13,})$/.exec(f);
      if (m) push(join(CLAUDE_BACKUP_DIR(), f), Number(m[1]));
    }
  } catch {
    /* absent */
  }
  const settings = join(homedir(), '.claude', 'settings.json');
  for (const suffix of ['bak-pre-ccr', 'ccr-original']) {
    push(`${settings}.${suffix}`, null);
  }
  try {
    for (const f of readdirSync(join(homedir(), '.claude'))) {
      const m = /^(?:ccr-backup|reset-backup)-(.+)$/.exec(f);
      if (m) {
        const iso = m[1]!.replace(/\.json$/, '').replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-?(\d{2})-?(\d{2})/, '$1T$2:$3:$4');
        const t = Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
        push(join(homedir(), '.claude', f), Number.isFinite(t) ? t : null);
      }
    }
  } catch {
    /* absent */
  }
  return out.sort((a, b) => (a.capturedAt ?? 0) - (b.capturedAt ?? 0));
}

export interface ConfigHistoryEntry {
  file: string;
  capturedAt: number | null;
  sha256: string;
  /** changed field PATHS only — never values (the backup can hold OAuth tokens) */
  changedPaths: string[];
}

/**
 * Replay the rotating backups into a diff timeline (scope_history). The
 * history is bounded by the rotation window and is labelled 'earliest
 * recovered state', never 'first ever state'; a third-party backup (ccr)
 * carries that tool's clock, not the agent's.
 */
export function replayConfigHistory(db: DB, backups: ConfigBackup[]): ConfigHistoryEntry[] {
  const insert = db.prepare(`INSERT INTO scope_history (captured_at, sha256, diff, source) VALUES (?, ?, ?, ?)`);
  const out: ConfigHistoryEntry[] = [];
  let prev: { doc: unknown; entry: ConfigHistoryEntry } | null = null;
  for (const b of backups) {
    let doc: unknown = null;
    try {
      doc = JSON.parse(b.text);
    } catch {
      doc = null;
    }
    const entry: ConfigHistoryEntry = {
      file: b.file,
      capturedAt: b.capturedAt,
      sha256: sha256hex(b.text),
      changedPaths: prev ? (doc !== null && prev.doc !== null ? structDiffPaths(prev.doc, doc) : ['(unparseable predecessor or successor)']) : ['(earliest recovered state — history is bounded by the rotation window)'],
    };
    insert.run(b.capturedAt ?? 0, entry.sha256, JSON.stringify(entry.changedPaths), b.file);
    out.push(entry);
    if (doc !== null) prev = { doc, entry };
  }
  return out;
}

function structDiffPaths(a: unknown, b: unknown): string[] {
  // Paths only, values never quoted (the backup can hold OAuth tokens).
  return structDiff(a, b);
}

// re-export for the artifact ledger consumers
export { originSlug };

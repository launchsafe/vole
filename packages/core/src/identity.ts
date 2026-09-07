import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { DB } from './db';

/**
 * The identity seam (Tier 3 core): pseudonymous principals, stable device ids,
 * and the account-class classifier — the part of the roadmap that makes every
 * later figure attributable to a person without ever storing the person.
 *
 * The pseudonym is an HMAC under a Keychain-held key (the same discipline as the
 * DLP fingerprints): the username never enters the store, and the label is a
 * short non-identifying string. The device id is the IOPlatformUUID, HMAC'd
 * identically.
 */

let cachedKey: string | null = null;
function identityKey(): string {
  if (cachedKey) return cachedKey;
  const r = (() => {
    try {
      return execFileSync('security', ['find-generic-password', '-s', 'vole-dlp-fingerprint', '-a', 'epoch-0', '-w'],
        { encoding: 'utf8', timeout: 4000 }).trim();
    } catch {
      return null;
    }
  })();
  // Fallback: derive from the machine UUID — stable, never leaves the device.
  cachedKey = r || ioregUUID().slice(0, 32) || 'vole-identity-fallback';
  return cachedKey;
}

function ioregUUID(): string {
  try {
    return execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'],
      { encoding: 'utf8', timeout: 4000 }).match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? '';
  } catch {
    return '';
  }
}

export function principalKey(username: string): string {
  return `p:${createHmac('sha256', identityKey()).update(username).digest('hex').slice(0, 16)}`;
}

export function deviceKey(): string {
  return `d:${createHmac('sha256', identityKey()).update(ioregUUID()).digest('hex').slice(0, 16)}`;
}

/** The label: identifying enough to distinguish, never an email or a name. */
export function principalLabel(username: string): string {
  return `user-${principalKey(username).slice(2, 8)}`;
}

/** Account class from the auth path — the model prefix carries the evidence. */
export function classifyAccount(model: string | null): 'org_oauth' | 'personal' | 'raw_key' | 'router' | 'unknown' {
  if (!model) return 'unknown';
  if (model.startsWith('github-copilot/')) return 'org_oauth';
  if (model.startsWith('anthropic/')) return 'router';
  if (model.startsWith('openrouter/')) return 'router';
  if (model.startsWith('ollama/')) return 'raw_key'; // local model — no account at all
  // anthropic models via a CCR-hex alias → a local router
  if (/ccr-h[0-9a-f]{16,}/.test(model)) return 'router';
  return 'unknown';
}

/** Upserts the current principal + device — called once per collect pass. */
export function recordIdentity(db: DB, username: string): void {
  const now = Date.now();
  const pk = principalKey(username);
  db.prepare(`
    INSERT INTO principals (principal_key, display, first_seen, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(principal_key) DO UPDATE SET last_seen = excluded.last_seen`)
    .run(pk, principalLabel(username), now, now);
  db.prepare(`
    INSERT INTO devices (device_key, hostname, first_seen, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_key) DO UPDATE SET last_seen = excluded.last_seen, hostname = excluded.hostname`)
    .run(deviceKey(), hostname(), now, now);
}

/**
 * The grants sweep (Tier 6 core): every permission declaration in every agent's
 * own config — the file that granted the authority, quoted verbatim.
 */
export function sweepGrants(db: DB): number {
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO grants (grant_key, agent, source_file, kind, entry, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(grant_key) DO UPDATE SET last_seen = excluded.last_seen`);
  let n = 0;
  const home = homedir();

  const targets: { agent: string; file: string; kind: string }[] = [
    { agent: 'claude_code', file: join(home, '.claude', 'settings.json'), kind: 'allow' },
    { agent: 'claude_code', file: join(home, '.claude', 'settings.local.json'), kind: 'allow' },
    { agent: 'codex', file: join(home, '.codex', 'config.toml'), kind: 'allow' },
  ];
  for (const t of targets) {
    if (!existsSync(t.file)) continue;
    try {
      const text = readFileSync(t.file, 'utf8');
      // JSON settings: the permissions.allow array, verbatim entries.
      if (t.file.endsWith('.json')) {
        const cfg = JSON.parse(text) as { permissions?: { allow?: string[]; deny?: string[] }; hooks?: Record<string, unknown> };
        for (const entry of cfg.permissions?.allow ?? []) {
          upsert.run(`grant:${t.agent}:${t.file}:${entry}`, t.agent, t.file, 'allow', entry, now, now);
          n++;
        }
        for (const entry of cfg.permissions?.deny ?? []) {
          upsert.run(`grant:${t.agent}:${t.file}:deny:${entry}`, t.agent, t.file, 'deny', entry, now, now);
          n++;
        }
        for (const [event, hook] of Object.entries(cfg.hooks ?? {})) {
          upsert.run(`hook:${t.agent}:${t.file}:${event}`, t.agent, t.file, 'hook', `${event}: ${JSON.stringify(hook).slice(0, 120)}`, now, now);
          n++;
        }
      } else {
        // TOML: whole-file as the declared posture, chunked by section.
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('[') || trimmed.startsWith('#') || !trimmed) continue;
          upsert.run(`grant:${t.agent}:${t.file}:${trimmed.slice(0, 60)}`, t.agent, t.file, 'allow', trimmed.slice(0, 120), now, now);
          n++;
        }
      }
    } catch {
      /* unreadable config: skip */
    }
  }

  // MCP registrations from ~/.claude.json — servers keyed verbatim.
  const claudeJson = join(home, '.claude.json');
  if (existsSync(claudeJson)) {
    try {
      const cfg = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
        mcpServers?: Record<string, { command?: string; url?: string }>;
      };
      for (const [name, srv] of Object.entries(cfg.mcpServers ?? {})) {
        const entry = `${name} → ${srv.command ?? srv.url ?? '?'}`;
        upsert.run(`mcp:claude_code:${claudeJson}:${name}`, 'claude_code', claudeJson, 'mcp', entry, now, now);
        n++;
      }
    } catch {
      /* malformed */
    }
  }
  return n;
}

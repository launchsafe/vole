import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, paths } from '../../paths';

/**
 * agent_self_authorised's watched keys: the only permission-surface changes worth
 * a critical. A config file changing is nothing; a permission-GRANTING key
 * changing is the whole signal. Facts are key names and value CLASSES only — a
 * boolean, an entry count, 'present' — never a value, an entry or a secret.
 */

export interface WatchedKeyFact {
  key: string;
  /** Value CLASS ('true'/'false'/'n entries'/'present'), never the value. */
  value_class: string;
  /** True when this key, in this state, grants authority. */
  grant: boolean;
}

export interface WatchedKeyChange {
  key: string;
  from: string;
  to: string;
  grant: boolean;
  /** Session id of a tool call that touched the file near the change, else null. */
  session_id: string | null;
}

const JSON_GRANT_KEYS: Record<string, (v: unknown) => WatchedKeyFact | null> = {
  hasTrustDialogAccepted: (v) => ({ key: 'hasTrustDialogAccepted', value_class: String(v === true), grant: v === true }),
  enableAllProjectMcpServers: (v) => ({ key: 'enableAllProjectMcpServers', value_class: String(v === true), grant: v === true }),
  skipDangerousModePermissionPrompt: (v) => ({ key: 'skipDangerousModePermissionPrompt', value_class: String(v === true), grant: v === true }),
};

function walkJson(node: unknown, out: WatchedKeyFact[], prefix = ''): void {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const maker = JSON_GRANT_KEYS[k];
    if (maker && (v === true || v === false)) {
      const f = maker(v);
      if (f) out.push(f);
    } else if (path === 'permissions.allow' && Array.isArray(v)) {
      out.push({ key: 'permissions.allow', value_class: `${v.length} entries`, grant: v.length > 0 });
    } else if (k === 'hooks' && v && typeof v === 'object') {
      out.push({ key: 'hooks', value_class: `${Object.keys(v as object).length} events`, grant: Object.keys(v as object).length > 0 });
    } else if (k === 'permissions' && v && typeof v === 'object') {
      walkJson(v, out, path);
    } else if (k === 'projects' && v && typeof v === 'object') {
      // ~/.claude.json's per-project blocks also carry allowedTools/mcpServers.
      for (const proj of Object.values(v as Record<string, unknown>)) walkJson(proj, out, 'projects');
    } else if (v && typeof v === 'object') {
      walkJson(v, out, path);
    }
  }
}

/** Watched keys in a TOML body (Codex config.toml, Grok config.toml). */
export function tomlFacts(text: string): WatchedKeyFact[] {
  const out: WatchedKeyFact[] = [];
  const section = (line: string) => /^\s*\[(.+)\]\s*$/.exec(line)?.[1] ?? '';
  let cur = '';
  for (const line of text.split('\n')) {
    const s = section(line);
    if (s) {
      cur = s;
      continue;
    }
    const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const raw = m[2]!;
    const value = raw.replace(/^["']|["']$/g, '');
    const full = cur ? `${cur}.${key}` : key;
    if (full === 'ui.yolo' || full === 'yolo') out.push({ key: 'ui.yolo', value_class: String(value === 'true'), grant: value === 'true' });
    if (/(^|\.)permission_mode$/.test(full)) out.push({ key: 'permission_mode', value_class: value || 'unset', grant: /^(auto|bypass|yolo)/i.test(value) });
    if (/(^|\.)approval_policy$/.test(full)) out.push({ key: 'approval_policy', value_class: value || 'unset', grant: value === 'never' });
  }
  return out;
}

/** Watched-key facts from any watched file body (JSON or TOML, by extension). */
export function watchedKeyFacts(text: string, isToml: boolean): WatchedKeyFact[] {
  if (isToml) return tomlFacts(text);
  try {
    const out: WatchedKeyFact[] = [];
    walkJson(JSON.parse(text), out);
    return out;
  } catch {
    return [];
  }
}

/** The transitions between two fact sets — key names and value classes only. */
export function diffWatchedKeys(prev: WatchedKeyFact[], cur: WatchedKeyFact[]): Omit<WatchedKeyChange, 'session_id'>[] {
  const prevMap = new Map(prev.map((f) => [f.key, f]));
  const out: Omit<WatchedKeyChange, 'session_id'>[] = [];
  for (const f of cur) {
    const before = prevMap.get(f.key);
    if (before && before.value_class === f.value_class) continue;
    out.push({ key: f.key, from: before?.value_class ?? 'unset', to: f.value_class, grant: f.grant && (!before || !before.grant) });
  }
  return out;
}

/** The files whose watched-key changes fire agent_self_authorised. */
export function watchedConfigPaths(): Array<{ path: string; toml: boolean }> {
  return [
    { path: join(paths.claudeConfigDir(), 'settings.json'), toml: false },
    { path: join(paths.claudeConfigDir(), 'settings.local.json'), toml: false },
    { path: join(home(), '.claude.json'), toml: false },
    { path: join(paths.codexHome(), 'config.toml'), toml: true },
    { path: join(home(), '.grok', 'config.toml'), toml: true },
  ];
}

export function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

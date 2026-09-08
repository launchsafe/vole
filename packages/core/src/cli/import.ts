/**
 * Tier 8: `vole import --context` — rows from a container arrive as rows,
 * never as estimates. The devcontainer feature installs the collector
 * inside the image and points it at a spool directory the container already
 * mounts, so a devcontainer run writes
 * ~/.vole/contexts/<context_id>/events-*.ndjson in the normalised UsageEvent
 * shape with its own declared context and origin. This import is the
 * receiving end: dry-run preview by default, --apply to write, and the
 * spool's own declared source is honoured verbatim — the seed/live firewall
 * holds on the import side too (a spool row declaring source='seed' is
 * imported as seed, and never as live).
 *
 *   vole import --context            list discovered spool dirs with row counts
 *   vole import --context --apply    import every context's rows
 *   vole import --emit-devcontainer --out <dir>   write the feature + doc
 *
 * This only helps images the organisation actually rebuilds and mounts a
 * spool into — a container already running, a Codespace, a CI runner nobody
 * controls, and every SSH remote get nothing; for SSH remotes the honest
 * answer is 'install Vole there too'. Vole still never exec's into a running
 * container.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../paths';
import { openDb, insertEvents } from '../db';
import type { UsageEvent } from '../types';

const args = process.argv.slice(2);

// ── the devcontainer feature + the coverage topology doc ────────────────────

const FEATURE_JSON = `{
  "name": "vole-collector",
  "id": "vole-collector",
  "version": "0.1.0",
  "description": "Installs the Vole collector and points it at a spool directory the container already mounts, so agent activity inside the image arrives as rows, never as estimates.",
  "options": {
    "spoolDir": { "type": "string", "default": "/workspaces/.vole-spool", "description": "The mounted spool directory the collector writes normalised UsageEvent ndjson into." }
  }
}`;

const INSTALL_SH = `#!/bin/sh
# Vole devcontainer feature: install the collector into the image, pointed at
# the spool the container already mounts. The collector runs INSIDE this
# container and writes ~/.vole/contexts/<context_id>/events-*.ndjson; the host
# imports them with 'vole import --context'. Nothing phones home: the spool is
# the only egress, and it is a mounted directory.
set -e
SPOOL="\${SPOOL_DIR:-/workspaces/.vole-spool}"
npm install -g @vole/collector 2>/dev/null || echo "vole-collector package not published yet — vendor the binary into the image instead"
mkdir -p "$SPOOL"
mkdir -p /usr/local/share/vole
printf 'spool=%s\\n' "$SPOOL" > /usr/local/share/vole/feature.env
echo "Vole collector feature installed. Import on the host with: vole import --context"
`;

const TOPOLOGY_DOC = `# Coverage topology

Which contexts Vole reads, and which it counts-but-cannot-read.

## Read directly (a collector exists)

Claude Code, Codex, Cursor, Antigravity, OpenCode, Grok, Devin, Gemini, Copilot
CLI, Goose, Amp, Continue, Aider, VS Code chat, Cline/Roo/Kilo — each through
that tool's own local store, under the consented roots the Privacy Center
lists with a path receipt.

## Counted but not read

- Containers the organisation rebuilds with this feature: the collector runs
  INSIDE the image and spools normalised rows to a mounted directory; the host
  imports them with \`vole import --context\`. Topology state: "imported N rows
  at <time>".
- A spool present but not imported: counted as "spool present, not imported".

## Not covered — and never claimed as zero

- A container already running, a Codespace, a CI runner nobody controls: no
  feature was installed, nothing is counted. For SSH remotes the honest answer
  is "install Vole there too"; Vole never exec's into a running container.
- Browser chat, phone, personal laptop, and any tool with no collector:
  absent by construction, rendered as absent — never as zero.

The meter (\`vole hosts\`) is a floor and never an inventory: a host that never
runs the collector is never counted. Reconcile against the MDM device list.
`;

if (args.includes('--emit-devcontainer')) {
  const out = flagOut();
  mkdirSync(join(out, 'vole-collector'), { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'vole-collector', 'devcontainer-feature.json'), FEATURE_JSON);
  writeFileSync(join(out, 'vole-collector', 'install.sh'), INSTALL_SH);
  writeFileSync(join(out, 'COVERAGE-TOPOLOGY.md'), TOPOLOGY_DOC);
  console.log(`Wrote ${join(out, 'vole-collector')} (feature) and ${join(out, 'COVERAGE-TOPOLOGY.md')}.`);
  console.log('Publish the feature directory to your devcontainer features source; ship the doc at repo root.');
  process.exit(0);
}

function flagOut(): string {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? args[i + 1]! : '.';
}

// ── discovery + import ─────────────────────────────────────────────────────

interface ContextRow {
  context_id: string;
  files: number;
  events: number;
  first_ts: number | null;
  last_ts: number | null;
  sources: Set<string>;
  invalid_lines: number;
}

function readContext(dir: string): ContextRow {
  const files = readdirSync(dir).filter((f) => f.startsWith('events-') && f.endsWith('.ndjson')).sort();
  const row: ContextRow = {
    context_id: dir.split('/').pop()!,
    files: files.length,
    events: 0,
    first_ts: null,
    last_ts: null,
    sources: new Set(),
    invalid_lines: 0,
  };
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        row.invalid_lines++;
        continue;
      }
      if (typeof parsed.event_key !== 'string' || typeof parsed.ts !== 'number' || typeof parsed.tool !== 'string') {
        row.invalid_lines++;
        continue;
      }
      row.events++;
      row.first_ts = row.first_ts === null ? parsed.ts : Math.min(row.first_ts, parsed.ts);
      row.last_ts = row.last_ts === null ? parsed.ts : Math.max(row.last_ts, parsed.ts);
      row.sources.add(String(parsed.source ?? 'live'));
    }
  }
  return row;
}

const contextsRoot = join(home(), '.vole', 'contexts');
const contexts: { dir: string; row: ContextRow }[] = [];
if (existsSync(contextsRoot)) {
  for (const ctx of readdirSync(contextsRoot)) {
    const dir = join(contextsRoot, ctx);
    try {
      if (statSync(dir).isDirectory()) contexts.push({ dir, row: readContext(dir) });
    } catch {
      /* unreadable context: skip, a permission fact */
    }
  }
}

console.log('Vole context import (devcontainer spools)');
console.log('──────────────────────────────────────────');
if (contexts.length === 0) {
  console.log(`  no spool directories under ${contextsRoot}`);
  console.log('  Emit the devcontainer feature with: vole import --emit-devcontainer --out <dir>');
  process.exit(0);
}

for (const { row } of contexts) {
  console.log(
    `  ${row.context_id.padEnd(24)} files=${row.files}  events=${String(row.events).padStart(6)}` +
    `  first=${row.first_ts === null ? '—' : new Date(row.first_ts).toISOString()}` +
    `  source=${[...row.sources].join('|') || '—'}  invalid=${row.invalid_lines}` +
    `  state=${row.events > 0 ? 'spool present' : 'empty'}`,
  );
}

if (!args.includes('--apply')) {
  console.log('\n  dry run — pass --apply to import (idempotent on event_key).');
  process.exit(0);
}

const db = openDb();
let total = 0;
for (const { dir, row } of contexts) {
  const ctxId = row.context_id;
  let inserted = 0;
  const consumed: string[] = [];
  const files = readdirSync(dir).filter((x) => x.startsWith('events-') && x.endsWith('.ndjson')).sort();
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const { execution_context_id, subject_id, ...event } = parsed as Record<string, unknown> & UsageEvent;
      inserted += insertEvents(db, [event as UsageEvent]);
      // NULL-only widening of the declared context/origin — a stored fact is
      // never overwritten with a re-derived one.
      if (typeof execution_context_id === 'string' || typeof subject_id === 'string') {
        db.prepare(
          `UPDATE usage_events SET
             execution_context_id = COALESCE(execution_context_id, ?),
             subject_id = COALESCE(subject_id, ?)
           WHERE event_key = ?`,
        ).run(execution_context_id ?? null, subject_id ?? null, event.event_key);
      }
    }
    consumed.push(f);
  }
  // Imported = mark the spool consumed, never delete it: the store is
  // rebuildable only while its sources exist (the retention gate depends on it).
  for (const f of consumed) {
    try {
      const to = join(dir, `${f}.imported`);
      if (!existsSync(to)) writeFileSync(to, readFileSync(join(dir, f)));
      rmSync(join(dir, f));
    } catch {
      /* rename failed: the event_key upsert makes a re-import idempotent */
    }
  }
  total += inserted;
  console.log(`  imported ${inserted} row(s) from ${ctxId} (spool marked .imported, kept for rebuildability)`);
}
console.log(`\nImported ${total} row(s).`);
console.log('The container declared its own context and origin; nothing was estimated.');

process.exit(0);

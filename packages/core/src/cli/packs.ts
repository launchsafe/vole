/**
 * `vole packs` — the admin CLI for the pack plane (tier 6 §79).
 *
 *   vole packs                          list packs: kind, version, built_at,
 *                                       age, ring, trust, load_state
 *   vole packs --preflight <file>       score a candidate pack against this
 *                                       machine's evidence (writes nothing)
 *   vole packs --baseline               capture ~/.vole/baseline.json
 *   vole packs --drift                  diff current posture against baseline
 *   vole packs --controls [rule]        rule provenance + control mappings
 *
 * Admin surface by design — no app screen for preflight. Offline only: the
 * only I/O is local files and the local store.
 */
import { openDb } from '../db';
import { registerPacks, activePack, readLoadState, builtinPacks } from '../packs';
import { preflightPack } from '../packs/preflight';
import { captureBaseline, driftDiff } from '../packs/baseline';
import { provenanceFor, controlsForRule, MAPPING_VERSION, incidentFrameworkChips } from '../packs/controls';

const args = process.argv.slice(2);

function usage(): never {
  console.log('usage: vole packs [--preflight <file> [--allow-unsigned] [--budget BYTES]] [--baseline] [--drift] [--controls [rule]]');
  process.exit(args.length === 0 ? 0 : 2);
}

function main(): void {
  const db = openDb();

  if (args[0] === '--preflight') {
    const file = args[1];
    if (!file) usage();
    const allowUnsigned = args.includes('--allow-unsigned');
    const budget = args.includes('--budget') ? parseInt(args[args.indexOf('--budget') + 1], 10) : undefined;
    const r = preflightPack(db, file, { allowUnsigned, budgetBytes: budget });
    if (r.refusal) {
      console.log(`REFUSED: ${r.refusal}`);
      process.exit(1);
    }
    console.log(`candidate ${r.kind} v${r.version} — ${r.verified ? 'signature verified' : 'UNSIGNED (--allow-unsigned)'}`);
    console.log(`sample: ${r.sample}`);
    if (r.dlp) {
      console.log(`retained evidence: ${r.dlp.files_scanned} file(s) scanned, ${r.dlp.bytes_read} bytes read, ${r.dlp.files_gone} gone`);
      console.log(`findings added: ${r.dlp.findings_added}  removed: ${r.dlp.findings_removed}`);
      for (const e of r.dlp.entries) console.log(`  entry ${e.id}: ${e.hits} hit(s)`);
    }
    if (r.pricing) {
      console.log(`rows gaining a rate: ${r.pricing.rows_gaining_rate}  losing: ${r.pricing.rows_losing_rate}`);
      console.log(`models added: ${r.pricing.models_added.join(', ') || '—'}  dropped: ${r.pricing.models_dropped.join(', ') || '—'}`);
    }
    if (r.command_patterns) {
      for (const e of r.command_patterns.entries) console.log(`  entry ${e.id}: ${e.hits} tool call(s)`);
    }
    if (r.assets) {
      for (const e of r.assets.entries) console.log(`  ${e.asset_id} (tier ${e.tier ?? '?'} ${e.kind} ${e.match}): ${e.rows_resolved} row(s)`);
      if (r.assets.dead.length) console.log(`dead entries (resolve zero rows): ${r.assets.dead.join(', ')}`);
      for (const c of r.assets.collisions) console.log(`collision on ${c.target}: ${c.winner} wins, ${c.loser} loses (chain order)`);
      for (const n of r.assets.near_match) console.log(`near-match: observed ${n.observed} vs declared ${n.declared} (single label)`);
      for (const i of r.assets.invalid) console.log(`rejected entry #${i.index}: ${i.reason}`);
      console.log(`severity delta: ${r.assets.severity_delta} stored action(s) would escalate one step`);
    }
    if (r.thresholds) {
      for (const t of r.thresholds.changed) {
        console.log(`  ${t.rule}.${t.param}: ${t.from} -> ${t.to} (${t.stored_anomalies} stored anomalies affected)`);
      }
    }
    console.log('worksheet, not a pass/fail gate — one laptop\'s evidence is not the fleet\'s');
    return;
  }

  if (args[0] === '--baseline') {
    const b = captureBaseline(db);
    console.log(`baseline captured ${new Date(b.captured_at).toISOString()} — ${b.items.length} item(s) into ~/.vole/baseline.json`);
    console.log('A baseline captured after a compromise blesses the compromise: the capture date travels with the file.');
    return;
  }

  if (args[0] === '--drift') {
    const d = driftDiff(db);
    if (d.baseline_captured_at === null) {
      console.log('no baseline captured — run `vole packs --baseline` first');
      return;
    }
    console.log(`baseline captured ${new Date(d.baseline_captured_at).toISOString()} — ${d.rows.length} change(s) since`);
    for (const r of d.rows) {
      console.log(`  ${r.state}  ${r.kind} ${r.identity}  ${r.before ?? '—'} -> ${r.after ?? '—'}`);
    }
    return;
  }

  if (args[0] === '--controls') {
    const rule = args[1];
    if (rule) {
      const p = provenanceFor(rule);
      if (!p) {
        console.log(`no provenance record for rule '${rule}'`);
        return;
      }
      console.log(`why this rule exists: ${p.incident_name} (${p.incident_date}, ${p.detectability})`);
      console.log(`  ${p.url}`);
      for (const c of controlsForRule(rule)) console.log(`  evidence toward ${c.framework} ${c.control_id} — ${c.control_title}`);
      return;
    }
    console.log(`controls mapping v${MAPPING_VERSION} — 'evidence toward', never 'compliant with'`);
    for (const row of incidentFrameworkChips(db)) {
      console.log(`  ${row.rule} (${row.n} incident(s)): ${row.controls.map((c) => `${c.framework} ${c.control_id}`).join(', ') || 'no mapping'}`);
    }
    return;
  }

  if (args.length > 0) usage();

  // Default: the pack inventory — the support call answered in one line.
  const sync = registerPacks(db);
  const builtinKinds = new Map(builtinPacks().map((b) => [b.kind, b]));
  console.log('kind              version  built_at        age   ring      trust           load_state');
  const seen = new Set<string>();
  for (const p of sync.packs) {
    seen.add(p.kind);
    const age = p.built_at ? `${Math.floor((Date.now() - p.built_at) / 86_400_000)}d` : '—';
    const built = p.built_at ? new Date(p.built_at).toISOString().slice(0, 10) : '—';
    console.log(
      `${p.kind.padEnd(18)}${String(p.version).padEnd(9)}${built.padEnd(16)}${age.padEnd(6)}${(p.ring ?? '—').padEnd(10)}${p.trust.padEnd(16)}${p.load_state}${p.reason ? ` (${p.reason})` : ''}`,
    );
  }
  for (const [kind, b] of builtinKinds) {
    if (!seen.has(kind)) {
      console.log(`${kind.padEnd(18)}${String(b.version).padEnd(9)}—               —     —         builtin_floor   builtin`);
    }
  }
  for (const l of readLoadState()) {
    console.log(`journal ${l.state}: ${l.path} (${l.sha256.slice(0, 8)}) — ${l.reason}`);
  }
  for (const k of ['dlp_detectors', 'pricing']) {
    const a = activePack(db, k);
    console.log(`active ${k}: v${a.version} (${a.trust})`);
  }
  db.close();
}

main();

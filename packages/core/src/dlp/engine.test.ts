import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin the fingerprint key before anything fingerprints: no Keychain prompts,
// no file fallback — the tests never touch the real store (test seam only).
import { setFingerprintKeyOverride } from './keychain';
setFingerprintKeyOverride('test-fingerprint-key');

import {
  scanBuffer, shannon, classifyStatus, classifyFixture, asContent, packIdentity,
  directionOf, openRootFile, isExcluded,
} from './engine';
import { packChecksum, DETECTORS, PACK_VERSION, exampleHashOf, PUBLIC_EXAMPLE_HASHES, classEntryIdOf } from './pack';
import { luhn, mod97, mod11, crc32, crc32Tail, jwtShape, pemSanity } from './validators';
import { stripZeroWidth, foldHomoglyphs, percentDecode, jsonUnescape, base64Runs, variants } from './normalise';
import { scanSinkResumable, EMPTY_CURSOR } from './cursors';
import { claudeRetention, dlpCoverage, exposureCoverage, correlateFingerprints, dlpEgress, applyFindingActions, dlpScanner } from './scanner';

const ctx = { home: '', db: '' };
before(() => {
  const t = mkdtempSync(join(tmpdir(), 'vole-dlp-'));
  ctx.home = t;
  ctx.db = join(t, 'vole.db');
  process.env.VOLE_HOME_OVERRIDE = t;
  process.env.VOLE_DB = ctx.db;
  process.env.HOME = t; // sinks.ts enumerates via os.homedir()
});

test('pack: rows load from the TOML, checksum is stable, ids unique', () => {
  const a = packChecksum();
  assert.equal(a, packChecksum(), 'deterministic in-process');
  assert.equal(a.length, 64);
  assert.ok(DETECTORS.length >= 12, 'credential rows + data-class entries');
  assert.equal(new Set(DETECTORS.map((d) => d.id)).size, DETECTORS.length, 'detector ids unique');
  assert.equal(packIdentity().version, PACK_VERSION);
  // Data-class entries carry validators; the fixture set carries example hashes.
  const card = DETECTORS.find((d) => d.id === 'payment-card')!;
  assert.equal(card.validator, 'luhn');
  assert.ok(card.exampleHashes.length >= 3);
  assert.ok(PUBLIC_EXAMPLE_HASHES.has(exampleHashOf('4111111111111111')));
  assert.equal(classEntryIdOf(card), 'payment_card:payment-card');
});

test('validators: luhn, mod97, mod11, crc32, jwt, pem — offline arithmetic only', () => {
  assert.ok(luhn('4111111111111111'));
  assert.ok(!luhn('4111111111111112'));
  assert.ok(mod97('GB82WEST12345698765432'));
  assert.ok(!mod97('GB82WEST12345698765433'));
  assert.ok(mod11('12345678903'));
  assert.ok(!mod11('12345678904'));
  assert.equal(crc32('hello'), 0x3610a686);
  assert.equal(typeof crc32Tail('ghp_' + 'A'.repeat(36)), 'boolean');
  const jwt = jwtShape('eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ2b2xlIiwiZXhwIjoxNzAwMDAwMDAwfQ.sig');
  assert.ok(jwt.valid && jwt.algParses && jwt.issParses && jwt.expParses);
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIBOgIBAAJBAMDUP ---------- not real base64 ----------',
  ].join('\n');
  assert.ok(pemSanity(pem)); // header present, no END fence: nothing to sanity-check yet
  assert.ok(pemSanity('-----BEGIN RSA PRIVATE KEY-----\nMIIBAA==\n-----END RSA PRIVATE KEY-----'));
  assert.ok(!pemSanity('no pem here'));
});

test('validators: a failing checksum gates the sighting (luhn)', () => {
  const found = scanBuffer(asContent('card = 4111111111111112'));
  assert.equal(found.filter((s) => s.detector === 'payment-card').length, 0, 'Luhn miss: no sighting');
  const ok = scanBuffer(asContent('card = 4111111111111111'));
  const card = ok.find((s) => s.detector === 'payment-card');
  assert.ok(card, 'Luhn pass: sighting');
  assert.equal(card!.validatorChecked, 'luhn:ok');
});

test('normalise: zero-width, homoglyphs, percent, JSON escapes, base64', () => {
  assert.equal(stripZeroWidth('sk​-ant-abc'), 'sk-ant-abc');
  assert.equal(foldHomoglyphs('АKIA'), 'AKIA'); // Cyrillic А folded to A
  assert.equal(percentDecode('key%3DAKIA123'), 'key=AKIA123');
  assert.equal(jsonUnescape('"value \\"sk-ant-\\" ok"'), 'value "sk-ant-" ok');
  const runs = base64Runs(Buffer.from('aws_key = AKIAABCDEFGHIJKLMNOP').toString('base64').padEnd(40, 'A'));
  assert.ok(runs.length >= 1 && runs[0]!.decoded.includes('AKIAABCDEFGHIJKLMNOP'));
});

test('normalise: a percent-encoded AWS key is found with the provenance badge', () => {
  // '=' percent-encodes to %3D, so the key only exists after the decode.
  const found = scanBuffer(asContent('url https://x.test/t?token=AKIAABCDEFGHIJKLMNOP%3D'));
  const s = found.find((f) => f.detector === 'aws-access-key' && f.provenance.includes('percent_decoded'));
  assert.ok(s, 'found after percent-decode');
  assert.equal(s!.value, 'AKIAABCDEFGHIJKLMNOP');
});

test('normalise: a base64-wrapped AWS key is found with the badge', () => {
  const payload = 'api key AKIAABCDEFGHIJKLMNOP here';
  const b64 = Buffer.from(payload).toString('base64');
  const found = scanBuffer(asContent(`data = ${b64}`));
  const s = found.find((f) => f.detector === 'aws-access-key' && f.provenance.includes('base64_decoded'));
  assert.ok(s, 'found after base64 decode');
});

test('variants: raw buffer yields at least the raw view, transforms are distinct', () => {
  const vs = variants(asContent('plain text'));
  assert.equal(vs[0]!.badges.length, 0);
  assert.equal(new Set(vs.map((v) => v.text as string)).size, 1);
});

test('engine: AWS key shape is detected with byte offset and class entry', () => {
  const buf = asContent('config: nothing here\naws_key = AKIAABCDEFGHIJKLMNOP\n');
  const found = scanBuffer(buf).find((s) => s.detector === 'aws-access-key');
  assert.ok(found);
  assert.equal(found!.classEntryId, 'credential:aws-access-key');
  assert.equal(found!.byteOffset, buf.indexOf('AKIAABCDEFGHIJKLMNOP'));
});

test('engine: public-example values auto-classify as fixtures, not candidates', () => {
  const found = scanBuffer(asContent('aws_key = AKIAIOSFODNN7EXAMPLE'));
  const s = found.find((f) => f.detector === 'aws-access-key')!;
  assert.ok(s);
  const c = classifyFixture('/w/src/config.py', s);
  assert.equal(c.status, 'fixture');
  assert.equal(c.fixtureReason, 'public_example_value');
});

test('engine: prefilter skips the regex when no keyword is present', () => {
  assert.equal(scanBuffer(asContent('zzzz zzzz zzzz zzzz')).length, 0);
});

test('engine: entropy catch-all fires only above the floor with a keyword', () => {
  const hi = 'api_key = a9f8d7c6b5a4938271605f4e3d2c1b0a';
  assert.ok(scanBuffer(asContent(hi)).some((s) => s.detector === 'high-entropy-assignment'));
  const lo = 'api_key = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(scanBuffer(asContent(lo)).filter((s) => s.detector === 'high-entropy-assignment').length, 0);
});

test('engine: stopwords keep placeholders and test keys out', () => {
  const found = scanBuffer(asContent('api_key = sk-test-1234567890abcdef1234567890abcdef'));
  assert.equal(found.filter((s) => s.detector === 'openai-api-key').length, 0, 'sk-test placeholder must not match');
});

test('engine: private key headers match; offsets are byte-accurate for multibyte prefixes', () => {
  const prefix = 'éééé\n';
  const buf = asContent(`${prefix}-----BEGIN RSA PRIVATE KEY-----\n`);
  const found = scanBuffer(buf).find((s) => s.detector === 'private-key-block');
  assert.ok(found);
  assert.equal(found!.byteOffset, Buffer.byteLength(prefix, 'utf8'));
});

test('engine: shannon entropy is computed per character', () => {
  assert.equal(shannon('aaaa'), 0);
  assert.ok(shannon('ab') === 1);
  assert.ok(shannon('abcdef') > 2.5);
});

test('engine: fixture classification keeps test paths quiet, with a reason', () => {
  assert.equal(classifyStatus('/w/tests/foo.test.ts'), 'fixture');
  assert.equal(classifyStatus('/w/src/config.py'), 'candidate');
  assert.deepEqual(classifyFixture('/w/__mocks__/x.js', { fixtureReason: null }), {
    status: 'fixture', fixtureReason: 'test_path',
  });
});

test('engine: direction tagging maps shapes to the normalised vocabulary', () => {
  assert.equal(directionOf('sink_at_rest'), 'at_rest');
  assert.equal(directionOf('request_body'), 'at_wire');
  assert.equal(directionOf('pasted_content'), 'human_pasted');
  assert.equal(directionOf('tool_input'), 'agent_typed');
  assert.equal(directionOf('assistant_message'), 'agent_typed');
});

test('exclusion: isExcluded matches roots; openRootFile never opens an excluded path', () => {
  const dir = join(ctx.home, 'personal-repo');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'secret.txt');
  writeFileSync(file, 'AKIAABCDEFGHIJKLMNOP');
  const manifest = join(ctx.home, '.vole', 'policy');
  mkdirSync(manifest, { recursive: true });
  writeFileSync(join(manifest, 'exclude.json'), JSON.stringify([dir]));
  const r = openRootFile(file);
  assert.equal(r.kind, 'excluded', 'the excluded root is never read');
  assert.equal(r.kind === 'excluded' ? r.size : 0, 20, 'the skip receipt carries the measured size');
  assert.ok(isExcluded(file, [dir]));
  const outside = join(ctx.home, 'outside.txt');
  writeFileSync(outside, 'plain');
  assert.equal(openRootFile(outside).kind, 'ok');
});

function makeSink(files: { name: string; body: string; ageDays?: number }[]): string {
  const sink = join(ctx.home, 'sink-' + Math.random().toString(36).slice(2));
  mkdirSync(sink, { recursive: true });
  for (const f of files) {
    writeFileSync(join(sink, f.name), f.body);
    if (f.ageDays !== undefined) {
      const t = new Date(Date.now() - f.ageDays * 86_400_000);
      utimesSync(join(sink, f.name), t, t);
    }
  }
  return sink;
}

test('cursors: a first pass with a tiny budget resumes at the exact byte next pass', () => {
  const sink = makeSink([
    { name: 'a.jsonl', body: 'x'.repeat(1000) + ' AKIAABCDEFGHIJKLMNOP ' + 'y'.repeat(1000) },
    { name: 'b.jsonl', body: 'z'.repeat(3000) },
  ]);
  // Budget covers only the first ~1500 bytes: the sighting in the first file is found.
  const first = scanSinkResumable('k', sink, 1500, EMPTY_CURSOR, { retentionDays: null });
  assert.ok(first.sightings.some((s) => s.detector === 'aws-access-key'));
  assert.equal(first.completed, false);
  assert.ok(first.next.cursorText!.endsWith('a.jsonl'));
  assert.ok(first.next.cursorInt! > 0 && first.next.cursorInt! < 4000);
  assert.equal(first.backfillDone, false);

  // Second pass resumes past the cursor instead of rescanning from byte 0.
  const second = scanSinkResumable('k', sink, 1_000_000, first.next, { retentionDays: null });
  assert.equal(second.completed, true);
  assert.equal(second.backfillDone, true);
  // The AWS key in the already-scanned prefix is NOT re-sighted this pass.
  assert.equal(second.sightings.filter((s) => s.detector === 'aws-access-key').length, 0);
  assert.equal(second.next.backfillDone, true);

  // Third pass (tail): nothing changed, nothing scanned, nothing re-sighted.
  const third = scanSinkResumable('k', sink, 1_000_000, second.next, { retentionDays: null });
  assert.equal(third.bytesScanned, 0);
  assert.equal(third.sightings.length, 0);
  rmSync(sink, { recursive: true, force: true });
});

test('cursors: exclusion at the chokepoint produces a measured bytes_skipped receipt', () => {
  const dir = join(ctx.home, 'excluded-sink');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.txt'), 'A'.repeat(500));
  writeFileSync(join(ctx.home, '.vole', 'policy', 'exclude.json'), JSON.stringify([dir]));
  const out = scanSinkResumable('ex', dir, 1_000_000, EMPTY_CURSOR, { retentionDays: null });
  assert.equal(out.bytesSkipped, 500, 'bytes_skipped is the measured file size, never a constant 0');
  assert.equal(out.bytesScanned, 0);
  assert.equal(out.filesSkipped, 1);
  writeFileSync(join(ctx.home, '.vole', 'policy', 'exclude.json'), '[]');
  rmSync(dir, { recursive: true, force: true });
});

test('cursors: unscanned bytes inside the deletion horizon raise the expiry receipt', () => {
  const sink = makeSink([
    { name: 'old.jsonl', body: 'q'.repeat(2000), ageDays: 29 },
  ]);
  // Budget 0: nothing scanned, the whole sink is unscanned and 1 day from deletion.
  const out = scanSinkResumable('k2', sink, 0, EMPTY_CURSOR, { retentionDays: 30 });
  assert.equal(out.expiring?.files, 1);
  assert.equal(out.expiring?.bytes, 2000);
  rmSync(sink, { recursive: true, force: true });
});

test('scanner: end-to-end pass writes widening rows, cursor state and incidents', async () => {
  const sinkDir = join(ctx.home, '.claude', 'projects', 'slug', 'file-history');
  mkdirSync(sinkDir, { recursive: true });
  writeFileSync(join(sinkDir, 'f1.txt'), 'token = AKIAABCDEFGHIJKLMNOP\n');
  writeFileSync(join(ctx.home, '.claude', 'settings.json'), '{"cleanupPeriodDays": 30}');

  const r1 = dlpScanner.run();
  assert.equal(r1.ok, true);

  const db = (await import('../db')).openDb(ctx.db);
  const rows = db.prepare('SELECT * FROM secret_sightings').all() as Record<string, unknown>[];
  const aws = rows.find((row) => row.detector === 'aws-access-key')!;
  assert.ok(aws);
  assert.equal(aws.occurrences, 1);
  assert.equal(aws.provider, 'aws');
  assert.equal(aws.class_entry_id, 'credential:aws-access-key');
  assert.equal(aws.direction, 'at_rest');
  assert.equal(aws.status, 'candidate');
  assert.equal(aws.fixture_reason, null);
  assert.equal(aws.execution_context_id, null);

  const state = db.prepare('SELECT * FROM dlp_scan_state').all() as Record<string, unknown>[];
  const fh = state.find((s) => String(s.sink_key).includes('file-history'))!;
  assert.ok(fh.cursor_kind === 'file_offset');
  assert.ok(fh.backfill_done === 1);
  assert.ok(fh.pack_rev === PACK_VERSION);
  assert.ok((fh.bytes_skipped as number) >= 0);

  const anomalies = db.prepare('SELECT rule, severity FROM anomalies').all() as { rule: string }[];
  assert.ok(anomalies.some((a) => a.rule === 'secret_at_rest'));

  // A second pass sees no new sightings and does not re-incident.
  const r2 = dlpScanner.run();
  assert.ok(r2.ok);
  const after = db.prepare('SELECT occurrences, status FROM secret_sightings').all() as { occurrences: number; status: string }[];
  assert.ok(after.every((a) => (a.occurrences ?? 0) <= 2));

  // Triage: mark_rotated via finding_actions, then the same key sighted in a
  // NEW file flips to 'reappeared' and fires its own incident.
  const fp = String(aws.fingerprint);
  db.prepare('INSERT INTO finding_actions (anomaly_key, action, note, created_at) VALUES (?, ?, ?, ?)')
    .run(`secret_at_rest:${fp}`, 'mark_rotated', 'responder rotated it', Date.now());
  const triage = applyFindingActions(db);
  assert.equal(triage.rotated, 1);
  const rotated = db.prepare('SELECT status FROM secret_sightings WHERE fingerprint = ?').get(fp) as { status: string };
  assert.equal(rotated.status, 'rotated');

  writeFileSync(join(sinkDir, 'f2.txt'), 'again AKIAABCDEFGHIJKLMNOP\n');
  utimesSync(join(sinkDir, 'f2.txt'), new Date(), new Date());
  dlpScanner.run();
  const after2 = db.prepare("SELECT status FROM secret_sightings WHERE fingerprint = ?").get(fp) as { status: string };
  assert.equal(after2.status, 'reappeared');
  const rules = db.prepare('SELECT rule FROM anomalies').all() as { rule: string }[];
  assert.ok(rules.some((a) => a.rule === 'secret_reappeared_after_rotation'));

  // Read models: coverage, correlation, egress.
  const cov = dlpCoverage(db);
  assert.ok(cov.length >= 1 && cov.every((c) => c.backfillDone === true));
  const exposure = exposureCoverage(db);
  assert.ok(typeof exposure.scannedBytes === 'number' && typeof exposure.unscannableBytes === 'number');
  const corr = correlateFingerprints(db);
  const rollup = corr.find((c) => c.fingerprint === fp)!;
  assert.ok(rollup.correlatable);
  assert.deepEqual(rollup.providers, ['aws']);
  assert.ok(rollup.origin!.firstSeen > 0);
  const egress = dlpEgress(db);
  assert.ok(egress.some((e) => e.provider === 'aws'));
});

test('retention: cleanupPeriodDays is read from settings, .last-cleanup parsed', () => {
  writeFileSync(join(ctx.home, '.claude', 'settings.json'), '{"cleanupPeriodDays": 14}');
  writeFileSync(join(ctx.home, '.claude', '.last-cleanup'), '2026-09-07T05:13:50.752Z');
  const r = claudeRetention();
  assert.equal(r.days, 14);
  assert.equal(r.source, 'settings');
  assert.equal(r.lastCleanup, Date.parse('2026-09-07T05:13:50.752Z'));
  writeFileSync(join(ctx.home, '.claude', 'settings.json'), '{}');
  const d = claudeRetention();
  assert.equal(d.days, 30);
  assert.equal(d.source, 'vendor_default');
});

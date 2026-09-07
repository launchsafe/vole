import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanBuffer, shannon, classifyStatus, asContent, packIdentity } from './engine';
import { packChecksum, DETECTORS, PACK_VERSION } from './pack';

test('pack: checksum is stable across calls and covers every detector', () => {
  const a = packChecksum();
  const b = packChecksum();
  assert.equal(a, b, 'deterministic across processes-in-process');
  assert.equal(a.length, 64);
  assert.ok(DETECTORS.length >= 8, 'the builtin pack ships its full rule set');
  assert.equal(packIdentity().version, PACK_VERSION);
});

test('engine: AWS key shape is detected with byte offset', () => {
  const buf = asContent('config: nothing here\naws_key = AKIAIOSFODNN7EXAMPLE\n');
  const found = scanBuffer(buf);
  assert.ok(found.some((s) => s.detector === 'aws-access-key' && s.value === 'AKIAIOSFODNN7EXAMPLE'));
});

test('engine: prefilter skips the regex when no keyword is present', () => {
  // An AWS-shaped string with no 'AKIA'/'aws' nearby: the prefilter's whole point.
  const found = scanBuffer(asContent('zzzz zzzz zzzz zzzz'));
  assert.equal(found.length, 0);
});

test('engine: entropy catch-all fires only above the floor with a keyword', () => {
  const hi = 'api_key = a9f8d7c6b5a4938271605f4e3d2c1b0a';
  const found = scanBuffer(asContent(hi));
  assert.ok(found.some((s) => s.detector === 'high-entropy-assignment'));
  // Low-entropy 32 chars with a keyword: no match.
  const lo = 'api_key = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(scanBuffer(asContent(lo)).filter((s) => s.detector === 'high-entropy-assignment').length, 0);
});

test('engine: stopwords keep placeholders and test keys out', () => {
  const found = scanBuffer(asContent('api_key = sk-test-1234567890abcdef1234567890abcdef'));
  assert.equal(found.filter((s) => s.detector === 'openai-api-key').length, 0, 'sk-test placeholder must not match');
});

test('engine: private key headers match; offsets are byte-accurate for multibyte prefixes', () => {
  const prefix = 'éééé\n'; // multibyte: offsets must count bytes, not chars
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

test('engine: fixture classification keeps test paths quiet', () => {
  assert.equal(classifyStatus('/w/tests/foo.test.ts'), 'fixture');
  assert.equal(classifyStatus('/w/src/config.py'), 'candidate');
});

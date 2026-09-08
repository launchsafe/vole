import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vole-sign-'));
  process.env.VOLE_DB = join(tmp, 'vole.db');
});

const SAMPLE = `
Executable=/opt/homebrew/bin/claude
Identifier=com.anthropic.claude
Format=Mach-O universal (x86_64 arm64)
CodeDirectory v=2050 size=1234 flags=0x10002(runtime) hashes=3+3
TeamIdentifier=Q63R2BC59G
CDHash=b1c2d3e4f5a6789012345678abcdef
Authority=Developer ID Application: Anthropic (Q63R2BC59G)
Authority=Apple Worldwide Developer Relations Certification Authority
Timestamp=1 Jan 2026
`;

test('codesign output parses to TeamID, CDHash, authority and hardened runtime', async () => {
  const { parseCodesignOutput } = await import('./signing');
  const f = parseCodesignOutput(SAMPLE);
  assert.equal(f.identifier, 'com.anthropic.claude');
  assert.equal(f.team_id, 'Q63R2BC59G');
  assert.equal(f.cdhash, 'b1c2d3e4f5a6789012345678abcdef');
  assert.equal(f.authority, 'Developer ID Application: Anthropic (Q63R2BC59G)');
  assert.ok(f.hardened_runtime);
  assert.equal(f.signature_kind, 'developer_id');
});

test('ad-hoc and linker-signed degrade to their own kind; unparseable output is unknown, never unsigned', async () => {
  const { parseCodesignOutput } = await import('./signing');
  const adhoc = parseCodesignOutput('Identifier=x\nCodeDirectory flags=0x2(adhoc)\nCDHash=abc\n');
  assert.equal(adhoc.signature_kind, 'adhoc');
  const linked = parseCodesignOutput('Identifier=x\nflags=0x20000(linker-signed)\n');
  assert.equal(linked.signature_kind, 'adhoc');
  const nothing = parseCodesignOutput('');
  assert.equal(nothing.signature_kind, 'unknown');
});

test('a JS CLI is not Mach-O: not_applicable, never unsigned; unreadable is unknown', async () => {
  const { isMachO } = await import('./signing');
  const script = join(tmp, 'claude.js');
  writeFileSync(script, '#!/usr/bin/env node\nconsole.log(1)\n');
  assert.equal(isMachO(script), false);
  assert.equal(isMachO(join(tmp, 'nope.js')), null);
});

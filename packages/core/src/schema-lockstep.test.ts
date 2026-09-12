import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LATEST_MIGRATION } from './db';

/**
 * The Swift app carries its own copy of "newest schema I understand", and the version
 * gate only works while the two agree. Nothing enforced that, so adding migrations 29
 * and 30 to the collector left the app still claiming 28 — and it greeted its own
 * store with "written by a newer Vole" and refused to draw anything.
 *
 * A comment asking a human to remember is not a mechanism. This is.
 */
test('the macOS app knows the same newest schema as the collector', () => {
  const swift = join(import.meta.dirname, '../../../apps/mac/Sources/Vole/DB.swift');
  if (!existsSync(swift)) return; // core is published without the app; nothing to check

  const src = readFileSync(swift, 'utf8');
  const m = src.match(/static let knownSchemaVersion\s*=\s*(\d+)/);
  assert.ok(m, 'DB.swift no longer declares knownSchemaVersion — the gate moved, update this test');

  assert.equal(
    Number(m[1]),
    LATEST_MIGRATION,
    `DB.swift says it understands schema ${m[1]} but the collector's newest migration is ` +
      `${LATEST_MIGRATION}. Bump knownSchemaVersion in apps/mac/Sources/Vole/DB.swift.`,
  );
});

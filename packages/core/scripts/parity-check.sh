#!/bin/bash
# Read-model parity, locally: build a deterministic fixture store, run BOTH readers
# against it, fail on any difference. CI runs the same steps on macOS.
set -euo pipefail
cd "$(dirname "$0")/../../.."   # repo root

# Explicit template: macOS mktemp with none ignores $TMPDIR and uses the Darwin
# per-user dir, which sandboxed CI cannot write. honour TMPDIR like everything else.
DIR="$(mktemp -d "${TMPDIR:-/tmp}/vole-parity.XXXXXX")"
DB="$DIR/vole.db"

# `node --import tsx` instead of the `tsx` CLI binary: the CLI opens a local IPC
# pipe that seatbelt-sandboxed CI forbids; the loader is identical, no pipe.
pnpm --filter @vole/core exec node --import tsx scripts/parity-fixture.mjs "$DB" >/dev/null
VOLE_DB="$DB" pnpm --filter @vole/core exec node --import tsx src/cli/readmodel-dump.ts > "$DIR/ts.json"

if [ ! -x apps/mac/.build/debug/Vole ]; then
  echo "building the Swift reader first (swift build --package-path apps/mac)…"
  (cd apps/mac && swift build)
fi
VOLE_DB="$DB" apps/mac/.build/debug/Vole --dump=readmodel > "$DIR/swift.json"

# Materialised (not process-substitution) diffs: /dev/fd opens are blocked in
# seatbelt-sandboxed CI; plain files work identically everywhere.
jq -S . "$DIR/ts.json" > "$DIR/ts.sorted.json"
jq -S . "$DIR/swift.json" > "$DIR/swift.sorted.json"
if diff "$DIR/ts.sorted.json" "$DIR/swift.sorted.json"; then
  echo "read-model parity: identical  ($DIR)"
else
  echo "read-model parity: DIFFERS — ts.json vs swift.json in $DIR" >&2
  exit 1
fi

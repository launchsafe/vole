#!/bin/bash
# Read-model parity, locally: build a deterministic fixture store, run BOTH readers
# against it, fail on any difference. CI runs the same steps on macOS.
set -euo pipefail
cd "$(dirname "$0")/../../.."   # repo root

DIR="$(mktemp -d)/parity"
DB="$DIR/vole.db"

pnpm --filter @vole/core exec tsx scripts/parity-fixture.mjs "$DB" >/dev/null
VOLE_DB="$DB" pnpm --filter @vole/core exec tsx src/cli/readmodel-dump.ts > "$DIR/ts.json"

if [ ! -x apps/mac/.build/debug/Vole ]; then
  echo "building the Swift reader first (swift build --package-path apps/mac)…"
  (cd apps/mac && swift build)
fi
VOLE_DB="$DB" apps/mac/.build/debug/Vole --dump=readmodel > "$DIR/swift.json"

if diff <(jq -S . "$DIR/ts.json") <(jq -S . "$DIR/swift.json"); then
  echo "read-model parity: identical  ($DIR)"
else
  echo "read-model parity: DIFFERS — ts.json vs swift.json in $DIR" >&2
  exit 1
fi

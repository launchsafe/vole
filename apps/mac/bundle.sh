#!/bin/bash
# Assemble Vole.app from a release build. Ad-hoc signed — fine for local use;
# real distribution still needs a Developer ID + notarisation.
#
#   ./bundle.sh                 → build/Vole.app
#   ./bundle.sh --open          → also `open` it
#   VERSION=0.2.0 ./bundle.sh   → stamp a version
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Vole.app"
VERSION="${VERSION:-0.1.0}"

# 1. icon (regenerate if the source changed and sharp is available)
if [ ! -f Icon/Vole.icns ] || [ Icon/build.mjs -nt Icon/Vole.icns ]; then
  node Icon/build.mjs --emit
fi

# 2. release binary
swift build -c release
BIN="$(swift build -c release --show-bin-path)/Vole"

# 3. lay out the bundle
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Vole"
cp Icon/Vole.icns "$APP/Contents/Resources/AppIcon.icns"
cp -R "$(dirname "$BIN")/Vole_Vole.bundle" "$APP/Contents/Resources/"   # SwiftPM resources
sed "s#<string>0.1.0</string>#<string>$VERSION</string>#" Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# 4. ad-hoc sign (deep, so the nested resource bundle is covered)
codesign --force --deep --sign - "$APP"

echo "built $APP  (v$VERSION)"
[ "${1:-}" = "--open" ] && open "$APP"

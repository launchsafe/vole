#!/bin/bash
# Assemble Vole.app from a release build.
#
#   ./bundle.sh                 → build/Vole.app, ad-hoc signed (local use only)
#   ./bundle.sh --open          → also `open` it
#   ./bundle.sh --release       → Developer ID signed, notarised, stapled, + a .dmg
#   VERSION=0.2.0 ./bundle.sh   → stamp a version
#
# --release needs two things set up once, both requiring an Apple ID in a browser:
#
#   1. A "Developer ID Application" certificate in the login keychain.
#      Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application.
#      Check it landed:  security find-identity -v -p codesigning
#
#   2. A stored notarytool credential, so no secret lives in this repo:
#      Create an app-specific password at https://appleid.apple.com (Sign-In and Security),
#      then run:
#        xcrun notarytool store-credentials vole-notary \
#          --apple-id "<your-apple-id>" --team-id "<TEAMID>" --password "<app-specific-password>"
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Vole.app"
VERSION="${VERSION:-0.1.0}"
DMG="build/Vole-$VERSION.dmg"
NOTARY_PROFILE="${NOTARY_PROFILE:-vole-notary}"
RELEASE=false
OPEN=false
for a in "$@"; do
  case "$a" in
    --release) RELEASE=true ;;
    --open)    OPEN=true ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

# 1. icon (regenerate if the source changed and sharp is available)
if [ ! -f Icon/Vole.icns ] || [ Icon/build.mjs -nt Icon/Vole.icns ]; then
  node Icon/build.mjs --emit
fi

# 2. release binary
swift build -c release
BIN="$(swift build -c release --show-bin-path)/Vole"

# 3. lay out the bundle
rm -rf "$APP" "$DMG"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Vole"
cp Icon/Vole.icns "$APP/Contents/Resources/AppIcon.icns"
cp -R "$(dirname "$BIN")/Vole_Vole.bundle" "$APP/Contents/Resources/"   # SwiftPM resources
sed "s#<string>0.1.0</string>#<string>$VERSION</string>#" Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

if [ "$RELEASE" = false ]; then
  # 4a. ad-hoc sign (deep, so the nested resource bundle is covered)
  codesign --force --deep --sign - "$APP"
  echo "built $APP  (v$VERSION, ad-hoc — Gatekeeper will reject this on another Mac)"
  [ "$OPEN" = true ] && open "$APP"
  exit 0
fi

# 4b. Developer ID signing. Vole_Vole.bundle (SwiftPM's resource bundle) is plain PNGs,
#     no Info.plist and no executable code, so codesign can't treat it as nested code —
#     signing the outer app alone seals it in via CodeResources, which is all it needs.
ID="$(security find-identity -v -p codesigning \
      | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
[ -n "$ID" ] || { echo "no 'Developer ID Application' certificate in the keychain — see the header of this script" >&2; exit 1; }
echo "signing as: $ID"

# --options runtime (Hardened Runtime) and --timestamp are both required for notarisation.
codesign --force --timestamp --options runtime --sign "$ID" "$APP"
codesign --verify --strict --verbose=2 "$APP"

# 5. notarise the app, then staple the ticket into it, so a first launch works offline.
ZIP="build/Vole-$VERSION.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
rm -f "$ZIP"

# 6. drag-to-Applications disk image, containing the already-stapled app
STAGE="build/dmg"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Vole" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

# 7. the disk image is what users download, so it is signed and notarised too
codesign --force --timestamp --sign "$ID" "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"

echo
spctl -a -vvv "$APP" || true          # must say: accepted, source=Notarized Developer ID
echo "built $DMG  (v$VERSION, signed + notarised)"
[ "$OPEN" = true ] && open build/
exit 0

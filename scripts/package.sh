#!/bin/sh
# Builds dist/nativecast.app and dist/nativecast.dmg with the host inside the bundle.
set -eu
cd "$(dirname "$0")/.."
root=$PWD
./scripts/build-host.sh
cd app
../scripts/native build --yes
../scripts/native package --target macos --signing adhoc --output "$root/dist/nativecast.app"
cd ..
# `native package` cannot carry the host as an asset: it fails with StreamTooLong
# on the 89 MB file and drops the executable bit. See docs/poc-findings.md.
cp dist/bin/nativecast-host dist/bin/nativecast-hotkey dist/nativecast.app/Contents/MacOS/
codesign --force --deep --sign - dist/nativecast.app
rm -f dist/nativecast.dmg
hdiutil create -volname nativecast -srcfolder dist/nativecast.app -ov -format UDZO dist/nativecast.dmg
du -sh dist/nativecast.app dist/nativecast.dmg

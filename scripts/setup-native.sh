#!/bin/sh
# Installs Native SDK CLI 0.11.0 into .tools/native with the two workarounds
# from docs/poc-findings.md: the npm package misses a file build.zig embeds,
# and Node 26 refuses to strip types from .ts files under node_modules.
set -eu
version=0.11.0
root=$(cd "$(dirname "$0")/.." && pwd)
dir="$root/.tools/native"
mkdir -p "$dir"
cd "$dir"
[ -f package.json ] || npm init -y >/dev/null
npm install --silent "@native-sdk/cli@$version"
rm -rf sdk
cp -R node_modules/@native-sdk/cli sdk
missing=tests/ts-core/gpu-dashboard-reference/main.zig
mkdir -p "sdk/$(dirname "$missing")"
curl -fsSL "https://raw.githubusercontent.com/vercel-labs/native/v$version/$missing" -o "sdk/$missing"
# The bundled faces are Latin-only, so Korean draws as boxes without this font.
fonts="$root/app/assets/fonts"
mkdir -p "$fonts"
base=https://raw.githubusercontent.com/google/fonts/b38c5c93af322c45f633e17ac440ec1e6c94d489/ofl/notosanskr
curl -fsSL "$base/NotoSansKR%5Bwght%5D.ttf" -o "$fonts/NotoSansKR.ttf"
curl -fsSL "$base/OFL.txt" -o "$fonts/OFL.txt"
"$root/scripts/native" --version

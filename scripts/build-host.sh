#!/bin/sh
# Builds the extension host and the hotkey helper into dist/bin.
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist/bin
bun build --compile host/src/main.ts host/src/worker.ts --outfile dist/bin/nativecast-host
clang -O2 -Wall -framework Carbon -o dist/bin/nativecast-hotkey helpers/hotkey.c
ls -la dist/bin

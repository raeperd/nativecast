#!/bin/sh
# Builds the automation app and the host, then runs the end-to-end suite.
set -eu
cd "$(dirname "$0")/.."
./scripts/build-host.sh >/dev/null
(cd app && ../scripts/native build -Dautomation=true --yes >/dev/null)
bun test --timeout 30000 tests/e2e.test.ts

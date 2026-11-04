#!/bin/zsh
# Manual check for what `native automate` cannot reach: the global shortcut,
# keyboard focus on show, real IME typing, and returning to the previous app.
# Needs an unlocked screen and scripts/test-e2e.sh to have built the app.
# --post sends the shortcut with tests/tools/post-key.c instead of asking you
# to press it; the terminal then needs the Accessibility permission.
set -u
cd "$(dirname "$0")/../app"
native=../scripts/native
extensions=$(mktemp -d)
cat > "$extensions/echo.ts" <<'TS'
export default (app) => app.registerSource({ search: (q) => [{ title: "echo " + q, copy: q }] });
TS
rm -rf .zig-cache/native-sdk-automation
NATIVECAST_HOST=$PWD/../dist/bin/nativecast-host NATIVECAST_EXTENSIONS_DIR=$extensions ./zig-out/bin/nativecast >/dev/null 2>&1 &
app=$!
trap 'kill $app; rm -rf "$extensions"' EXIT
$native automate wait >/dev/null

front() { lsappinfo info -only name "$(lsappinfo front)" | sed 's/.*="//; s/"$//'; }
check() { # label, pattern
  if $native automate assert --timeout-ms 30000 "$2" >/dev/null 2>&1; then echo "PASS  $1"; else echo "FAIL  $1"; fi
}

before=$(front)
echo "Front app: $before"
if [[ ${1:-} == --post ]]; then
  clang -O2 -framework ApplicationServices -o /tmp/nativecast-post-key ../tests/tools/post-key.c
  /tmp/nativecast-post-key 49 ctrl opt
else
  echo "Press Control+Option+Space now."
fi
check "shortcut shows the window with key focus" '^window @w1 .*focused=true'
check "search field has keyboard focus" 'role=textbox name="Search".*focused=true'
echo "Front app after show: $(front)"
echo "Type 안녕 with the Korean input source."
check "IME typing reaches the search" 'role=listitem name="echo 안녕"'
if [[ $(front) != nativecast ]]; then
  echo "FAIL  nativecast never became the front app, so Esc cannot be checked"
  exit 1
fi
echo "Press Esc."
for _ in {1..300}; do [[ $(front) != nativecast ]] && break; sleep 0.1; done
[[ $(front) == "$before" ]] && echo "PASS  Esc returns to $before" || echo "FAIL  front app is $(front), expected $before"

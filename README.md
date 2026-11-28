# nativecast

An open-source macOS launcher. Press a global shortcut, type, and installed extensions return results to one list.

An extension is a TypeScript file dropped into a folder. The launcher loads it while running and reloads it on save, so you can ask an AI agent to write one and use it right away.

Nothing is usable yet. The `poc/initial` branch holds a proof of concept; see [docs/poc-findings.md](docs/poc-findings.md).

## Running the PoC

Needs macOS on Apple silicon, Node 24 or later, Bun, and the Xcode command line tools.

```sh
scripts/setup-native.sh   # Native SDK CLI into .tools/, with its workarounds
scripts/test-e2e.sh       # real app + real host + real extension files
scripts/package.sh        # dist/nativecast.app and dist/nativecast.dmg
open dist/nativecast.app  # NC appears in the menu bar
```

Copy `examples/extensions/stock.ts` to `~/.nativecast/extensions/`, press Control+Option+Space or use the menu bar item, and type `stock 삼성`.

`scripts/verify-hotkey-focus.sh` covers the checks automation cannot reach. Run it on an unlocked screen.

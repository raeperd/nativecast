// Real app, real host, real extension files, driven through `native automate`.
// Run with scripts/test-e2e.sh. One app serves the whole file to keep it fast.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const appDir = join(root, "app");
const extensions = mkdtempSync(join(tmpdir(), "nativecast-e2e-"));
const abortLog = join(extensions, ".aborted");
let app: Bun.Subprocess;
let searchField: string;
let savedClipboard: string;

beforeAll(async () => {
  savedClipboard = Bun.spawnSync(["pbpaste"]).stdout.toString();
  rmSync(join(appDir, ".zig-cache/native-sdk-automation"), { recursive: true, force: true });
  app = Bun.spawn([join(appDir, "zig-out/bin/nativecast")], {
    cwd: appDir,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      NATIVECAST_HOST: join(root, "dist/bin/nativecast-host"),
      NATIVECAST_EXTENSIONS_DIR: extensions,
    },
  });
  automate("wait");
  assertSnapshot('name="Ready"');
  searchField = automate("snapshot").match(/#(\d+) role=textbox/)![1]!;
});

afterAll(() => {
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(savedClipboard) });
  app.kill();
  rmSync(extensions, { recursive: true, force: true });
});

function automate(...args: string[]) {
  const result = Bun.spawnSync([join(root, "scripts/native"), "automate", ...args], { cwd: appDir });
  const output = result.stdout.toString() + result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`automate ${args.join(" ")}\n${output}`);
  return output;
}

function assertSnapshot(...patterns: string[]) {
  automate("assert", "--timeout-ms", "5000", ...patterns);
}

function assertGone(...patterns: string[]) {
  automate("assert", "--absent", "--timeout-ms", "5000", ...patterns);
}

function type(text: string) {
  automate("widget-action", "main-canvas", searchField, "set_text", text);
}

function install(name: string, source: string) {
  writeFileSync(join(extensions, name), source);
  assertSnapshot(`name="Loaded ${name} in`);
}

function echoSource(prefix: string) {
  return `export default (app) => app.registerSource({
    search: (q) => [{ title: "${prefix} " + q, copy: "${prefix} copied " + q }],
  });`;
}

function uninstall(name: string) {
  rmSync(join(extensions, name), { recursive: true });
  assertSnapshot(`name="Removed ${name}`);
}

test("a dropped extension file shows results", () => {
  install("drop.ts", echoSource("dropped"));
  type("one");
  assertSnapshot('role=listitem name="dropped one"');
  uninstall("drop.ts");
});

test("editing an extension changes the next search", () => {
  install("edit.ts", echoSource("before"));
  type("two");
  assertSnapshot('role=listitem name="before two"');
  install("edit.ts", echoSource("after"));
  type("three");
  assertSnapshot('role=listitem name="after three"');
  uninstall("edit.ts");
});

test("a broken extension shows an error, leaves others working, and recovers", () => {
  install("good.ts", echoSource("good"));
  writeFileSync(join(extensions, "broken.ts"), "export default function (");
  assertSnapshot('name="Error in broken.ts');
  type("four");
  assertSnapshot('role=listitem name="good four"');
  install("broken.ts", echoSource("fixed"));
  type("five");
  assertSnapshot('role=listitem name="good five"', 'role=listitem name="fixed five"');
  uninstall("broken.ts");
  uninstall("good.ts");
});

test("deleting an extension removes its results", () => {
  install("gone.ts", echoSource("gone"));
  install("stays.ts", echoSource("stays"));
  type("six");
  assertSnapshot('role=listitem name="gone six"');
  uninstall("gone.ts");
  type("seven");
  assertSnapshot('role=listitem name="stays seven"');
  assertGone('role=listitem name="gone');
  uninstall("stays.ts");
});

test("a query hook rewrites the search for other extensions", () => {
  install("alias.ts", `export default (app) => app.on("query", (e) => e.query === "삼전" ? { query: "삼성전자" } : undefined);`);
  install("echo.ts", echoSource("echo"));
  type("삼전");
  assertSnapshot('role=listitem name="echo 삼성전자"');
  uninstall("alias.ts");
  uninstall("echo.ts");
});

test("a keyword runs only the matching source", () => {
  install("all.ts", echoSource("all"));
  install(
    "stock.ts",
    `export default (app) => app.registerSource({ keyword: "stock", search: (q) => [{ title: "stock " + q }] });`,
  );
  type("stock 삼성");
  assertSnapshot('role=listitem name="stock 삼성"');
  assertGone('role=listitem name="all');
  uninstall("all.ts");
  uninstall("stock.ts");
});

test("a package extension can use its node_modules", () => {
  const dir = join(extensions, "pkg");
  mkdirSync(join(dir, "node_modules/greeting"), { recursive: true });
  writeFileSync(join(dir, "node_modules/greeting/index.js"), `export const greet = (q) => "greeted " + q;`);
  writeFileSync(join(dir, "package.json"), `{ "main": "main.ts" }`);
  writeFileSync(
    join(dir, "main.ts"),
    `import { greet } from "greeting";
     export default (app) => app.registerSource({ search: (q) => [{ title: greet(q) }] });`,
  );
  assertSnapshot('name="Loaded pkg in');
  type("eight");
  assertSnapshot('role=listitem name="greeted eight"');
  uninstall("pkg");
});

test("a fast source shows before a slow one finishes", () => {
  install("fast.ts", echoSource("fast"));
  install(
    "slow.ts",
    `export default (app) => app.registerSource({
      search: (q) => new Promise((done) => setTimeout(() => done([{ title: "slow " + q }]), 2000)),
    });`,
  );
  type("nine");
  assertSnapshot('role=listitem name="fast nine"');
  expect(automate("snapshot")).not.toContain('name="slow nine"');
  assertSnapshot('role=listitem name="slow nine"');
  uninstall("fast.ts");
  uninstall("slow.ts");
});

test("typing on cancels earlier searches and only the last query stays", async () => {
  install(
    "cancel.ts",
    `import { appendFileSync } from "node:fs";
     export default (app) => app.registerSource({
       search: (q, ctx) => new Promise((done) => {
         const timer = setTimeout(() => done([{ title: "cancel " + q }]), 800);
         ctx.signal.addEventListener("abort", () => {
           clearTimeout(timer);
           appendFileSync(${JSON.stringify(abortLog)}, q + "\\n");
           done([]);
         });
       }),
     });`,
  );
  for (const query of ["t", "te", "ten"]) type(query);
  assertSnapshot('role=listitem name="cancel ten"');
  assertGone('role=listitem name="cancel t"', 'role=listitem name="cancel te"');
  expect((await Bun.file(abortLog).text()).trim().split("\n")).toEqual(["t", "te"]);
  uninstall("cancel.ts");
});

test("Korean composition searches and commits", () => {
  install("ime.ts", echoSource("ime"));
  type("");
  automate("widget-action", "main-canvas", searchField, "set_composition", "ㅎ");
  assertSnapshot('role=listitem name="ime ㅎ"');
  automate("widget-action", "main-canvas", searchField, "set_composition", "하");
  assertSnapshot('role=listitem name="ime 하"');
  automate("widget-action", "main-canvas", searchField, "set_composition", "한");
  automate("widget-action", "main-canvas", searchField, "commit_composition");
  assertSnapshot('role=listitem name="ime 한"');
  assertSnapshot('role=textbox name="Search".* text="한"');
  uninstall("ime.ts");
});

test("arrow selection and Enter copy the selected result", async () => {
  install(
    "copy.ts",
    `export default (app) => app.registerSource({
      search: (q) => [{ title: "first " + q, copy: "first copied" }, { title: "second " + q, copy: "second copied" }],
    });`,
  );
  type("eleven");
  assertSnapshot('role=listitem name="second eleven"');
  automate("shortcut", "list.next");
  automate("widget-action", "main-canvas", searchField, "focus");
  automate("widget-key", "main-canvas", "enter");
  for (let i = 0; i < 50 && Bun.spawnSync(["pbpaste"]).stdout.toString() !== "second copied"; i++) {
    await Bun.sleep(100);
  }
  expect(Bun.spawnSync(["pbpaste"]).stdout.toString()).toBe("second copied");
  uninstall("copy.ts");
});

test("the host and hotkey helper exit with the app", async () => {
  const hostPath = join(root, "dist/bin/nativecast-");
  const running = () => Bun.spawnSync(["pgrep", "-f", hostPath]).stdout.toString().trim();
  expect(running()).not.toBe("");
  app.kill();
  for (let i = 0; i < 40 && running() !== ""; i++) await Bun.sleep(100);
  expect(running()).toBe("");
});

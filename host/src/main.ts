// Extension host. The app spawns this process, reads events from its stdout
// and sends searches over loopback HTTP. Wire format: docs/poc-findings.md.
import { watch } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Item } from "./api";

const SEARCH_TIMEOUT_MS = 5_000;
const HOOK_TIMEOUT_MS = 1_000;
const RELOAD_DEBOUNCE_MS = 50;
// The app reads lines with maxLineBytes 8192.
const MAX_FIELD_BYTES = 1_500;

const extensionsDir =
  process.env.NATIVECAST_EXTENSIONS_DIR ?? join(homedir(), ".nativecast", "extensions");
const token = crypto.randomUUID();
const extensions = new Map<string, Extension>();
const reloadTimers = new Map<string, Timer>();
let currentSearch: AbortController | undefined;

async function main() {
  await mkdir(extensionsDir, { recursive: true });
  await Promise.all((await listExtensionNames()).map(reload));
  watchExtensions();
  startHotkeyHelper();
  exitWithParent();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized\n", { status: 401 });
      }
      const body = await request.text();
      const tab = body.indexOf("\t");
      return search(body.slice(0, tab), body.slice(tab + 1));
    },
  });
  emit("READY", server.port, token);
}

/** One search is live at a time: a new request ends the previous stream. */
function search(seq: string, rawQuery: string) {
  currentSearch?.abort();
  const controller = new AbortController();
  currentSearch = controller;
  const { signal } = controller;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(out) {
      const write = (...fields: string[]) => {
        if (!signal.aborted) out.enqueue(encoder.encode(fields.join("\t") + "\n"));
      };
      write("S", seq);
      const query = await runQueryHooks(rawQuery, signal);
      const { keyword, text } = route(query);
      const searches: Promise<void>[] = [];
      for (const extension of sorted()) {
        extension.keywords.forEach((sourceKeyword, source) => {
          if (keyword !== undefined ? sourceKeyword !== keyword : text === "") return;
          searches.push(
            extension.search(source, text, signal).then((items) => {
              for (const item of items) {
                const action = item.url ? "url" : "copy";
                write(
                  "R",
                  seq,
                  field(extension.name),
                  field(item.title),
                  field(item.subtitle ?? ""),
                  action,
                  field(item.url ?? item.copy ?? item.title),
                );
              }
            }),
          );
        });
      }
      await Promise.race([Promise.all(searches), aborted(signal)]);
      write("D", seq);
      out.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function route(query: string) {
  const space = query.indexOf(" ");
  const first = space === -1 ? query : query.slice(0, space);
  const known = sorted().some((extension) => extension.keywords.includes(first));
  return known
    ? { keyword: first, text: space === -1 ? "" : query.slice(space + 1).trim() }
    : { keyword: undefined, text: query.trim() };
}

async function runQueryHooks(query: string, signal: AbortSignal) {
  let current = query;
  for (const extension of sorted()) {
    if (extension.hasQueryHook) current = await extension.runQueryHook(current, signal);
  }
  return current;
}

function aborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
}

function sorted() {
  return [...extensions.values()]
    .filter((extension) => extension.loaded)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A Worker running one extension. Pending calls resolve empty on dispose. */
class Extension {
  loaded = false;
  keywords: (string | null)[] = [];
  hasQueryHook = false;
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (value: unknown) => void>();
  private ready: () => void = () => {};

  constructor(
    readonly name: string,
    entry: string,
  ) {
    const startedAt = performance.now();
    this.worker = new Worker(new URL("./worker.ts", import.meta.url).href);
    this.worker.onmessage = ({ data }) => {
      switch (data.type) {
        case "loaded":
          this.loaded = true;
          this.keywords = data.keywords;
          this.hasQueryHook = data.hasQueryHook;
          emit("LOADED", name, Math.round(performance.now() - startedAt));
          return this.ready();
        case "load-error":
          emit("ERROR", name, data.message);
          return this.ready();
        case "result":
          return this.settle(data.id, data.value);
        case "error":
          emit("ERROR", name, data.message);
          return this.settle(data.id, undefined);
      }
    };
    this.worker.onerror = (event) => {
      emit("ERROR", name, event.message);
      this.ready();
    };
    this.worker.postMessage({ type: "load", entry });
  }

  whenSettled() {
    return new Promise<void>((resolve) => (this.ready = resolve));
  }

  async search(source: number, query: string, signal: AbortSignal) {
    const items = await this.call({ type: "search", source, query }, signal, SEARCH_TIMEOUT_MS);
    return (items ?? []) as Item[];
  }

  async runQueryHook(query: string, signal: AbortSignal) {
    const changed = await this.call({ type: "query", query }, signal, HOOK_TIMEOUT_MS);
    return (changed as string | undefined) ?? query;
  }

  dispose() {
    this.worker.terminate();
    for (const resolve of this.pending.values()) resolve(undefined);
    this.pending.clear();
  }

  private call(message: object, signal: AbortSignal, timeoutMs: number) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve) => {
      const abort = () => {
        this.worker.postMessage({ type: "abort", id });
        this.settle(id, undefined);
      };
      const timeout = setTimeout(() => {
        emit("ERROR", this.name, `timed out after ${timeoutMs}ms`);
        abort();
      }, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, (value) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        resolve(value);
      });
      if (signal.aborted) abort();
      else this.worker.postMessage({ ...message, id });
    });
  }

  private settle(id: number, value: unknown) {
    this.pending.get(id)?.(value);
    this.pending.delete(id);
  }
}

async function listExtensionNames() {
  const entries = await readdir(extensionsDir);
  return entries.filter((entry) => !entry.startsWith("."));
}

/** A `.ts` file, a folder with `index.ts`, or a package whose `main` points at the entry. */
async function resolveEntry(name: string) {
  const path = join(extensionsDir, name);
  const info = await stat(path).catch(() => undefined);
  if (!info) return undefined;
  if (info.isFile()) return name.endsWith(".ts") ? path : undefined;
  const manifest = Bun.file(join(path, "package.json"));
  const main = (await manifest.exists()) ? (await manifest.json()).main : undefined;
  return join(path, main ?? "index.ts");
}

async function reload(name: string) {
  const entry = await resolveEntry(name);
  extensions.get(name)?.dispose();
  extensions.delete(name);
  if (!entry) return emit("REMOVED", name);
  const extension = new Extension(name, entry);
  extensions.set(name, extension);
  await extension.whenSettled();
}

function watchExtensions() {
  watch(extensionsDir, { recursive: true }, (_event, filename) => {
    if (!filename || filename.includes("node_modules")) return;
    const name = filename.split("/")[0]!;
    if (name.startsWith(".")) return;
    clearTimeout(reloadTimers.get(name));
    reloadTimers.set(name, setTimeout(() => reload(name), RELOAD_DEBOUNCE_MS));
  });
}

function startHotkeyHelper() {
  const helper = join(dirname(process.execPath), "nativecast-hotkey");
  if (basename(process.execPath) === "bun") return;
  const child = Bun.spawn([helper], { stdout: "pipe", stderr: "pipe" });
  (async () => {
    for await (const line of child.stdout.pipeThrough(new TextDecoderStream())) {
      if (line.includes("HOTKEY")) emit("HOTKEY");
    }
    const reason = await new Response(child.stderr).text();
    emit("ERROR", "hotkey", reason || `helper exited with ${await child.exited}`);
  })();
}

/** Cmd.spawn gives the child no EOF on stdin, so poll for the app going away. */
function exitWithParent() {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 1_000);
}

function field(value: string) {
  const clean = value.replace(/[\t\r\n]+/g, " ");
  const bytes = new TextEncoder().encode(clean);
  if (bytes.length <= MAX_FIELD_BYTES) return clean;
  return new TextDecoder().decode(bytes.slice(0, MAX_FIELD_BYTES)).replace(/�$/, "");
}

function emit(...fields: (string | number)[]) {
  console.log(fields.map((value) => field(String(value))).join("\t"));
}

await main();

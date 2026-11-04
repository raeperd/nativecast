// One Worker per extension. Replacing the Worker is the only reload that
// returns new code, so this file never tries to reload anything itself.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Item, QueryHandler, Source } from "./api";

declare const self: Worker;

const sources: Source[] = [];
const queryHandlers: QueryHandler[] = [];
const running = new Map<number, AbortController>();

self.onmessage = async ({ data }: MessageEvent) => {
  switch (data.type) {
    case "load":
      try {
        await load(data.entry);
        self.postMessage({
          type: "loaded",
          keywords: sources.map((source) => source.keyword ?? null),
          hasQueryHook: queryHandlers.length > 0,
        });
      } catch (error) {
        self.postMessage({ type: "load-error", message: String(error) });
      }
      return;
    case "search":
      return respond(data.id, async (signal) => normalize(await sources[data.source]!.search(data.query, { signal })));
    case "query":
      return respond(data.id, (_signal) => runQueryHandlers(data.query));
    case "abort":
      running.get(data.id)?.abort();
      return;
  }
};

async function load(entry: string) {
  // A compiled Bun executable cannot resolve packages that import their own
  // name, so every extension is bundled to one file before import.
  const built = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm" });
  if (!built.success) throw new AggregateError(built.logs, built.logs.join("\n"));
  const dir = await mkdtemp(join(tmpdir(), "nativecast-ext-"));
  const file = join(dir, "bundle.mjs");
  await Bun.write(file, built.outputs[0]!);
  const module = await import(file);
  await rm(dir, { recursive: true });
  const api: ExtensionAPI = {
    on: (_event, handler) => queryHandlers.push(handler),
    registerSource: (source) => sources.push(source),
  };
  await module.default(api);
}

async function respond(id: number, work: (signal: AbortSignal) => unknown) {
  const controller = new AbortController();
  running.set(id, controller);
  try {
    self.postMessage({ type: "result", id, value: await work(controller.signal) });
  } catch (error) {
    self.postMessage({ type: "error", id, message: String(error) });
  } finally {
    running.delete(id);
  }
}

async function runQueryHandlers(query: string) {
  let current = query;
  for (const handler of queryHandlers) {
    const changed = await handler({ query: current });
    if (changed) current = changed.query;
  }
  return current;
}

function normalize(items: Item[]) {
  return items.map(({ title, subtitle, url, copy }) => ({ title, subtitle, url, copy }));
}

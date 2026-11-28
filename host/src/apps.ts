// Built-in source: applications in the standard folders. The folders are read
// on every search, so an app installed while the launcher runs shows up at once.
// Results are ordered by how well the name matches, then by how often and how
// recently the app was opened from the launcher.
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface App {
  name: string;
  path: string;
}

const appDirs = process.env.NATIVECAST_APP_DIRS?.split(":") ?? [
  "/Applications",
  "/System/Applications",
  join(homedir(), "Applications"),
];

const usageFile = process.env.NATIVECAST_USAGE_FILE ?? join(homedir(), ".nativecast", "usage.json");
const MAX_RESULTS = 8;
// Three recent opens lift a mid-word match over an unused prefix match.
const USAGE_BONUS_PER_OPEN = 10;
const USAGE_BONUS_MAX = 30;
const HALF_LIFE_MS = 10 * 24 * 60 * 60 * 1000;

/** `count` is the decayed number of opens as of `at`. */
interface Usage {
  count: number;
  at: number;
}

const usage: Record<string, Usage> = await Bun.file(usageFile)
  .json()
  .catch(() => ({}));

export async function searchApps(query: string): Promise<App[]> {
  const ranked: { app: App; score: number }[] = [];
  for (const app of await listApps()) {
    const match = matchScore(query, app.name);
    if (match === undefined) continue;
    const bonus = Math.min(USAGE_BONUS_MAX, USAGE_BONUS_PER_OPEN * decayedOpens(app.path));
    ranked.push({ app, score: match + bonus });
  }
  return ranked
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.app.name.length - b.app.name.length ||
        a.app.name.localeCompare(b.app.name),
    )
    .slice(0, MAX_RESULTS)
    .map(({ app }) => app);
}

/** What an empty search shows: the apps opened most, most recent first among equals. */
export async function suggestedApps(): Promise<App[]> {
  return (await listApps())
    .filter((app) => usage[app.path])
    .sort((a, b) => decayedOpens(b.path) - decayedOpens(a.path))
    .slice(0, MAX_RESULTS);
}

export async function recordOpen(path: string) {
  usage[path] = { count: decayedOpens(path) + 1, at: Date.now() };
  await Bun.write(usageFile, JSON.stringify(usage));
}

/** Opens halve every ten days, so daily use outranks one open last month. */
function decayedOpens(path: string) {
  const used = usage[path];
  return used ? used.count * 0.5 ** ((Date.now() - used.at) / HALF_LIFE_MS) : 0;
}

/**
 * Whole name 100, name prefix 80, word prefix 60, word initials 50, substring
 * 40, letters in order 20. `tt` finds TickTick and `clc` finds Calculator.
 */
function matchScore(query: string, name: string) {
  const needle = query.toLowerCase();
  const lower = name.toLowerCase();
  if (lower === needle) return 100;
  if (lower.startsWith(needle)) return 80;
  const words = name.split(/[\s\-_.]+|(?<=[a-z])(?=[A-Z])/).map((word) => word.toLowerCase());
  if (words.some((word) => word.startsWith(needle))) return 60;
  if (words.map((word) => word[0]).join("").startsWith(needle)) return 50;
  if (lower.includes(needle)) return 40;
  let matched = 0;
  for (const letter of lower) {
    if (letter === needle[matched]) matched++;
  }
  return matched === needle.length ? 20 : undefined;
}

/** Apps in each folder and one level of subfolders, such as Utilities. */
async function listApps() {
  const apps: App[] = [];
  const add = (dir: string, file: string) =>
    apps.push({ name: file.slice(0, -".app".length).normalize("NFC"), path: join(dir, file) });
  for (const dir of appDirs) {
    for (const file of await names(dir)) {
      if (file.endsWith(".app")) {
        add(dir, file);
        continue;
      }
      const subfolder = join(dir, file);
      for (const inner of await names(subfolder)) {
        if (inner.endsWith(".app")) add(subfolder, inner);
      }
    }
  }
  return apps;
}

/** A missing folder or a plain file reads as empty. */
function names(dir: string) {
  return readdir(dir).catch(() => [] as string[]);
}

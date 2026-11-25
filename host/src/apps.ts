// Built-in source: applications in the standard folders. The folders are read
// on every search, so an app installed while the launcher runs shows up at once.
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

export async function searchApps(query: string): Promise<App[]> {
  const needle = query.toLowerCase();
  return (await listApps())
    .filter((app) => app.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
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

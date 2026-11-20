import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Files already in the output folder from before the project began (an old index.html, a movies.json). The Planner
 * is told about them, so it doesn't build on them unasked, and the user is told which planned files will replace one.
 */

/** Folders never listed: tools' and packages' own, and anything hidden. */
const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next"]);

/** The most files listed: enough to see what is there. */
export const MAX_EXISTING = 40;

/**
 * The files in `folder` (relative, with forward slashes) last changed before `since`: what was there before the
 * project. Hidden files and tool folders are left out; at most MAX_EXISTING.
 */
export function filesFromBefore(folder: string, since: string): string[] {
  const before = Date.parse(since);
  const found: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_EXISTING) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && depth < 3) walk(join(dir, entry.name), `${rel}/`, depth + 1);
        continue;
      }
      try {
        if (statSync(join(dir, entry.name)).mtimeMs < before) found.push(rel);
      } catch {
        // Gone or unreadable: not listed.
      }
    }
  };
  walk(folder, "", 0);
  return found;
}

/** What the Planner is told about them. */
export function existingForPlanner(files: string[]): string | null {
  if (files.length === 0) return null;
  return [
    `The output folder already has files from before this project: ${files.join(", ")}.`,
    "Don't build on them or plan around them unless the brief asks for that: plan the project the brief describes. A planned file with the same path as one of them replaces it.",
  ].join(" ");
}

/** The planned files that would replace a file from before; for the line under the plan. */
export const replacedBy = (planned: string[], before: string[]): string[] => {
  const old = new Set(before.map((path) => path.toLowerCase()));
  return planned.filter((path) => old.has(path.toLowerCase()));
};

/** The line under a plan that would replace files from before. */
export function replacingLine(paths: string[], auto: boolean): string {
  if (paths.length === 0) return "";
  const list = paths.length <= 1 ? paths[0] : `${paths.slice(0, -1).join(", ")} and ${paths.at(-1)}`;
  return ` ${list} ${paths.length === 1 ? "is" : "are"} already in the folder from before, and ${auto ? "will be" : "would be"} replaced.`;
}

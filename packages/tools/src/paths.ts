import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const within = (root: string, abs: string) => {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Where a path really points, following links and junctions (for a path that doesn't exist yet, its nearest parent). */
function realPath(abs: string): string {
  let rest = "";
  let current = abs;
  for (;;) {
    try {
      return join(realpathSync.native(current), rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs;
      rest = join(basename(current), rest);
      current = parent;
    }
  }
}

/**
 * Resolves a tool path against the bot's folder and says whether it stays inside it, both as written and where it
 * really points: a link or junction inside the folder that leads elsewhere counts as outside.
 */
export function resolvePath(workspace: string, path: string): { abs: string; inside: boolean } {
  const abs = resolve(workspace, path || ".");
  const inside = within(workspace, abs) && within(realPath(workspace), realPath(abs));
  return { abs, inside };
}

/** Path as the bot should see it: relative inside its folder, absolute outside. */
export function displayPath(workspace: string, abs: string): string {
  const rel = relative(workspace, abs);
  return within(workspace, abs) ? (rel || ".").split(sep).join("/") : abs;
}

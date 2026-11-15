import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * @mrog/jobs is plain logic: it may use @mrog/shared and its own files, nothing that reaches the outside world
 * (the harness, store, tools, browser, Node's network or file system, Electron). The harness wires it up.
 */
const ALLOWED = /^(\.{1,2}\/|@mrog\/shared$|zod$|vitest$|node:(fs|path)$)/;
// node:fs and node:path only in tests (this one reads the source files).
const TEST_ONLY = /^node:(fs|path)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("the jobs package boundary", () => {
  it("imports nothing that reaches the outside world", () => {
    const wrong: string[] = [];
    for (const file of files(join(import.meta.dirname))) {
      const test = file.endsWith(".test.ts");
      for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const target = match[1]!;
        if (!ALLOWED.test(target) || (!test && TEST_ONLY.test(target))) wrong.push(`${file}: ${target}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

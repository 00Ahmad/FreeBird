import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * @mrog/visual-qa is plain logic: it may use @mrog/shared and its own files, nothing that reaches the outside world
 * (the harness, browser, child processes, Node's network or file system, Electron). The harness does the wiring.
 */
const ALLOWED = /^(\.{1,2}\/|@mrog\/shared$|vitest$|node:(fs|path)$)/;
const TEST_ONLY = /^node:(fs|path)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("the visual-qa package boundary", () => {
  it("imports nothing that reaches the outside world", () => {
    const wrong: string[] = [];
    for (const file of files(join(import.meta.dirname))) {
      const test = file.endsWith(".test.ts");
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:^|[\s;{}])(?:from|import)\s*\(?\s*["']([^"']+)["']/gm)) {
        const target = match[1]!;
        if (!ALLOWED.test(target) || (!test && TEST_ONLY.test(target))) wrong.push(`${file}: ${target}`);
      }
      if (!test && /\bfetch\(/.test(source)) wrong.push(`${file}: fetch`);
    }
    expect(wrong).toEqual([]);
  });
});

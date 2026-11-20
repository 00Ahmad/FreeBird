import { describe, expect, it } from "vitest";

import type { RunSpec } from "@mrog/visual-qa";

import { filesPrint, quickCheckable } from "./quick";

describe("Visual QA's quick check", () => {
  it("opens a web page always, an app with a server only when its commands may run unasked, a desktop app never", () => {
    const page = { kind: "page", entry: "index.html" } as RunSpec;
    const server = { kind: "server", command: "node server.js", main: "server.js", port: 3000 } as RunSpec;
    const desktop = { kind: "desktop", command: "python app.py", main: "app.py" } as RunSpec;
    const none = { kind: "none" } as RunSpec;
    expect(quickCheckable(page, false)).toBe(true);
    expect(quickCheckable(server, false)).toBe(false);
    expect(quickCheckable(server, true)).toBe(true);
    expect(quickCheckable(desktop, true)).toBe(false);
    expect(quickCheckable(none, true)).toBe(false);
  });

  it("knows when nothing changed since the last check, whatever order the files are listed in", () => {
    const text: Record<string, string> = { "a.js": "1", "b.html": "<p>" };
    const files = (order: string[]) => ({ files: order, read: (path: string) => text[path] ?? null });
    const before = filesPrint(files(["a.js", "b.html"]));
    expect(filesPrint(files(["b.html", "a.js"]))).toBe(before);
    text["a.js"] = "2";
    expect(filesPrint(files(["a.js", "b.html"]))).not.toBe(before);
  });
});

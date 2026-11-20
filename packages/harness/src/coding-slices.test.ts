import { describe, expect, it } from "vitest";

import type { CodingProject } from "@mrog/shared";

import { checkProject, topLevelNames } from "./coding-check";
import { contractFor, readContract } from "./coding-contract";
import { plannerMessage, SMALL_FILES } from "./coding-tools";

/** Small feature files on one page: what each defines is passed on, and names they'd fight over are caught. */

const project = (text: Record<string, string>) => ({
  files: Object.keys(text),
  read: (path: string) => text[path] ?? null,
});

const PAGE = `<ul id="feed"></ul><script src="feed.js"></script><script src="search.js"></script><script src="main.js"></script>`;

describe("names that plain scripts on one page share", () => {
  it("reads what a script declares at its top level, not inside functions, and not var", () => {
    expect(
      topLevelNames(
        "const API = 1;\nlet state = {};\nclass Store {}\nfunction start() {\n  const inner = 2;\n}\nasync function load() {}\nvar again = 1;",
      ),
    ).toEqual(["API", "state", "Store", "start", "load"]);
  });

  it("catches the same top-level const in two scripts on one page", () => {
    const found = checkProject(
      project({
        "index.html": PAGE,
        "feed.js": "const items = [];\nwindow.Feed = { start() {} };",
        "search.js": "const items = [];\nwindow.Search = { start() {} };",
        "main.js": "Feed.start(); Search.start();",
      }),
    );
    expect(found.map((f) => f.problem)).toEqual([
      expect.stringMatching(/^search\.js and feed\.js both declare items at the top level/),
    ]);
    expect(found[0]!.related).toEqual(["feed.js"]);
  });

  it("leaves alone scripts that keep their code inside one name each, modules, var, and scripts on different pages", () => {
    const clean = (text: Record<string, string>) => expect(checkProject(project(text))).toEqual([]);
    clean({
      "index.html": PAGE,
      "feed.js": "window.Feed = (() => { const items = []; return { start() {} }; })();",
      "search.js": "window.Search = (() => { const items = []; return { start() {} }; })();",
      "main.js": "Feed.start(); Search.start();",
    });
    clean({
      "index.html": PAGE,
      "feed.js": "var shared = 1;",
      "search.js": "var shared = 2;",
      "main.js": "",
    });
    clean({
      "a.html": `<script src="one.js"></script>`,
      "b.html": `<script src="two.js"></script>`,
      "one.js": "const x = 1;",
      "two.js": "const x = 2;",
    });
  });

  it("tells main.js what each feature script defines", () => {
    const contract = readContract(
      project({
        "index.html": PAGE,
        "feed.js": "window.Feed = (() => ({ start() {} }))();",
        "search.js": "function startSearch() {}",
      }),
    );
    const text = contractFor("main.js", contract)!;
    expect(text).toContain("- feed.js defines (shared with the page's other scripts): Feed");
    expect(text).toContain("- search.js defines (shared with the page's other scripts): startSearch");
  });
});

describe("what the Planner is asked for", () => {
  it("asks for small files, one feature each, each keeping its code inside one name", () => {
    const text = plannerMessage({
      brief: "x",
      outputFolder: "/out",
      nodes: [],
      edges: [],
    } as unknown as CodingProject);
    expect(text).toContain(SMALL_FILES);
    expect(SMALL_FILES).toContain("one feature per file, under about 150 lines");
    expect(SMALL_FILES).toContain("window.Feed = (() => {");
  });
});

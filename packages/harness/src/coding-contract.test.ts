import { afterEach, describe, expect, it } from "vitest";

import { checkProject } from "./coding-check";
import { buildOrder, contractFor, duplicateIds, kindOf, readContract } from "./coding-contract";
import { fileCardsFor } from "./coding-plan";
import { cleanTmp, codingTeam, makeCoding, tmp, turnsOf, type, until } from "./coding-testing";
import { auth, makeHarness, type TestHarness } from "./testing";

const project = (text: Record<string, string>) => ({
  files: Object.keys(text),
  read: (path: string) => text[path] ?? null,
});

describe("build order", () => {
  it("puts data first, then pages, scripts, styles and docs, keeping the Planner's order within each", () => {
    const planned = [
      "README.md",
      "style.css",
      "app.js",
      "index.html",
      "api-config.js",
      "about.html",
      "data.json",
    ];
    expect(buildOrder(planned, (path) => path)).toEqual([
      "api-config.js",
      "data.json",
      "index.html",
      "about.html",
      "app.js",
      "style.css",
      "README.md",
    ]);
  });

  it("keeps a command-line tool's scripts in the Planner's order", () => {
    expect(buildOrder(["src/math.js", "src/args.js", "src/main.js"], (path) => path)).toEqual([
      "src/math.js",
      "src/args.js",
      "src/main.js",
    ]);
  });

  it("is the order of a new board's cards", () => {
    const nodes = [
      { id: "n1", path: "style.css", purpose: "" },
      { id: "n2", path: "app.js", purpose: "" },
      { id: "n3", path: "index.html", purpose: "" },
    ];
    expect(fileCardsFor(nodes).map((card) => card.title)).toEqual(["index.html", "app.js", "style.css"]);
  });

  it("tells files apart by name", () => {
    expect(
      ["index.html", "a.css", "src/app.ts", "config.js", "settings.py", "x.json", "README.md"].map(kindOf),
    ).toEqual(["page", "style", "script", "data", "data", "data", "other"]);
  });
});

const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>
<!-- <div id="old"></div> -->
<ul id="list" class="tasks big"></ul><button id="add" class="btn">Add</button>
<template><li id="row" class="task"></li></template>
<script type="module" src="app.js"></script></body></html>`;
const SCRIPT = `import { add } from "./math.js";
const list = document.getElementById("list");
document.querySelector("#add").addEventListener("click", () => {
  const li = document.createElement("li");
  li.className = "task done";
  li.classList.add("fresh");
  list.innerHTML += '<span class="label">x</span>';
});
export function start() {}`;
const MATH = `export function add(a, b) { return a + b; }\nexport const PI = 3;`;
const STYLE = `/* .ignored {} */\n.tasks .task { color: #fff; background: url(img/a.png); }\n#add:hover { margin: .5em; }\n@media (max-width: 600px) { .btn { width: 100%; } }`;

describe("the contract, read from the code", () => {
  const contract = readContract(
    project({ "index.html": PAGE, "app.js": SCRIPT, "math.js": MATH, "style.css": STYLE }),
  );

  it("reads a page's ids, classes and what it loads, not from comments, scripts or templates", () => {
    const page = contract.files.get("index.html")!;
    expect(page.ids).toEqual(["list", "add"]);
    expect(page.classes).toEqual(["tasks", "big", "btn"]);
    expect(page.loads).toEqual(["style.css", "app.js"]);
  });

  it("reads what a script looks up, uses, creates, exports and imports", () => {
    const script = contract.files.get("app.js")!;
    expect(script.ids.toSorted()).toEqual(["add", "list"]);
    expect(script.classes.toSorted()).toEqual(["done", "fresh", "label", "task"]);
    expect(script.exports).toEqual(["start"]);
    expect(script.imports).toEqual([{ from: "math.js", names: ["add"] }]);
  });

  it("reads a stylesheet's selectors, not its values or comments", () => {
    const style = contract.files.get("style.css")!;
    expect(style.classes.toSorted()).toEqual(["btn", "task", "tasks"]);
    expect(style.ids).toEqual(["add"]);
  });

  it("links the files the way the code does: directed and typed", () => {
    expect(contract.links).toEqual([
      { from: "index.html", to: "style.css", kind: "loads", names: [] },
      { from: "index.html", to: "app.js", kind: "loads", names: [] },
      { from: "app.js", to: "math.js", kind: "imports", names: ["add"] },
    ]);
  });

  it("tells a script the ids and classes of the page that loads it, and what other scripts export", () => {
    const text = contractFor("app.js", contract)!;
    expect(text).toMatch(/^Exact names, read from the code .* the code is right:/);
    expect(text).toContain("- index.html has the ids: #list, #add");
    expect(text).toContain("- index.html uses the classes: .tasks, .big, .btn");
    expect(text).toContain("- math.js exports: add, PI");
  });

  it("tells a stylesheet the classes the scripts create, so it can style them too", () => {
    const text = contractFor("style.css", contract)!;
    expect(text).toContain("- index.html has the ids: #list, #add");
    expect(text).toContain("- app.js uses or creates the classes:");
    expect(text).toContain(".fresh");
  });

  it("tells a page what the scripts look up", () => {
    expect(contractFor("index.html", contract)).toContain("- app.js looks up the ids: ");
  });

  it("says nothing when nothing around the file is written yet", () => {
    expect(contractFor("app.js", readContract(project({ "app.js": SCRIPT })))).toBeNull();
  });

  it("keeps each list short", () => {
    const many = `<body>${Array.from({ length: 50 }, (_, n) => `<p id="p${n}"></p>`).join("")}<script src="a.js"></script></body>`;
    const text = contractFor("a.js", readContract(project({ "index.html": many, "a.js": "" })), 5)!;
    expect(text).toContain("#p0, #p1, #p2, #p3, #p4 and 45 more");
  });
});

describe("what a file that isn't written yet must export", () => {
  const MAIN = `import { add, PI } from "./math.js";\nconsole.log(add(1, PI));`;

  it("is what the files already written import from it, until it exists", () => {
    const before = contractFor(
      "math.js",
      readContract(project({ "main.js": MAIN, "math.js": null as never })),
    );
    expect(before).toContain("- main.js imports from this file: add, PI (export exactly these names)");
  });

  it("is no longer said once it is written: the file written first is the contract, and the importer adapts", () => {
    const both = readContract(project({ "main.js": MAIN, "math.js": "export function add() {}" }));
    expect(contractFor("math.js", both) ?? "").not.toContain("imports from this file");
    expect(contractFor("main.js", both)).toContain("- math.js exports: add");
  });

  it("includes what a settings file that is code exports", () => {
    const text = contractFor(
      "app.js",
      readContract(project({ "api-config.js": "export const API_KEY = 'YOUR_API_KEY_HERE';", "app.js": "" })),
    );
    expect(text).toContain("- api-config.js exports: API_KEY");
  });

  it("reads CommonJS: module.exports, exports.x and destructured require", () => {
    const contract = readContract(
      project({
        "src/math.js":
          "function add(a, b) { return a + b; }\nmodule.exports = { add, sub: (a, b) => a - b };\nexports.PI = 3;",
        "src/main.js": "const { add, PI } = require('./math');\nconst args = require('./args.js');",
        "src/args.js": "exports.parseNumbers = (list) => list.map(Number);",
      }),
    );
    expect(contract.files.get("src/math.js")!.exports!.toSorted()).toEqual(["PI", "add", "sub"]);
    expect(contract.files.get("src/main.js")!.imports).toEqual([
      { from: "src/math.js", names: ["add", "PI"] },
      { from: "src/args.js", names: [] },
    ]);
    expect(contractFor("src/main.js", contract)).toContain("- src/args.js exports: parseNumbers");
  });
});

describe("duplicate ids", () => {
  it("flags an id written twice on one page", () => {
    expect(duplicateIds(`<div id="a"></div><span id="a"></span><p id="b"></p>`)).toEqual(["a"]);
    const found = checkProject(project({ "index.html": `<div id="item"></div><div id="item"></div>` }));
    expect(found.map((f) => f.problem)).toEqual([
      expect.stringContaining('index.html has id="item" on more than one element'),
    ]);
  });

  it("leaves alone comments, templates, scripts and the same id on two pages", () => {
    expect(duplicateIds(`<div id="a"></div><!-- <div id="a"></div> -->`)).toEqual([]);
    expect(duplicateIds(`<div id="a"></div><template><div id="a"></div></template>`)).toEqual([]);
    expect(duplicateIds(`<div id="a"></div><script>el.innerHTML = '<div id="a"></div>';</script>`)).toEqual(
      [],
    );
    expect(
      checkProject(project({ "a.html": `<main id="main"></main>`, "b.html": `<main id="main"></main>` })),
    ).toEqual([]);
  });
});

describe("a run in build order, with the exact names passed on", () => {
  let h: TestHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
    cleanTmp();
  });

  it("builds the page, then the script, then the styles, each told the names the others have", async () => {
    const plan = {
      nodes: [
        { path: "style.css", purpose: "the look" },
        { path: "app.js", purpose: "adds tasks" },
        { path: "index.html", purpose: "the page" },
      ],
      edges: [{ files: ["index.html", "app.js"], description: "the page loads the script" }],
    };
    const team = codingTeam({
      plans: [{ tool: plan }],
      develop: (card) => ({
        write:
          card.key === "index.html"
            ? '<ul id="list" class="tasks"></ul><button id="add">Add</button><link rel="stylesheet" href="style.css"><script src="app.js"></script>'
            : card.key === "app.js"
              ? 'document.getElementById("add").addEventListener("click", () => { const li = document.createElement("li"); li.className = "task"; document.getElementById("list").append(li); });'
              : ".tasks .task { color: red; }",
      }),
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "A task list");
    await until(h, bot.id, (p) => p.status === "done");

    const developed = turnsOf(team, "developer");
    expect(developed.map((s) => /^File: (.+)$/m.exec(s.task)![1])).toEqual([
      "index.html",
      "app.js",
      "style.css",
    ]);
    const script = developed[1]!.task;
    expect(script).toContain("Exact names, read from the code of the files already written");
    expect(script).toContain("- index.html has the ids: #list, #add");
    const style = developed[2]!.task;
    expect(style).toContain("- app.js uses or creates the classes: .task (style these too)");
    // The diagram's connections, read from the code: the page loads the stylesheet and the script.
    const done = h.services.coding.get(bot.id)!;
    const id = (path: string) => done.nodes.find((node) => node.path === path)!.id;
    expect(done.codeLinks).toEqual([
      { id: "c1", files: [id("index.html"), id("style.css")], description: "index.html loads style.css" },
      { id: "c2", files: [id("index.html"), id("app.js")], description: "index.html loads app.js" },
    ]);
    // A new plan clears them: its file ids may mean other files.
    const replaced = await h.app.inject({
      method: "POST",
      url: `/api/bots/${bot.id}/coding/import`,
      headers: auth,
      payload: { plan, replace: true },
    });
    expect(replaced.json().project.codeLinks).toBeUndefined();
    // QA is told the same names, to check against the code.
    expect(turnsOf(team, "qa").find((s) => s.task.includes("File: app.js"))!.task).toContain(
      "- index.html has the ids: #list, #add",
    );
  });
});

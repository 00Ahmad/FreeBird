import { afterEach, describe, expect, it } from "vitest";

import { ownFindings, selfCheck, syntaxProblem } from "./coding-selfcheck";
import { cleanTmp, codingTeam, makeCoding, tmp, type, until } from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const project = (text: Record<string, string | null>) => ({
  files: Object.keys(text),
  read: (path: string) => text[path] ?? null,
});

describe("whether a file parses", () => {
  it("finds a syntax error and its line in a script or a module, and broken JSON", () => {
    expect(syntaxProblem("a.js", "ok();\nbroken(;\n")).toBe(
      "a.js doesn't parse: Unexpected token ';' at line 2.",
    );
    expect(syntaxProblem("m.js", "import { a } from './b.js';\nexport const y = {;\n")).toMatch(
      /at line 2\.$/,
    );
    expect(syntaxProblem("x.json", '{"a": 1,}')).toMatch(/^x\.json is not valid JSON/);
  });

  it("passes good code, top-level await, re-exports and import.meta", () => {
    for (const [path, text] of [
      ["a.js", "const x = 1;\nfunction f() { return x; }"],
      ["m.js", "import { a } from './b.js';\nexport default a;\nconst r = await fetch('x');"],
      ["m.js", "export { a } from './c.js';\nexport * from './d.js';\nconsole.log(import.meta.url);"],
      ["x.json", '{"a": 1}'],
      ["notes.md", "anything at all {"],
    ])
      expect(syntaxProblem(path!, text!), text).toBeNull();
  });
});

describe("what a file's own check reports", () => {
  it("leaves out what is about a file not written yet: a page written first loads a script still to come", () => {
    const files = project({ "index.html": '<script src="app.js"></script>', "app.js": null });
    expect(selfCheck("index.html", files)).toEqual([]);
  });

  it("leaves a page's cross-file problem to the QA pass, but keeps a script's own", () => {
    const files = project({ "index.html": "", "app.js": "" });
    const findings = [
      { file: "index.html", problem: "“Add” does nothing", related: ["app.js"] },
      { file: "app.js", problem: "TypeError in app.js", related: ["index.html"] },
    ];
    expect(ownFindings("index.html", findings, files)).toEqual([]);
    expect(ownFindings("app.js", findings, files).map((f) => f.problem)).toEqual(["TypeError in app.js"]);
  });

  it("reports what the code check finds in the file itself", () => {
    const files = project({
      "index.html": '<ul id="list"></ul>',
      "app.js": 'document.getElementById("lst").textContent = "x";',
    });
    expect(selfCheck("app.js", files)).toEqual([
      'app.js looks for the element with id "lst", but no page in the project has id="lst".',
    ]);
  });
});

describe("a Developer that writes code that doesn't parse", () => {
  it("is told at finish_card with the line, fixes it, and QA gets working code", async () => {
    const ONE = { nodes: [{ path: "app.js", purpose: "a script" }], edges: [] };
    const team = codingTeam({
      plans: [{ tool: ONE }],
      develop: (_card, attempt) => ({ write: attempt === 1 ? "start(;\n" : "start();\n" }),
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "A script");
    const done = await until(h, bot.id, (p) => p.status === "done");
    const told = team.seen.filter((s) => s.role === "developer").map((s) => s.lastTool);
    expect(told).toContainEqual(
      expect.stringContaining("- app.js doesn't parse: Unexpected token ';' at line 1."),
    );
    // Fixed on its own card: QA passed it the first time it looked.
    expect(done.cards[0]!.comments.filter((c) => c.author === "qa" && c.kind === "fail")).toEqual([]);
    expect(done.round).toBe(1);
  });
});

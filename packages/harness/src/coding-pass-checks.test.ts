import { describe, expect, it } from "vitest";

import type { CodingCard, CodingProject } from "@mrog/shared";

import { checkProject } from "./coding-check";
import { passChecks, type PassCheckDeps } from "./coding-pass-checks";
import type { Finding } from "./coding-check";

const card = (id: string, title: string, column: CodingCard["column"] = "qa"): CodingCard => ({
  id,
  kind: "file",
  ref: id,
  title,
  column,
  comments: [],
});

/** A project with a page and a script, and checks wired to plain fakes that record what they were asked. */
function setup(text: Record<string, string>, visualQa = false) {
  const project = {
    botId: "bot",
    status: "qa",
    outputFolder: "/out",
    visualQa,
    autoApprove: true,
    round: 0,
    brief: "",
    roles: { planner: { botId: "p" }, developer: { botId: "d" }, qa: { botId: "q" } },
    nodes: [
      { id: "n1", path: "index.html", purpose: "" },
      { id: "n2", path: "app.js", purpose: "" },
    ],
    edges: [],
    cards: [card("n1", "index.html"), card("n2", "app.js")],
  } as unknown as CodingProject;
  const sent: string[] = [];
  const notes: string[] = [];
  let opened = 0;
  let appFindings: Finding[] = [];
  const deps: PassCheckDeps = {
    project: () => project,
    files: () => ({ files: ["index.html", "app.js"], read: (path) => text[path] ?? null }),
    cardsFor: (p, file, related = []) => p.cards.filter((c) => [file, ...related].includes(c.title)),
    sendBack: (_bot, items) => {
      for (const item of items) sent.push(`${item.card.title}: ${item.text}`);
      return new Set(items.map((item) => item.card.id)).size;
    },
    note: (_bot, line) => notes.push(line),
    openApp: async () => {
      opened += 1;
      return { findings: appFindings, error: null };
    },
    commandsAllowed: () => true,
  };
  return {
    project,
    sent,
    notes,
    checks: passChecks(deps),
    opened: () => opened,
    appFinds: (findings: Finding[]) => (appFindings = findings),
  };
}

const PAGE = `<!doctype html><html><body><button id="go">Go</button><script src="app.js"></script></body></html>`;
const MISSING = `<!doctype html><html><body><script src="nope.js"></script><script src="app.js"></script></body></html>`;

describe("the checks at the start of every QA pass", () => {
  it("send what the code check finds straight to its card", async () => {
    const t = setup({ "index.html": MISSING, "app.js": "console.log(1);\n" });
    expect(await t.checks.run("bot", new AbortController().signal)).toBe(1);
    expect(t.sent[0]).toMatch(/^index\.html: Code check: index\.html loads nope\.js/);
  });

  it("check again next pass when they found something, even if nothing changed", async () => {
    const t = setup({ "index.html": MISSING, "app.js": "console.log(1);\n" });
    await t.checks.run("bot", new AbortController().signal);
    // The Developer "finished" without changing anything: the problem is still there and is sent again.
    await t.checks.run("bot", new AbortController().signal);
    expect(t.sent).toHaveLength(2);
  });

  it("skip a check that came back clean until a file changes", async () => {
    const text = { "index.html": PAGE, "app.js": "console.log(1);\n" };
    const t = setup(text, true);
    await t.checks.run("bot", new AbortController().signal);
    await t.checks.run("bot", new AbortController().signal);
    expect(t.opened()).toBe(1);
    text["app.js"] = "console.log(2);\n";
    await t.checks.run("bot", new AbortController().signal);
    expect(t.opened()).toBe(2);
  });

  it("open the app again next pass after Visual QA's quick check found a problem", async () => {
    const t = setup({ "index.html": PAGE, "app.js": "console.log(1);\n" }, true);
    t.appFinds([{ file: "app.js", problem: "The page shows an error in the browser console: TypeError" }]);
    await t.checks.run("bot", new AbortController().signal);
    await t.checks.run("bot", new AbortController().signal);
    expect(t.opened()).toBe(2);
    expect(t.sent).toEqual([
      "app.js: Visual QA: The page shows an error in the browser console: TypeError",
      "app.js: Visual QA: The page shows an error in the browser console: TypeError",
    ]);
  });

  it("leave Visual QA's quick check out when Visual QA is off", async () => {
    const t = setup({ "index.html": PAGE, "app.js": "console.log(1);\n" }, false);
    await t.checks.run("bot", new AbortController().signal);
    expect(t.opened()).toBe(0);
  });

  it("do nothing while no card waits for QA", async () => {
    const t = setup({ "index.html": MISSING, "app.js": "" });
    for (const c of t.project.cards) c.column = "done";
    expect(await t.checks.run("bot", new AbortController().signal)).toBe(0);
    expect(t.sent).toEqual([]);
  });
});

describe("the key check", () => {
  const SCRIPT = `const API_KEY = "a8f3k29dk3l2m4n5b6v7c8x9z0q1w2e3";\n`;
  const input = (given?: string) => ({
    files: ["app.js"],
    read: (path: string) => (path === "app.js" ? SCRIPT : null),
    ...(given === undefined ? {} : { given }),
  });

  it("flags a key that looks made up", () => {
    expect(checkProject(input()).map((f) => f.problem)).toEqual([
      expect.stringContaining("looks like a real key"),
    ]);
  });

  it("leaves alone a key the user gave in the brief", () => {
    expect(checkProject(input("Use my key a8f3k29dk3l2m4n5b6v7c8x9z0q1w2e3 for the API."))).toEqual([]);
  });
});

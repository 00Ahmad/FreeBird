import { afterEach, describe, expect, it } from "vitest";

import { lineDiff, linkedTo, providedBy } from "./coding-changes";
import { readContract } from "./coding-contract";
import { cleanTmp, codingTeam, makeCoding, tmp, turnsOf, type, until } from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

describe("what changed in a file", () => {
  it("shows the changed lines with a little context, headed by where they are", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "b", "c", "D", "e", "f", "g", "h"].join("\n");
    expect(lineDiff(before, after)).toBe(
      ["@@ around line 2 @@", "  b", "  c", "- d", "+ D", "  e", "  f", "  g", "+ h"].join("\n"),
    );
  });

  it("says nothing changed, or that it was rewritten when the change is too big to show", () => {
    expect(lineDiff("same", "same")).toBe("");
    const many = (prefix: string) => Array.from({ length: 200 }, (_, n) => `${prefix}${n}`).join("\n");
    expect(lineDiff(many("a"), many("b"))).toBeNull();
  });
});

describe("what a file provides", () => {
  const read = (text: Record<string, string>) =>
    readContract({ files: Object.keys(text), read: (p) => text[p] ?? null });

  it("changes when its ids or exports change, not when only its other code does", () => {
    const one = read({ "index.html": '<ul id="list"></ul><p>hi</p>' }).files.get("index.html");
    const sameIds = read({ "index.html": '<ul id="list"></ul><p>hello</p>' }).files.get("index.html");
    const newId = read({ "index.html": '<ul id="list"></ul><p id="note">hi</p>' }).files.get("index.html");
    expect(providedBy(one)).toBe(providedBy(sameIds));
    expect(providedBy(one)).not.toBe(providedBy(newId));
  });

  it("links a file to those it loads or imports and those that load or import it", () => {
    const contract = read({
      "index.html": '<script src="app.js"></script>',
      "app.js": "import { x } from './lib.js';",
      "lib.js": "export const x = 1;",
    });
    expect(linkedTo("app.js", contract.links).toSorted()).toEqual(["index.html", "lib.js"]);
  });
});

describe("a fix that changes what a page provides", () => {
  it("shows QA what changed since its last review, and checks the script that relies on the page again", async () => {
    const PAIR = {
      nodes: [
        { path: "index.html", purpose: "the page" },
        { path: "app.js", purpose: "fills the list" },
      ],
      edges: [{ files: ["index.html", "app.js"], description: "the page loads the script" }],
    };
    const team = codingTeam({
      plans: [{ tool: PAIR }],
      develop: (card, attempt) => ({
        write:
          card.key === "index.html"
            ? attempt === 1
              ? '<ul id="list"></ul>\n<script src="app.js"></script>\n'
              : '<ul id="list"></ul>\n<p id="empty">No tasks yet</p>\n<script src="app.js"></script>\n'
            : 'document.getElementById("list").textContent = "x";\n',
      }),
      review: (card, nth) =>
        card.key === "index.html" && nth === 1
          ? { pass: false, comment: "say when the list is empty" }
          : { pass: true },
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "A task list");
    const done = await until(h, bot.id, (p) => p.status === "done");

    // QA's second look at the page: the lines that changed, next to the comment that asked for them.
    const second = turnsOf(team, "qa").filter((s) => s.task.includes("File: index.html"))[1]!.task;
    expect(second).toContain("What changed in index.html since you last reviewed it");
    expect(second).toContain('+ <p id="empty">No tasks yet</p>');
    expect(second).toContain("say when the list is empty");
    // The page now has a new id, so the script, which had passed, is checked against it again.
    expect(done.log!.map((l) => l.text)).toContain(
      "index.html changed what it provides; app.js goes back to QA",
    );
    expect(turnsOf(team, "qa").filter((s) => s.task.includes("File: app.js"))).toHaveLength(2);
  });
});

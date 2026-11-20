import { describe, expect, it } from "vitest";

import type { CodingProject } from "@mrog/shared";

import { DONE_GUIDANCE, doneFiles, doneLines, readDone } from "./coding-done";
import { validatePlan } from "./coding-plan";
import { cardSpec, plannerMessage, proposePlanTool, type TurnCapture } from "./coding-tools";

describe("the plan's done checks", () => {
  it("keeps checks written in the forms, tidied, and has none when none were given", () => {
    expect(readDone(undefined, "x")).toEqual({ errors: [] });
    expect(readDone([], "x")).toEqual({ errors: [] });
    expect(readDone(["  #list   has items "], "x")).toEqual({ done: ["#list has items"], errors: [] });
    expect(readDone("#list has items", "x")).toEqual({ done: ["#list has items"], errors: [] });
  });

  it("turns down checks that aren't in the forms, too many, or not a list, saying which", () => {
    const wrong = readDone(["#list has items", "the page looks nice"], 'nodes[0] "app.js"');
    expect(wrong.done).toEqual(["#list has items"]);
    expect(wrong.errors).toEqual([
      expect.stringMatching(
        /^nodes\[0\] "app\.js": done check 2: “the page looks nice” isn't one of the forms/,
      ),
    ]);
    expect(
      readDone(["#a has items", "#b has items", "#c has items", "#d has items"], "x").errors[0],
    ).toContain("4 done checks; give at most 3");
    expect(readDone({ check: "#a has items" }, "x").errors[0]).toContain('"done" must be a list of checks');
  });

  it("is part of the plan, and a check written wrong is left out, never costing the plan", async () => {
    const ok = validatePlan({
      nodes: [
        { path: "index.html", purpose: "The page." },
        {
          path: "app.js",
          purpose: "Fills the list.",
          done: ["#list has items", "click #add -> #list changes"],
        },
      ],
      edges: [],
    });
    expect(ok.ok && ok.nodes.map((node) => node.done)).toEqual([
      undefined,
      ["#list has items", "click #add -> #list changes"],
    ]);
    const bad = validatePlan({
      nodes: [{ path: "app.js", purpose: "Fills the list.", done: ["list should fill", "#list has items"] }],
      edges: [],
    });
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.nodes[0]!.done).toEqual(["#list has items"]);
    expect(bad.dropped).toEqual([
      expect.stringContaining("done check 1: “list should fill” isn't one of the forms"),
    ]);
    // The Planner is told what was left out, and that it needn't send the plan again.
    const capture = {} as TurnCapture;
    const answer = (await proposePlanTool(capture).run(
      { nodes: [{ path: "app.js", purpose: "Fills the list.", done: ["list should fill"] }], edges: [] },
      {} as never,
    )) as string;
    expect(answer).toMatch(/^Plan accepted: 1 files, 0 connections\. These done checks were left out/);
    expect(answer).toContain("- nodes[0]");
    expect(capture.plan?.nodes[0]!.done).toBeUndefined();
  });

  it("is shown on the card, saying whether the browser runs it, and the Planner is told how to write them", () => {
    const project = (visualQa: boolean) =>
      ({
        brief: "A to-do list",
        outputFolder: "/out",
        visualQa,
        nodes: [{ id: "n1", path: "app.js", purpose: "Fills the list.", done: ["#list has items"] }],
        edges: [],
        cards: [],
      }) as unknown as CodingProject;
    const card = { id: "c", kind: "file", ref: "n1", title: "app.js" } as never;
    expect(cardSpec(project(true), card)).toContain(
      "app.js is done when (the browser checks these on the page; they must pass):\n- #list has items",
    );
    expect(cardSpec(project(false), card)).toContain(
      "app.js is done when these hold on the page (Visual QA is off, so nothing runs them: check them in the code):\n- #list has items",
    );
    expect(plannerMessage(project(true))).toContain(DONE_GUIDANCE);
    // A short plan (after two were turned down) leaves done checks out: one thing less to get wrong.
    expect(plannerMessage(project(true), { short: true })).not.toContain(DONE_GUIDANCE);
    expect(doneLines({ path: "a.css" }, true)).toBeNull();
  });

  it("runs only the written files' checks, or one file's", () => {
    const nodes = [
      { path: "app.js", done: ["#list has items"] },
      { path: "search.js", done: ["#q has items"] },
      { path: "style.css" },
    ];
    expect(doneFiles(nodes, (path) => path !== "search.js")).toEqual([
      { file: "app.js", checks: ["#list has items"] },
    ]);
    expect(doneFiles(nodes, () => true, "SEARCH.js")).toEqual([
      { file: "search.js", checks: ["#q has items"] },
    ]);
  });
});

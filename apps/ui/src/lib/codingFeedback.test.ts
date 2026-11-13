import { describe, expect, it } from "vitest";

import { CodingStatus } from "@mrog/shared";

import { comment, connectorCard, edge, fileCard, node, project } from "./codingFixture";
import {
  activeRole,
  cardLabel,
  cardProgress,
  diagramMarks,
  emptyPlanText,
  NO_MARK,
  recentLog,
  roundFailures,
  roundSummary,
  statusBanner,
  workingStrip,
} from "./codingFeedback";

const nodes = [node("a", "src/a.ts"), node("b", "src/b.ts")];
const edges = [edge("x", ["a", "b"], "a calls b")];

describe("who is working", () => {
  it("shows the three roles, and only the active one highlighted, with its card", () => {
    const p = project({
      nodes,
      edges,
      cards: [fileCard("a", "in_progress")],
      active: { role: "developer", cardId: "card-a" },
    });
    expect(workingStrip(p)).toEqual([
      { role: "planner", label: "Planner", active: false, work: null },
      { role: "developer", label: "Developer", active: true, work: "src/a.ts" },
      { role: "qa", label: "QA", active: false, work: null },
    ]);
  });

  it("names a connector's card by its label and description", () => {
    const p = project({ nodes, edges, cards: [connectorCard("x", "qa")] });
    expect(cardLabel(p, "card-x")).toBe("e1: a calls b");
  });

  it("highlights nobody when nobody is working", () => {
    for (const status of ["setup", "awaiting_approval", "needs_you", "done", "stopped", "error"] as const)
      expect(
        workingStrip(project({ status })).some((chip) => chip.active),
        status,
      ).toBe(false);
  });

  it("falls back to the role the status belongs to when the server sends none", () => {
    expect(activeRole({ status: "planning", active: undefined })).toBe("planner");
    expect(activeRole({ status: "developing", active: null })).toBe("developer");
    expect(activeRole({ status: "qa", active: undefined })).toBe("qa");
    // The server's word wins.
    expect(activeRole({ status: "developing", active: { role: "qa", cardId: null } })).toBe("qa");
  });

  it("has no card for a role between cards, or a card the plan lost", () => {
    const between = project({ nodes, cards: [fileCard("a")], active: { role: "qa", cardId: null } });
    expect(workingStrip(between)[2]).toMatchObject({ active: true, work: null });
    expect(cardLabel(between, "nope")).toBeNull();
  });
});

describe("progress", () => {
  it("counts the cards in Done", () => {
    const cards = [fileCard("a", "done"), fileCard("b", "qa"), connectorCard("x", "done")];
    expect(cardProgress({ cards })).toEqual({ done: 2, total: 3, percent: 67, text: "2 of 3 cards done" });
  });

  it("is empty before there is a plan, and full when all pass", () => {
    expect(cardProgress({ cards: [] })).toEqual({ done: 0, total: 0, percent: 0, text: "0 of 0 cards done" });
    expect(cardProgress({ cards: [fileCard("a", "done")] })).toMatchObject({
      percent: 100,
      text: "1 of 1 card done",
    });
  });

  // The server numbers a round's comments by the round in progress: while QA checks round 3, `round` is 2.
  const cards = [
    fileCard("a", "todo", [comment("qa", "bad", undefined, 2)]),
    fileCard("b", "todo", [comment("qa", "old", undefined, 1)]),
    fileCard("c", "qa", [comment("developer", "fixed", undefined, 2)]),
    fileCard("d", "todo", [comment("qa", "one", undefined, 2), comment("qa", "two", undefined, 2)]),
    fileCard("e", "todo", [comment("qa", "now", undefined, 3)]),
  ];

  it("counts the cards the last finished round sent back, when nobody is checking", () => {
    expect(roundFailures({ cards, round: 2, status: "developing" })).toBe(2);
    expect(roundFailures({ cards, round: 1, status: "needs_you" })).toBe(1);
    expect(roundFailures({ cards, round: 0, status: "developing" })).toBe(0);
  });

  it("counts the cards failed so far in the round QA is checking", () => {
    expect(roundFailures({ cards, round: 2, status: "qa" })).toBe(1);
    expect(roundFailures({ cards, round: 0, status: "qa" })).toBe(1);
  });

  it("words the round with its failures", () => {
    const base = { maxRounds: 5, cards };
    expect(roundSummary({ ...base, round: 2, status: "developing" })).toBe(
      "Round 3 of 5 · 2 cards failed in the last round",
    );
    expect(roundSummary({ ...base, round: 2, status: "qa" })).toBe("Round 3 of 5 · 1 card failed so far");
    expect(roundSummary({ ...base, cards: [fileCard("a")], round: 2, status: "developing" })).toBe(
      "Round 3 of 5",
    );
    expect(roundSummary({ ...base, cards: [], round: 0, status: "planning" })).toBe("Up to 5 QA rounds");
    expect(roundSummary({ maxRounds: 3, cards, round: 3, status: "needs_you" })).toBe(
      "Round limit reached · 1 card failed in the last round",
    );
  });
});

describe("the status banner", () => {
  const base = project({ cards: [fileCard("a", "done"), fileCard("b", "todo")] });

  it("has a tone, an icon and a line for every status", () => {
    for (const status of CodingStatus.options) {
      const banner = statusBanner({ ...base, status });
      expect(banner.line.length, status).toBeGreaterThan(5);
      expect(banner.icon, status).toBeTruthy();
    }
  });

  it("tells the user what to do when it is their turn", () => {
    expect(statusBanner({ ...base, status: "setup" }).next).toMatch(/chat/);
    expect(statusBanner({ ...base, status: "awaiting_approval" })).toMatchObject({
      tone: "wait",
      line: "Plan ready: approve it or ask for changes.",
      next: "Look it over, then press Approve.",
    });
    expect(statusBanner({ ...base, status: "awaiting_approval", autoApprove: true }).next).toMatch(
      /Auto-approve is on/,
    );
    expect(statusBanner({ ...base, status: "needs_you" })).toMatchObject({
      tone: "wait",
      line: "Round limit reached: 1 card still to pass.",
    });
    expect(statusBanner({ ...base, status: "stopped" }).next).toMatch(/Resume/);
    expect(statusBanner({ ...base, status: "error", error: "boom" })).toMatchObject({
      tone: "bad",
      next: expect.stringMatching(/Resume/),
    });
  });

  it("asks nothing while the team is working", () => {
    for (const status of ["planning", "developing", "qa"] as const)
      expect(statusBanner({ ...base, status })).toMatchObject({ tone: "busy", next: null });
  });

  it("says where the files are when it is finished", () => {
    expect(statusBanner({ ...base, status: "done" })).toMatchObject({
      tone: "ok",
      icon: "check",
      next: "The files are in C:\\Projects\\app.",
    });
  });

  it("has words for an empty view in every status", () => {
    for (const status of CodingStatus.options)
      for (const what of ["diagram", "board", "checklist"] as const)
        expect(emptyPlanText(status, what).length, `${status} ${what}`).toBeGreaterThan(10);
    expect(emptyPlanText("planning", "board")).toMatch(/Planner/);
    expect(emptyPlanText("setup", "diagram")).toMatch(/Describe/);
  });
});

describe("diagram marks", () => {
  const sample = (over: Partial<Parameters<typeof project>[0]> = {}) =>
    project({
      status: "developing",
      nodes: [...nodes, node("c", "src/c.ts"), node("d", "src/d.ts")],
      edges: [...edges, edge("y", ["b", "c"]), edge("z", ["c", "d"])],
      cards: [
        fileCard("a", "in_progress"),
        fileCard("b", "todo", [comment("qa", "missing error handling")]),
        fileCard("c", "done"),
        fileCard("d", "qa"),
        connectorCard("x", "in_progress"),
        connectorCard("y", "qa"),
        connectorCard("z", "done"),
      ],
      ...over,
    });

  it("colours a node by its card's column", () => {
    const marks = diagramMarks(sample());
    expect(["a", "b", "c", "d"].map((id) => marks.get(id)!.column)).toEqual([
      "in_progress",
      "todo",
      "done",
      "qa",
    ]);
  });

  it("rings the card being worked on while the team is busy", () => {
    const marks = diagramMarks(sample({ active: { role: "qa", cardId: "card-d" } }));
    expect(marks.get("a")!.working).toBe(true); // in progress
    expect(marks.get("d")!.working).toBe(true); // QA is on it
    expect(marks.get("b")!.working).toBe(false);
    expect(marks.get("c")!.working).toBe(false);
  });

  it("stops the ring when nothing is running", () => {
    for (const status of ["stopped", "needs_you", "awaiting_approval", "done", "error"] as const)
      expect(diagramMarks(sample({ status })).get("a")!.working, status).toBe(false);
  });

  it("marks a card QA sent back and ticks a finished one", () => {
    const marks = diagramMarks(sample());
    expect(marks.get("b")).toMatchObject({ sentBack: true, done: false });
    expect(marks.get("c")).toMatchObject({ sentBack: false, done: true });
    expect(marks.get("a")).toMatchObject({ sentBack: false, done: false });
  });

  it("lights a junction only while its connector is in progress or in QA", () => {
    const marks = diagramMarks(sample());
    expect(marks.get("x")!.lit).toBe(true);
    expect(marks.get("y")!.lit).toBe(true);
    expect(marks.get("z")!.lit).toBe(false);
    // Files never light up like junctions.
    expect(marks.get("a")!.lit).toBe(false);
    expect(marks.get("d")!.lit).toBe(false);
  });

  it("has no mark for a node without a card", () => {
    expect(diagramMarks(sample()).get("ghost")).toBeUndefined();
    expect(NO_MARK).toMatchObject({
      column: "todo",
      working: false,
      sentBack: false,
      done: false,
      lit: false,
    });
  });
});

describe("activity log", () => {
  const line = (n: number) => ({
    at: `2026-01-01T10:00:${String(n).padStart(2, "0")}.000Z`,
    text: `step ${n}`,
  });

  it("shows the newest first, at most twenty", () => {
    const log = Array.from({ length: 50 }, (_, i) => line(i));
    const shown = recentLog({ log });
    expect(shown).toHaveLength(20);
    expect(shown[0]!.text).toBe("step 49");
    expect(shown[19]!.text).toBe("step 30");
  });

  it("copes with no log, a short one and blank lines", () => {
    expect(recentLog({})).toEqual([]);
    expect(recentLog({ log: [line(1), { at: line(2).at, text: "  " }, line(3)] }).map((l) => l.text)).toEqual(
      ["step 3", "step 1"],
    );
  });

  it("does not reorder the project's own list", () => {
    const log = [line(1), line(2)];
    recentLog({ log });
    expect(log.map((l) => l.text)).toEqual(["step 1", "step 2"]);
  });
});

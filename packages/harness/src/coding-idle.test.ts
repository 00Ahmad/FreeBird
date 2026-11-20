import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { idleNudge } from "./coding-idle";
import { cleanTmp, codingTeam, makeCoding, tmp, type, until } from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

describe("what a role that called no tool is told", () => {
  it("tells the Developer to write its file, and QA to give its verdict, once", () => {
    expect(idleNudge("developer", { card: { id: "c", kind: "file", path: "a.js" } })).toBe(
      "You replied without using any tool, so nothing was written. Call write_file now with the complete a.js, then call finish_card.",
    );
    expect(idleNudge("qa", { card: { id: "c", kind: "file", path: "a.js" } })).toMatch(/call review_card/);
    expect(idleNudge("qa", { finalCheck: true })).toMatch(/call finish_check/);
    expect(idleNudge("qa", { visual: true })).toMatch(/app_start.*finish_visual_check/);
    // Not once it has used a tool, nor a second time.
    expect(idleNudge("developer", { usedTool: true })).toBeNull();
    expect(idleNudge("developer", { idleNudged: true })).toBeNull();
  });

  it("leaves the Planner alone: a plan written as JSON without the tool is an answer", () => {
    expect(idleNudge("planner", {})).toBeNull();
  });
});

describe("a Developer turn that ends without using a tool", () => {
  it("is nudged once in the same turn, and then writes its file", async () => {
    const ONE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };
    const team = codingTeam({
      plans: [{ tool: ONE }],
      // First answer: words only. After the nudge: the usual write and finish_card.
      develop: (_card, attempt) => (attempt === 1 ? { write: null, finish: false } : {}),
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");

    const nudged = team.seen.filter(
      (s) => s.role === "developer" && s.notes.some((n) => n.includes("without using any tool")),
    );
    expect(nudged.length).toBeGreaterThan(0);
    expect(readFileSync(join(out, "a.txt"), "utf8")).toBe("// a.txt\n");
    expect(done.log!.map((l) => l.text)).toContain(
      "Developer replied without using any tool; told to use them",
    );
    // One Developer turn and one QA turn on the card: no second Developer turn was started.
    expect(done.cards[0]!.work?.turns).toBe(2);
  });

  it("isn't told it used no tool when its call was refused for bad arguments", async () => {
    const ONE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };
    const team = codingTeam({
      plans: [{ tool: ONE }],
      // First try: a write_file with no content (refused before it runs), then words. Next try: the usual.
      develop: (_card, attempt) =>
        attempt === 1
          ? { write: null, finish: false, extras: [{ path: "a.txt" } as { path: string; content: string }] }
          : {},
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");
    // The call was refused before it ran, and the model was told why…
    expect(team.seen.some((s) => s.lastTool.startsWith("Invalid arguments for write_file"))).toBe(true);
    // …and not that it used no tool.
    expect(team.seen.some((s) => s.notes.some((n) => n.includes("without using any tool")))).toBe(false);
    expect(done.log!.map((l) => l.text)).not.toContain(
      "Developer replied without using any tool; told to use them",
    );
  });
});

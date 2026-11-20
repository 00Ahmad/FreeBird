import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanTmp, codingTeam, makeCoding, tmp, type, until } from "./coding-testing";
import { DEVELOPER_MAX_EDITS, editVerdict } from "./coding-runaway";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

describe("how many edits a Developer turn may make", () => {
  it("allows them, warns one before the last, then stops", () => {
    expect(editVerdict(0, 6).kind).toBe("ok");
    expect(editVerdict(3, 6).kind).toBe("ok");
    const warning = editVerdict(4, 6);
    expect(warning.kind).toBe("warn");
    expect(warning.kind === "warn" && warning.note).toContain(
      "at most one more change, then call finish_card",
    );
    expect(editVerdict(5, 6).kind).toBe("ok");
    const stop = editVerdict(6, 6);
    expect(stop.kind).toBe("stop");
    expect(stop.kind === "stop" && stop.result).toMatch(
      /^Not written: .*6 times.*without calling finish_card/,
    );
    expect(DEVELOPER_MAX_EDITS).toBeGreaterThanOrEqual(4);
  });
});

describe("a Developer turn that keeps editing without finishing", () => {
  it("is ended after the limit, and its work goes on to QA as it is", async () => {
    const ONE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };
    const team = codingTeam({
      plans: [{ tool: ONE }],
      // Writes its own file ten times over and never calls finish_card.
      develop: () => ({
        write: null,
        finish: false,
        extras: Array.from({ length: 10 }, (_, n) => ({ path: "a.txt", content: `version ${n + 1}\n` })),
      }),
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    h.services.coding.timing.maxEdits = 4;
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");

    // Four edits ran; the fifth was refused and the turn ended there.
    expect(readFileSync(join(out, "a.txt"), "utf8")).toBe("version 4\n");
    const log = done.log!.map((line) => line.text);
    expect(log).toContain("Developer made 4 edits without finishing a.txt; its work goes on as it is");
    expect(log).toContain("QA passed a.txt");
    // One Developer turn, not a try per card for three tries.
    expect(done.cards[0]!.work?.turns).toBe(2);
  });
});

describe("a Developer that calls finish_card again and again", () => {
  it("is told it already finished and its turn ends, and the card goes on to QA", async () => {
    const team = codingTeam({
      plans: [{ tool: { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] } }],
      develop: () => ({ finishTimes: 5 }),
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(done.cards[0]!.column).toBe("done");
    // The model is asked again after the first finish_card, but not after the second.
    const developer = team.seen.filter((seen) => seen.role === "developer");
    expect(developer.filter((seen) => seen.lastTool.startsWith("The card is with QA now"))).toHaveLength(1);
    expect(developer.some((seen) => seen.lastTool.startsWith("Already finished"))).toBe(false);
  });
});

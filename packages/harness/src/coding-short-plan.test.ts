import { afterEach, describe, expect, it } from "vitest";

import { SHORT_PLAN } from "./coding-tools";
import { cleanTmp, codingTeam, makeCoding, tmp, turnsOf, type, until } from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

/** A plan turned down twice is asked for again as a short one: a sentence per file, no connections. */

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const BAD = { nodes: [] };
const GOOD = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };

describe("a plan turned down twice", () => {
  it("is asked for as a short plan on the third try, overriding the Planner's skill", async () => {
    const team = codingTeam({ plans: [{ tool: BAD }, { tool: BAD }, { tool: GOOD }] });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");

    const tasks = turnsOf(team, "planner").map((turn) => turn.task);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).not.toContain(SHORT_PLAN);
    expect(tasks[1]).not.toContain(SHORT_PLAN);
    expect(tasks[2]).toContain(SHORT_PLAN);
    expect(SHORT_PLAN).toContain("This overrides the coding-planner skill");
    expect(done.log!.map((l) => l.text)).toContain(
      "The plan was turned down twice: asking the Planner for a short plan",
    );
  });

  it("doesn't count a model that failed as a plan turned down", async () => {
    const team = codingTeam({ plans: [{ fail: true }, { tool: BAD }, { tool: GOOD }] });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    h.services.coding.timing.retryBackoffMs = [0, 0];
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const tasks = turnsOf(team, "planner").map((turn) => turn.task);
    expect(tasks.some((task) => task.includes(SHORT_PLAN))).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { messageText, type CodingCard } from "@mrog/shared";

import { flagged, MAX_REPLANS, replannedNote, replanReply, replanRequest } from "./coding-replan";
import {
  cleanTmp,
  codingTeam,
  getProject,
  makeCoding,
  post,
  tmp,
  turnsOf,
  type,
  until,
} from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const card = (title: string, said: string) =>
  ({
    id: title,
    kind: "file",
    ref: "n1",
    title,
    column: "todo",
    comments: [
      { author: "qa", kind: "fail", text: said, round: 1, at: "2026-11-17T00:00:00.000Z" },
      { author: "developer", kind: "note", text: "Did it", round: 1, at: "2026-11-17T00:00:00.000Z" },
    ],
  }) as CodingCard;

describe("what the Planner is asked when files keep failing", () => {
  it("lists each file with QA's newest complaint, and asks to change only that part", () => {
    const text = replanRequest([
      card("app.js", "app.js does the feed, the search and the chart:\nfar too much"),
    ]);
    expect(text).toContain("These files keep failing QA");
    expect(text).toContain("- app.js: app.js does the feed, the search and the chart: far too much");
    expect(text).toContain("Keep every other file exactly as it is");
    expect(replannedNote(text)).toBe(
      "Re-planned: - app.js: app.js does the feed, the search and the chart: far too much",
    );
  });

  it("says what happens next, and reads QA's flag however it is sent", () => {
    expect(replanReply(["a.js", "b.js"], false, 1)).toContain(
      `a.js and b.js kept failing in a way the plan has to change, so I asked the Planner to fix that part of the plan (re-plan 1 of ${MAX_REPLANS}).`,
    );
    expect(replanReply(["a.js"], false, 1)).toContain("You'll see the updated plan to approve");
    expect([true, "true", "yes", false, "no", undefined, 1].map(flagged)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

const ONE_FILE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };
const SPLIT = {
  nodes: [
    { path: "a.txt", purpose: "the first half of the note" },
    { path: "b.txt", purpose: "the second half of the note" },
  ],
  edges: [],
};
const startTeam = (team: ReturnType<typeof codingTeam>) =>
  makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });

describe("plan problems go back to the Planner", () => {
  it("re-plans a card that used its rounds, and the changed plan is built", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }, { tool: SPLIT }] });
    team.behave.review = () =>
      turnsOf(team, "planner").filter((turn) => turn.fresh).length >= 2
        ? { pass: true }
        : { pass: false, comment: "a.txt tries to do two things at once" };
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, maxRounds: 2 });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");

    expect(done.replans).toBe(1);
    expect(done.nodes.map((node) => node.path)).toEqual(["a.txt", "b.txt"]);
    const asked = turnsOf(team, "planner").filter((turn) => turn.fresh)[1]!.task;
    expect(asked).toContain("These files keep failing QA");
    expect(asked).toContain("- a.txt: a.txt tries to do two things at once");
    expect(asked).not.toContain("The user now asks for a change");
    expect(
      done.cards[0]!.comments.some((c) => c.author === "planner" && c.text.startsWith("Re-planned:")),
    ).toBe(true);
    const said = h.store.messages.list(bot.threadId).map(messageText);
    expect(said.some((text) => text.startsWith("a.txt kept failing in a way the plan has to change"))).toBe(
      true,
    );
  });

  it("waits for the user when the Planner keeps the plan as it was", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: () => ({ pass: false, comment: "still wrong" }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, maxRounds: 2 });
    await type(h, bot, "Make a note");
    const stuck = await until(h, bot.id, (p) => p.status === "needs_you");
    expect(stuck.replans).toBe(1);
    expect(stuck.round).toBe(2);
    expect(stuck.cards[0]!.parked).toBe(true);
    expect(stuck.log?.map((line) => line.text)).toContain(
      "The Planner kept the plan as it was for the files that keep failing",
    );
  });

  it("re-plans when QA says the plan is the problem, from the card's second fail, without waiting for the limit", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }, { tool: SPLIT }] });
    team.behave.review = () =>
      turnsOf(team, "planner").filter((turn) => turn.fresh).length >= 2
        ? { pass: true }
        : { pass: false, comment: "two jobs in one file", planProblem: true };
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, maxRounds: 5 });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(done.replans).toBe(1);
    // The first fail goes back to the Developer as usual; the second one goes to the Planner.
    expect(
      turnsOf(team, "developer").filter((turn) => turn.fresh && turn.task.includes("File: a.txt")),
    ).toHaveLength(3);
  });

  it("waits for the user's approval of a re-plan when auto-approve is off", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }, { tool: SPLIT }] });
    team.behave.review = () => ({ pass: false, comment: "two jobs in one file" });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { maxRounds: 1 });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    await post(h, `/api/bots/${bot.id}/coding/approve`);
    // The first plan approved, a.txt fails once and is set aside: the re-plan waits for approval too.
    const project = await until(h, bot.id, (p) => p.status === "awaiting_approval" && p.nodes.length === 2);
    expect(project.replans).toBe(1);
    expect(getProject(h, bot.id).cards.map((c) => c.title)).toEqual(["a.txt", "b.txt"]);
  });
});

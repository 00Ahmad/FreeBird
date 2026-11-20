import { afterEach, describe, expect, it } from "vitest";

import type { CodingCard } from "@mrog/shared";

import { bringBack, setAsideIfSpent, timesSentBack } from "./coding-budget";
import { cleanTmp, codingTeam, makeCoding, post, tmp, type, until } from "./coding-testing";
import { auth, makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const said = (
  kind: "fail" | "check" | "pass" | "note",
  round: number,
  author: "qa" | "developer" = "qa",
) => ({
  author,
  kind,
  round,
  text: "x",
  at: new Date().toISOString(),
});
const card = (comments: ReturnType<typeof said>[], column: CodingCard["column"] = "todo"): CodingCard => ({
  id: "c",
  kind: "file",
  ref: "n1",
  title: "a.js",
  column,
  comments,
});

describe("a card's budget", () => {
  it("counts the rounds it was sent back in, by QA or by the checks, once a round", () => {
    expect(timesSentBack(card([said("fail", 1), said("check", 1), said("check", 2), said("pass", 3)]))).toBe(
      2,
    );
    expect(timesSentBack(card([said("note", 1, "developer")]))).toBe(0);
  });

  it("sets it aside once it has used the round limit, and brings it back when the limit is raised", () => {
    const stubborn = card([said("fail", 1), said("fail", 2)]);
    expect(setAsideIfSpent(stubborn, 3)).toBe(false);
    expect(setAsideIfSpent(stubborn, 2)).toBe(true);
    expect(stubborn.parked).toBe(true);
    // Not under the same limit; under a higher one.
    expect(bringBack([stubborn], 2)).toBe(0);
    expect(bringBack([stubborn], 3)).toBe(1);
    expect(stubborn.parked).toBeUndefined();
  });

  it("never sets aside a card that is done", () => {
    expect(setAsideIfSpent(card([said("fail", 1), said("fail", 2)], "done"), 1)).toBe(false);
  });
});

describe("one stubborn card", () => {
  it("is set aside while the rest of the board finishes, and the project waits for you about it alone", async () => {
    const TWO = {
      nodes: [
        { path: "a.js", purpose: "fine" },
        { path: "b.js", purpose: "stubborn" },
      ],
      edges: [],
    };
    const team = codingTeam({
      plans: [{ tool: TWO }],
      review: (reviewed) =>
        reviewed.key === "b.js" ? { pass: false, comment: "b is wrong" } : { pass: true },
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, maxRounds: 2 });
    await type(h, bot, "Two files");
    const stuck = await until(h, bot.id, (p) => p.status === "needs_you");

    const [a, b] = stuck.cards;
    expect(a).toMatchObject({ title: "a.js", column: "done" });
    expect(b).toMatchObject({ title: "b.js", column: "todo", parked: true });
    expect(stuck.note).toContain("b.js");
    expect(stuck.note).toContain("b is wrong");
    expect(stuck.log!.map((l) => l.text)).toContain(
      "b.js was sent back 2 times: set aside for you, the rest carries on",
    );
    expect(
      h.store.messages
        .list(bot.threadId)
        .some((m) =>
          m.parts.some(
            (p) =>
              p.type === "text" &&
              p.text.startsWith("I set aside the card that failed 2 times; everything else passed."),
          ),
        ),
    ).toBe(true);

    // Resume alone changes nothing; a higher limit brings it back, and Resume carries on.
    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(409);
    const raised = await h.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}/coding/settings`,
      headers: auth,
      payload: { maxRounds: 3 },
    });
    expect(raised.json().project.cards[1].parked).toBeUndefined();
    team.behave.review = () => ({ pass: true });
    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(200);
    await until(h, bot.id, (p) => p.status === "done");
  });
});

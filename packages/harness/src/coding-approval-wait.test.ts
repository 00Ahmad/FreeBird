import { afterEach, describe, expect, it } from "vitest";

import { messageText } from "@mrog/shared";

import { cleanTmp, codingTeam, getProject, makeCoding, post, tmp, type, until } from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const ONE_FILE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };

describe("a role's approval card nobody answers", () => {
  it("doesn't count as no: the team waits, and the Coding Bot reminds the user", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: () => ({ pass: true, command: "npm test" }),
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    h.services.agent.approvals.timeoutMs = 150;
    // Without Auto-approve, QA's commands show a card.
    const { bot } = await makeCoding(h, tmp("out"));
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    await post(h, `/api/bots/${bot.id}/coding/approve`);

    const reminded = () =>
      h!.store.messages
        .list(bot.threadId)
        .map(messageText)
        .filter((text) => text.startsWith("QA has waited"));
    await until(h, bot.id, () => reminded().length >= 2);
    expect(reminded()[0]).toContain("The team waits until you answer the card in this chat (or press Stop).");
    // Still on the card: nothing went on without the answer.
    expect(getProject(h, bot.id).status).toBe("qa");
    expect(getProject(h, bot.id).cards[0]!.column).toBe("qa");

    await post(h, `/api/bots/${bot.id}/coding/stop`);
    expect(getProject(h, bot.id).status).toBe("stopped");
  });
});

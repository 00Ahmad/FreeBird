import { afterEach, describe, expect, it } from "vitest";

import { libraryTitle } from "@mrog/shared";

import { auth, makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("library", () => {
  it("titles a reply from its first heading or line", () => {
    expect(libraryTitle("Intro\n## Best **phones**\n...")).toBe("Best phones");
    expect(libraryTitle("Plain answer here.")).toBe("Plain answer here.");
    expect(libraryTitle("| Phone | Price |\n|---|---|\n| A | 1 |")).toBe("Table: Phone, Price");
  });

  it("keeps a copy of a reply after its chat is cleared, and can rename and remove it", async () => {
    h = await makeHarness();
    const bot = h.store.bots.create({ name: "Scout" });
    const message = h.store.messages.create({
      threadId: bot.threadId,
      role: "bot",
      botId: bot.id,
      parts: [{ type: "text", text: "# Phone report\n| Phone | Price |\n|---|---|\n| A | Rs. 1 |" }],
    });
    const saved = await h.app.inject({
      method: "POST",
      url: "/api/library",
      headers: auth,
      payload: { messageId: message.id },
    });
    expect(saved.statusCode).toBe(201);
    const item = saved.json().item;
    expect(item).toMatchObject({ title: "Phone report", botName: "Scout", messageId: message.id });

    // Saving the same reply again returns the same item.
    const again = await h.app.inject({
      method: "POST",
      url: "/api/library",
      headers: auth,
      payload: { messageId: message.id },
    });
    expect(again.json().item.id).toBe(item.id);

    h.store.messages.clear(bot.threadId);
    const list = await h.app.inject({ method: "GET", url: "/api/library", headers: auth });
    expect(list.json().items[0].text).toContain("| A | Rs. 1 |");

    const renamed = await h.app.inject({
      method: "PATCH",
      url: `/api/library/${item.id}`,
      headers: auth,
      payload: { title: "Phones" },
    });
    expect(renamed.json().item.title).toBe("Phones");
    const removed = await h.app.inject({ method: "DELETE", url: `/api/library/${item.id}`, headers: auth });
    expect(removed.statusCode).toBe(204);
  });

  it("refuses user messages and unknown ids", async () => {
    h = await makeHarness();
    const bot = h.store.bots.create({ name: "Scout" });
    const mine = h.store.messages.create({
      threadId: bot.threadId,
      role: "user",
      botId: null,
      parts: [{ type: "text", text: "hi" }],
    });
    for (const messageId of [mine.id, "msg_nope"]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/library",
        headers: auth,
        payload: { messageId },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

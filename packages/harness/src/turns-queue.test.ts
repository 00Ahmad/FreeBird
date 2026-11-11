import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, messageText, type Bot, type Message } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const reply = (text: string) => ndjson([{ message: { content: text } }, { done: true }]);

/** Ollama whose first chat request waits for `release()`; later ones answer at once ("Answer 2.", ...). */
async function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  h = await makeHarness({
    handlers: fakeOllama(async () => {
      const n = ++calls;
      if (n === 1) await gate;
      return reply(`Answer ${n}.`);
    }),
  });
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const bot = (
    await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
  ).json().bot as Bot;
  const chats = () => h!.calls.filter((call) => call.path === "/api/chat");
  return { bot, release, chats };
}

const send = (bot: Bot, payload: object) =>
  h!.app.inject({ method: "POST", url: `/api/threads/${bot.threadId}/messages`, headers: auth, payload });

const stop = (bot: Bot) =>
  h!.app.inject({ method: "POST", url: `/api/threads/${bot.threadId}/stop`, headers: auth });

const botReplies = (bot: Bot): Message[] =>
  h!.store.messages.list(bot.threadId).filter((message) => message.role === "bot");

/** Lets queued turns that were going to start do so. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("a turn that waits behind another", () => {
  it("starts with the bot as it is by then, not as it was when it was queued", async () => {
    const { bot, release, chats } = await gated();
    await send(bot, { text: "First question" });
    await vi.waitFor(() => expect(chats()).toHaveLength(1));
    // A routine fires while the first reply is being written, so it waits. Then the owner narrows the bot.
    const routine = h!.store.routines.create({
      botId: bot.id,
      name: "Report",
      prompt: "Report.",
      trigger: { type: "manual" },
    });
    const ran = h!.services.routines.run(routine);
    const patched = await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers: auth,
      payload: { instructions: "Always answer in haiku.", tools: { allow: [], exclude: [] } },
    });
    expect(patched.statusCode).toBe(200);
    expect(chats()[0]!.body.tools?.length).toBeGreaterThan(0);
    release();
    await ran;

    const queued = chats()[1]!.body;
    expect(queued.messages[0].content).toContain("Always answer in haiku.");
    expect(queued.tools ?? []).toEqual([]);
  });

  it("is not started when its bot was deleted meanwhile", async () => {
    const { bot, release, chats } = await gated();
    await send(bot, { text: "First question" });
    await vi.waitFor(() => expect(chats()).toHaveLength(1));
    const routine = h!.store.routines.create({
      botId: bot.id,
      name: "Report",
      prompt: "Report.",
      trigger: { type: "manual" },
    });
    const ran = h!.services.routines.run(routine);
    h!.store.bots.delete(bot.id);
    release();
    await expect(ran).resolves.toBe("stopped");
    expect(chats()).toHaveLength(1);
  });

  it("is dropped by Stop pressed while it waits", async () => {
    const { bot, release, chats } = await gated();
    await send(bot, { text: "First question" });
    await vi.waitFor(() => expect(chats()).toHaveLength(1));
    // Stop ends the running reply; the message sent after it waits for that reply to wind down.
    await stop(bot);
    await send(bot, { text: "Never mind, do this instead" });
    await stop(bot);
    release();
    await settle();

    expect(chats()).toHaveLength(1);
    expect(botReplies(bot)).toHaveLength(1);
    expect(botReplies(bot)[0]!.status).toBe("stopped");
  });

  it("is dropped by Clear chat while it waits", async () => {
    const { bot, release, chats } = await gated();
    await send(bot, { text: "First question" });
    await vi.waitFor(() => expect(chats()).toHaveLength(1));
    await stop(bot);
    await send(bot, { text: "And another thing" });
    await h!.app.inject({ method: "DELETE", url: `/api/threads/${bot.threadId}/messages`, headers: auth });
    release();
    await settle();

    expect(chats()).toHaveLength(1);
    expect(h!.store.messages.list(bot.threadId)).toEqual([]);
  });

  it("answers a message sent after Stop, even though an earlier one was dropped", async () => {
    const { bot, release, chats } = await gated();
    await send(bot, { text: "First question" });
    await vi.waitFor(() => expect(chats()).toHaveLength(1));
    await stop(bot);
    await send(bot, { text: "Dropped" });
    await stop(bot);
    await send(bot, { text: "Keep this one" });
    release();
    // The reply exists before its text does, so wait until it has finished.
    await vi.waitFor(() => expect(botReplies(bot)[1]?.status).toBe("done"));

    expect(chats()).toHaveLength(2);
    expect(messageText(botReplies(bot)[1]!)).toBe("Answer 2.");
    expect(chats()[1]!.body.messages.at(-1).content).toMatch(/Keep this one$/);
  });

  it("is one reply, however many messages arrive while a Parallel Bots reply is written", async () => {
    const { bot, release, chats } = await gated();
    await send(bot, { text: "Compare the options", parallel: true });
    await vi.waitFor(() => expect(chats()).toHaveLength(1));
    // A Parallel Bots reply takes no steering, so each of these waits for it.
    await send(bot, { text: "One more thing" });
    await send(bot, { text: "And another" });
    release();
    await vi.waitFor(() => expect(botReplies(bot)).toHaveLength(2));
    await settle();

    expect(botReplies(bot)).toHaveLength(2);
    expect(chats()).toHaveLength(2);
    // The one reply is built from the whole conversation (consecutive messages read as one), so it answers both.
    const asked = chats()[1]!.body.messages.at(-1).content as string;
    expect(asked).toContain("One more thing");
    expect(asked).toMatch(/And another$/);
  });
});

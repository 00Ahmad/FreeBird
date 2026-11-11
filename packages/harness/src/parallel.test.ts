import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, messageText, parseParallel, type Bot, type Message } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const THREE = [
  "## 1. Cost analyst",
  "Buying costs more up front.",
  "",
  "## 2. Security engineer",
  "Your own servers need patching.",
  "",
  "## 3. Skeptic",
  "Don't forget the cost of moving.",
].join("\n");

const reply = (text: string) =>
  ndjson([
    { message: { content: text.slice(0, 20) } },
    { message: { content: text.slice(20) } },
    { done: true },
  ]);

/** A primary bot: a coordinator, so an ordinary turn offers it tools and plans before it starts. */
async function primary(harness: TestHarness): Promise<Bot> {
  harness.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const res = await harness.app.inject({
    method: "POST",
    url: "/api/bots",
    headers: auth,
    payload: { name: "Ada", isPrimary: true },
  });
  return res.json().bot as Bot;
}

const send = (bot: Bot, payload: object) =>
  h!.app.inject({ method: "POST", url: `/api/threads/${bot.threadId}/messages`, headers: auth, payload });

/** The next finished reply from a bot that isn't one already seen (a reply is announced more than once). */
const botReply = (harness: TestHarness, seen: string[] = []) =>
  nextEvent<Message>(
    harness.bus,
    (e) =>
      e.type === "message.updated" &&
      e.message.role === "bot" &&
      e.message.status !== "streaming" &&
      !seen.includes(e.message.id) &&
      e.message,
  );

const chats = (harness: TestHarness) => harness.calls.filter((call) => call.path === "/api/chat");

describe("Parallel Bots", () => {
  it("answers in one request with no tools, and saves the form only in that request", async () => {
    h = await makeHarness({ handlers: fakeOllama(() => reply(THREE)) });
    const ada = await primary(h);
    const updates: Message[] = [];
    h.bus.subscribe(
      (e) => e.type === "message.updated" && e.message.role === "bot" && updates.push(e.message),
    );
    const done = botReply(h);
    expect((await send(ada, { text: "Should we move to our own servers?", parallel: true })).statusCode).toBe(
      201,
    );
    const answer = await done;

    // One request, even for the primary bot, which would otherwise be offered tools and plan first.
    expect(chats(h)).toHaveLength(1);
    const body = chats(h)[0]!.body;
    expect(body.tools ?? []).toEqual([]);
    expect(body.messages[0].content).not.toContain("spawn_bot");
    expect(body.messages[0].content).not.toContain("update_plan");
    const asked = body.messages.at(-1).content as string;
    expect(asked.startsWith("Should we move to our own servers?")).toBe(true);
    expect(asked).toContain("Parallel Bots mode");

    // What's saved is the question as typed and the reply as written, both marked.
    const [question, saved] = h.store.messages.list(ada.threadId);
    expect(messageText(question!)).toBe("Should we move to our own servers?");
    expect(question).toMatchObject({ role: "user", parallel: true });
    expect(saved).toMatchObject({ role: "bot", parallel: true, status: "done" });
    expect(messageText(saved!)).toBe(THREE);
    expect(parseParallel(messageText(saved!)).sections.map((s) => s.role)).toEqual([
      "Cost analyst",
      "Security engineer",
      "Skeptic",
    ]);
    // Every update on the way carried the mark, so the cards never fall back to plain text while it streams.
    expect(answer.parallel).toBe(true);
    expect(updates.every((message) => message.parallel)).toBe(true);
  });

  it("answers an ordinary message after it the ordinary way", async () => {
    h = await makeHarness({ handlers: fakeOllama(() => reply(THREE)) });
    const ada = await primary(h);
    let done = botReply(h);
    await send(ada, { text: "First, in parallel", parallel: true });
    const firstReply = await done;
    done = botReply(h, [firstReply.id]);
    await send(ada, { text: "And now plainly" });
    const second = await done;

    expect(second.parallel).toBe(false);
    const [, plain] = chats(h);
    expect(plain!.body.messages.at(-1).content).toBe("And now plainly");
    expect(plain!.body.tools?.length).toBeGreaterThan(0);
  });

  it("keeps the mode when the reply is tried again", async () => {
    let calls = 0;
    h = await makeHarness({
      handlers: fakeOllama(() =>
        ++calls === 1
          ? new Response(JSON.stringify({ error: "the model fell over" }), { status: 500 })
          : reply(THREE),
      ),
    });
    const ada = await primary(h);
    const failed = botReply(h);
    await send(ada, { text: "Compare the options", parallel: true });
    const first = await failed;
    expect(first.status).toBe("error");

    const retried = botReply(h, [first.id]);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/threads/${ada.threadId}/retry`,
      headers: auth,
      payload: { botId: ada.id, messageId: first.id },
    });
    expect(res.statusCode).toBe(202);
    const second = await retried;

    expect(second).toMatchObject({ status: "done", parallel: true });
    expect(chats(h)).toHaveLength(2);
    expect(chats(h)[1]!.body.messages.at(-1).content).toContain("Parallel Bots mode");
    expect(chats(h)[1]!.body.tools ?? []).toEqual([]);
  });

  it("never steers a message into a Parallel Bots reply, or a Parallel Bots message into a running one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    h = await makeHarness({
      handlers: fakeOllama(async () => {
        if (++calls === 1) await gate;
        return reply(calls === 1 ? THREE : "A plain answer.");
      }),
    });
    const ada = await primary(h);
    const first = botReply(h);
    await send(ada, { text: "Compare the options", parallel: true });
    // The first reply is still being written when the user sends another message.
    await send(ada, { text: "One more thing" });
    release();
    const parallelReply = await first;
    const plainReply = await botReply(h, [parallelReply.id]);

    // Each got its own request; the three-section reply wasn't added to by a second step.
    expect(chats(h)).toHaveLength(2);
    expect(messageText(parallelReply)).toBe(THREE);
    expect(parallelReply.parallel).toBe(true);
    expect(plainReply.parallel).toBe(false);
    expect(messageText(plainReply)).toBe("A plain answer.");
  });

  it("doesn't steer a Parallel Bots message into an ordinary reply that is still being written", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    h = await makeHarness({
      handlers: fakeOllama(async () => {
        if (++calls === 1) await gate;
        return reply(calls === 1 ? "A plain answer." : THREE);
      }),
    });
    const ada = await primary(h);
    const first = botReply(h);
    await send(ada, { text: "A plain question" });
    // The ordinary reply is still being written when the Parallel Bots message arrives.
    await send(ada, { text: "Compare the options", parallel: true });
    release();
    const plainReply = await first;
    const parallelReply = await botReply(h, [plainReply.id]);

    // Two requests: the second one answers the Parallel Bots message in its own mode, and the first was left alone.
    expect(chats(h)).toHaveLength(2);
    expect(messageText(plainReply)).toBe("A plain answer.");
    expect(plainReply.parallel).toBe(false);
    expect(parallelReply.parallel).toBe(true);
    expect(messageText(parallelReply)).toBe(THREE);
    const second = chats(h)[1]!.body;
    expect(second.messages.at(-1).content).toContain("Parallel Bots mode");
    expect(second.tools ?? []).toEqual([]);
  });

  it("answers the user's Parallel Bots message in that mode even when a routine queued before it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    h = await makeHarness({
      handlers: fakeOllama(async () => {
        const n = ++calls;
        if (n === 1) await gate;
        return reply(n === 3 ? THREE : `Plain answer ${n}.`);
      }),
    });
    const ada = await primary(h);
    const replies: Message[] = [];
    h.bus.subscribe((e) => {
      if (e.type === "message.updated" && e.message.role === "bot" && e.message.status === "done")
        if (!replies.some((message) => message.id === e.message.id)) replies.push(e.message);
    });
    await send(ada, { text: "First question" });
    // The first reply is being written. A routine fires, then the user sends a Parallel Bots message: both wait.
    await vi.waitFor(() => expect(calls).toBe(1));
    const routine = h.store.routines.create({
      botId: ada.id,
      name: "Report",
      prompt: "Report.",
      trigger: { type: "manual" },
    });
    const ran = h.services.routines.run(routine);
    await send(ada, { text: "Compare the options", parallel: true });
    release();
    await ran;
    await vi.waitFor(() => expect(replies).toHaveLength(3));

    // The routine's turn goes first, as an ordinary one; the user's message gets its own Parallel Bots answer.
    expect(replies.map((message) => message.parallel)).toEqual([false, false, true]);
    expect(messageText(replies[1]!)).toBe("Plain answer 2.");
    expect(messageText(replies[2]!)).toBe(THREE);
    expect(chats(h)).toHaveLength(3);
    expect(chats(h)[1]!.body.tools?.length).toBeGreaterThan(0);
    expect(chats(h)[2]!.body.tools ?? []).toEqual([]);
  });

  it("refuses Parallel Bots in a chat with several bots", async () => {
    h = await makeHarness({ handlers: fakeOllama(() => reply(THREE)) });
    const ada = await primary(h);
    const bea = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Bea" } })
    ).json().bot as Bot;
    const group = h.store.threads.createGroup(null, [ada.id, bea.id]);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/threads/${group.id}/messages`,
      headers: auth,
      payload: { text: "@Ada hello", parallel: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("one bot");
    expect(h.store.messages.list(group.id)).toHaveLength(0);
  });
});

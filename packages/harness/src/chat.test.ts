import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, messageText, type Bot, type Message } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function botWithModel(harness: TestHarness): Promise<Bot> {
  // Saved directly: runtime.update() would also start a warm-up request, which these tests don't want.
  harness.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const res = await harness.app.inject({
    method: "POST",
    url: "/api/bots",
    headers: auth,
    payload: { name: "Ada" },
  });
  return res.json().bot as Bot;
}

const finished = (harness: TestHarness) =>
  nextEvent<Message>(
    harness.bus,
    (e) => e.type === "message.updated" && e.message.status !== "streaming" && e.message,
  );

describe("chat turns", () => {
  it("streams a reply on the shared model with the shared options", async () => {
    h = await makeHarness({
      handlers: fakeOllama(() =>
        ndjson([
          { message: { content: "Hel" } },
          { message: { content: "lo!" } },
          { done: true, prompt_eval_count: 7, eval_count: 2 },
        ]),
      ),
    });
    const bot = await botWithModel(h);
    const deltas: string[] = [];
    h.bus.subscribe((e) => e.type === "message.delta" && deltas.push(e.text));
    const done = finished(h);

    const sent = await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "hi" },
    });
    expect(sent.statusCode).toBe(201);
    const reply = await done;

    expect(deltas).toEqual(["Hel", "lo!"]);
    expect(reply).toMatchObject({
      status: "done",
      botId: bot.id,
      model: "ollama:test:1b",
      parts: [{ type: "text", text: "Hello!" }],
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    const chat = h.calls.find((call) => call.path === "/api/chat");
    expect(chat?.body).toMatchObject({ model: "test:1b", keep_alive: "30m", options: { num_ctx: 32768 } });
    expect(chat?.body.messages.at(-1)).toEqual({ role: "user", content: "hi" });
    expect(chat?.body.messages[0].content).toContain("You are Ada");

    const list = await h.app.inject({ url: `/api/threads/${bot.threadId}/messages`, headers: auth });
    expect(list.json().messages.map((m: Message) => m.role)).toEqual(["user", "bot"]);
  });

  it("reports a missing model as an error part instead of failing the request", async () => {
    h = await makeHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/bots",
      headers: auth,
      payload: { name: "NoModel" },
    });
    const bot = res.json().bot as Bot;
    const done = finished(h);
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "hi" },
    });
    const reply = await done;
    expect(reply.status).toBe("error");
    expect(reply.parts[0]).toMatchObject({ type: "error", code: "model_missing" });
  });

  it("stops a running turn and keeps what was written", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h = await makeHarness({
      handlers: fakeOllama(async () => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(JSON.stringify({ message: { content: "partial" } }) + "\n"));
              await gate;
              controller.close();
            },
          }),
        );
      }),
    });
    const bot = await botWithModel(h);
    const firstDelta = nextEvent(h.bus, (e) => e.type === "message.delta");
    const done = finished(h);
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "go" },
    });
    await firstDelta;
    await h.app.inject({ method: "POST", url: `/api/threads/${bot.threadId}/stop`, headers: auth });
    const reply = await done;
    release();
    expect(reply.status).toBe("stopped");
    expect(reply.parts).toEqual([{ type: "text", text: "partial" }]);
  });

  it("runs one turn per bot per thread: a second one (a routine firing mid-reply) waits for the first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let requests = 0;
    h = await makeHarness({
      handlers: fakeOllama(async () => {
        requests += 1;
        const first = requests === 1;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(JSON.stringify({ message: { content: "hi" } }) + "\n"));
              if (first) await gate;
              controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + "\n"));
              controller.close();
            },
          }),
        );
      }),
    });
    const bot = await botWithModel(h);
    const thread = h.store.threads.get(bot.threadId)!;
    const firstDelta = nextEvent(h.bus, (e) => e.type === "message.delta");
    const one = h.services.turns.start(thread, bot, "user");
    await firstDelta;
    const two = h.services.turns.start(thread, bot, "routine");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toBe(1);
    release();
    const [a, b] = await Promise.all([one, two]);
    expect([a.status, b.status]).toEqual(["done", "done"]);
    expect(requests).toBe(2);
    expect(h.services.turns.isRunning(thread.id, bot.id)).toBe(false);
  });

  it("queues a second bot behind the first on the shared model", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let chats = 0;
    h = await makeHarness({
      handlers: fakeOllama(async () => {
        chats += 1;
        if (chats === 1) await gate;
        return ndjson([{ message: { content: "ok" } }, { done: true }]);
      }),
    });
    const a = await botWithModel(h);
    const b = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Bea" } })
    ).json().bot as Bot;

    const queued = nextEvent(h.bus, (e) => e.type === "thread.activity" && e.activity === "queued" && e);
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${a.threadId}/messages`,
      headers: auth,
      payload: { text: "1" },
    });
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${b.threadId}/messages`,
      headers: auth,
      payload: { text: "2" },
    });
    expect(await queued).toMatchObject({ threadId: b.threadId, botId: b.id });

    const bothDone = new Promise<void>((resolve) => {
      let n = 0;
      h!.bus.subscribe((e) => {
        if (e.type === "message.updated" && e.message.status === "done" && ++n === 2) resolve();
      });
    });
    release();
    await bothDone;
    expect(chats).toBe(2);
  });

  it("moves reasoning a model wrote into its answer (ending in </think>) out of the answer", async () => {
    h = await makeHarness({
      handlers: fakeOllama(() =>
        ndjson([
          { message: { content: "Draft one. Let me tighten it.</th" } },
          { message: { content: "ink>Final answer." } },
          { done: true },
        ]),
      ),
    });
    const bot = await botWithModel(h);
    const done = finished(h);
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "hi" },
    });
    expect((await done).parts).toEqual([
      { type: "reasoning", text: "Draft one. Let me tighten it." },
      { type: "text", text: "Final answer." },
    ]);
  });

  it("frees the shared model while a turn waits for the user", async () => {
    let chats = 0;
    h = await makeHarness({
      handlers: fakeOllama(() => {
        chats += 1;
        return chats === 1
          ? ndjson([
              {
                message: {
                  tool_calls: [{ function: { name: "ask_user", arguments: { question: "Sure?" } } }],
                },
              },
              { done: true },
            ])
          : ndjson([{ message: { content: "ok" } }, { done: true }]);
      }),
    });
    const a = await botWithModel(h);
    const b = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Bea" } })
    ).json().bot as Bot;
    const asked = nextEvent(h.bus, (e) => e.type === "thread.activity" && e.activity === "waiting_user");
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${a.threadId}/messages`,
      headers: auth,
      payload: { text: "ask me" },
    });
    await asked;
    expect(h.services.runtime.queueState()).toEqual({ running: 0, waiting: 0 });
    const done = nextEvent<Message>(
      h.bus,
      (e) =>
        e.type === "message.updated" && e.message.botId === b.id && e.message.status === "done" && e.message,
    );
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${b.threadId}/messages`,
      headers: auth,
      payload: { text: "hi" },
    });
    expect(messageText(await done)).toBe("ok");
    await h.app.inject({ method: "POST", url: `/api/threads/${a.threadId}/stop`, headers: auth });
  });

  it("answers two messages sent after Stop with one reply", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: string[][] = [];
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        seen.push(body.messages.filter((m: any) => m.role === "user").map((m: any) => m.content));
        if (seen.length === 1) await gate;
        return ndjson([{ message: { content: "ok" } }, { done: true }]);
      }),
    });
    const bot = await botWithModel(h);
    const post = (text: string) =>
      h!.app.inject({
        method: "POST",
        url: `/api/threads/${bot.threadId}/messages`,
        headers: auth,
        payload: { text },
      });
    const started = nextEvent(h.bus, (e) => e.type === "thread.activity" && e.activity === "thinking");
    await post("first");
    await started;
    await h.app.inject({ method: "POST", url: `/api/threads/${bot.threadId}/stop`, headers: auth });
    await post("second");
    await post("third");
    const done = nextEvent<Message>(
      h.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && e.message,
    );
    release();
    await done;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.join("\n")).toMatch(/first[\s\S]*second[\s\S]*third/);
  });

  it("passes the pictures of a message sent mid-turn on to the model", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const bodies: any[] = [];
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        bodies.push(body);
        if (bodies.length === 1) {
          await gate;
          return ndjson([
            {
              message: {
                tool_calls: [{ function: { name: "update_plan", arguments: { steps: ["Look"] } } }],
              },
            },
            { done: true },
          ]);
        }
        return ndjson([{ message: { content: "Nice picture." } }, { done: true }]);
      }),
    });
    const bot = await botWithModel(h);
    const started = nextEvent(h.bus, (e) => e.type === "thread.activity" && e.activity === "thinking");
    const done = nextEvent<Message>(
      h.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && e.message,
    );
    const post = (payload: object) =>
      h!.app.inject({ method: "POST", url: `/api/threads/${bot.threadId}/messages`, headers: auth, payload });
    await post({ text: "plan it" });
    await started;
    await post({ text: "look", images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }] });
    release();
    await done;
    const steered = bodies[1].messages.find((m: any) => m.role === "user" && m.content === "look");
    expect(steered?.images).toEqual(["iVBORw0KGgo="]);
  });

  it("drops the reasoning of an attempt that failed and was retried", async () => {
    let chats = 0;
    h = await makeHarness({
      handlers: fakeOllama(() => {
        chats += 1;
        return chats === 1
          ? ndjson([{ message: { thinking: "first try" } }, { error: "error parsing tool call" }])
          : ndjson([
              { message: { thinking: "second try" } },
              { message: { content: "Done." } },
              { done: true },
            ]);
      }),
    });
    const bot = await botWithModel(h);
    const done = finished(h);
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "hi" },
    });
    expect((await done).parts).toEqual([
      { type: "reasoning", text: "second try" },
      { type: "text", text: "Done." },
    ]);
  });

  it("rejects empty messages and unknown threads", async () => {
    h = await makeHarness();
    const bot = await botWithModel(h);
    const empty = await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: " " },
    });
    expect(empty.statusCode).toBe(400);
    const unknown = await h.app.inject({
      method: "POST",
      url: `/api/threads/thr_${"0".repeat(32)}/messages`,
      headers: auth,
      payload: { text: "x" },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("runtime API", () => {
  it("reports status and validates settings", async () => {
    h = await makeHarness();
    const status = (await h.app.inject({ url: "/api/runtime", headers: auth })).json().status;
    expect(status).toMatchObject({ ollama: { reachable: true, version: "0.0.0-test" }, loaded: [] });
    const bad = await h.app.inject({
      method: "PATCH",
      url: "/api/runtime/settings",
      headers: auth,
      payload: { numCtx: 5 },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await h.app.inject({
      method: "PATCH",
      url: "/api/runtime/settings",
      headers: auth,
      payload: { sharedModel: "ollama:test:1b", numCtx: 16384 },
    });
    expect(ok.json().settings).toMatchObject({ sharedModel: "ollama:test:1b", numCtx: 16384 });
  });

  it("lists models from every provider", async () => {
    h = await makeHarness();
    const res = await h.app.inject({ url: "/api/models", headers: auth });
    expect(res.json()).toMatchObject({
      models: [{ ref: "ollama:test:1b", capabilities: ["completion", "tools"] }],
      errors: [],
    });
  });

  it("streams pull progress as events", async () => {
    h = await makeHarness({
      handlers: {
        ...fakeOllama(),
        "/api/pull": () => ndjson([{ status: "pulling", completed: 1, total: 2 }, { status: "success" }]),
      },
    });
    const done = nextEvent(h.bus, (e) => e.type === "runtime.pull" && e.done && e);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/runtime/pull",
      headers: auth,
      payload: { model: "qwen3:4b" },
    });
    expect(res.statusCode).toBe(202);
    expect(await done).toMatchObject({ model: "qwen3:4b", status: "success", error: null });
  });
});

describe("clear chat", () => {
  it("deletes a thread's messages and keeps the bot", async () => {
    h = await makeHarness();
    const bot = await botWithModel(h);
    const done = finished(h);
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "hi" },
    });
    await done;
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
    });
    expect(res.json()).toEqual({ removed: 2 });
    expect(
      (await h.app.inject({ url: `/api/threads/${bot.threadId}/messages`, headers: auth })).json().messages,
    ).toEqual([]);
    expect(h.store.bots.get(bot.id)).not.toBeNull();
  });

  it("doesn't bring back a reply that was still being written", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h = await makeHarness({
      handlers: fakeOllama(async () => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(JSON.stringify({ message: { content: "partial" } }) + "\n"));
              await gate;
              controller.close();
            },
          }),
        );
      }),
    });
    const bot = await botWithModel(h);
    const firstDelta = nextEvent(h.bus, (e) => e.type === "message.delta");
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "go" },
    });
    await firstDelta;
    const updates: Message[] = [];
    h.bus.subscribe((e) => e.type === "message.updated" && updates.push(e.message));
    const idle = nextEvent(h.bus, (e) => e.type === "thread.activity" && e.activity === "idle");
    await h.app.inject({ method: "DELETE", url: `/api/threads/${bot.threadId}/messages`, headers: auth });
    await idle;
    release();
    expect(updates).toEqual([]);
    expect(h.store.messages.list(bot.threadId)).toEqual([]);
  });
});

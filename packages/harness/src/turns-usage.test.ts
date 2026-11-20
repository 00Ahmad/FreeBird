import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

/** What a turn's model requests cost is kept, whatever becomes of the turn; a count nobody reported is unknown. */

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function botWithModel(harness: TestHarness): Promise<Bot> {
  harness.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const res = await harness.app.inject({
    method: "POST",
    url: "/api/bots",
    headers: auth,
    payload: { name: "Ada" },
  });
  return res.json().bot as Bot;
}

const ended = (harness: TestHarness) =>
  nextEvent<Message>(
    harness.bus,
    (e) =>
      e.type === "message.updated" &&
      e.message.role === "bot" &&
      e.message.status !== "streaming" &&
      e.message,
    10_000,
  );

const send = (harness: TestHarness, bot: Bot, text: string) =>
  harness.app.inject({
    method: "POST",
    url: `/api/threads/${bot.threadId}/messages`,
    headers: auth,
    payload: { text },
  });

describe("a turn's token counts", () => {
  it("keeps what a turn spent before it failed", async () => {
    let requests = 0;
    h = await makeHarness({
      handlers: fakeOllama(() => {
        requests += 1;
        // First request: a tool call, with its counts. Second: the runtime breaks.
        return requests === 1
          ? ndjson([
              {
                message: { content: "", tool_calls: [{ function: { name: "no_such_tool", arguments: {} } }] },
              },
              { done: true, prompt_eval_count: 50, eval_count: 5 },
            ])
          : new Response("boom", { status: 500 });
      }),
    });
    const bot = await botWithModel(h);
    const done = ended(h);
    await send(h, bot, "Do something");
    const message = await done;
    expect(message.status).toBe("error");
    expect(message.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
  });

  it("saves no count, not zero, when the model reported none", async () => {
    h = await makeHarness({
      handlers: fakeOllama(() => ndjson([{ message: { content: "Hi" } }, { done: true }])),
    });
    const bot = await botWithModel(h);
    const done = ended(h);
    await send(h, bot, "Hello");
    const message = await done;
    expect(message.status).toBe("done");
    expect(message.usage).toBeNull();
  });

  it("still counts a turn whose model did report", async () => {
    h = await makeHarness({
      handlers: fakeOllama(() =>
        ndjson([{ message: { content: "Hi" } }, { done: true, prompt_eval_count: 7, eval_count: 2 }]),
      ),
    });
    const bot = await botWithModel(h);
    const done = ended(h);
    await send(h, bot, "Hello");
    expect((await done).usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });
});

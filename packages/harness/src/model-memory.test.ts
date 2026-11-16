import { afterEach, describe, expect, it } from "vitest";

import { messageText, type Bot } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, type TestHarness } from "./testing";

/**
 * Local models in memory: one at a time when bots use different ones (a Coding Bot's Planner, Developer and QA), the
 * old one freed when nothing uses it any more. The fake Ollama records every /api/chat body: an unload is keep_alive 0.
 */
let h: TestHarness;
afterEach(async () => {
  await h?.close();
});

const MODELS = ["a:1b", "b:1b"].map((name) => ({
  name,
  size: 1,
  capabilities: ["completion", "tools"],
  details: { context_length: 8192 },
}));

async function harness() {
  h = await makeHarness({
    handlers: {
      ...fakeOllama(() => ndjson([{ message: { content: "Done." } }, { done: true }])),
      "/api/tags": () => Response.json({ models: MODELS }),
      "/api/show": () => Response.json({ capabilities: ["completion", "tools"], model_info: {} }),
    },
  });
  h.services.runtime.update({ sharedModel: "ollama:a:1b" });
  return h;
}

/** What reached Ollama's chat endpoint, as "chat <model>" or "unload <model>". */
const traffic = () =>
  h.calls
    .filter((call) => call.path === "/api/chat")
    .map(
      (call) =>
        `${call.body.keep_alive === 0 ? "unload" : (call.body.messages?.length ?? 0) > 0 ? "chat" : "load"} ${call.body.model}`,
    );

const makeBot = async (name: string, model: string) =>
  (await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name, model } })).json()
    .bot as Bot;

/** Sends a message and waits for the bot's reply to finish. */
async function ask(bot: Bot) {
  await h.app.inject({
    method: "POST",
    url: `/api/threads/${bot.threadId}/messages`,
    headers: auth,
    payload: { text: "Go" },
  });
  for (let i = 0; i < 200; i++) {
    const reply = h.store.messages.list(bot.threadId).find((m) => m.role === "bot" && m.status === "done");
    if (reply && messageText(reply)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no reply");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

describe("one local model at a time", () => {
  it("unloads the other model before a bot on a different one starts, and shares one model", async () => {
    await harness();
    const planner = await makeBot("Planner", "ollama:a:1b");
    const developer = await makeBot("Developer", "ollama:b:1b");
    const qa = await makeBot("QA", "ollama:b:1b");
    await ask(planner);
    await ask(developer);
    await ask(qa);
    const seen = traffic().filter((line) => !line.startsWith("load"));
    // a for the Planner; a unloaded before b for the Developer; QA shares b, so nothing is unloaded.
    expect(seen.filter((line) => /^(chat|unload)/.test(line))).toEqual(
      expect.arrayContaining(["chat a:1b", "unload a:1b", "chat b:1b"]),
    );
    expect(seen.indexOf("unload a:1b")).toBeLessThan(seen.indexOf("chat b:1b"));
    expect(seen.filter((line) => line === "unload b:1b")).toEqual([]);
  });

  it("keeps both loaded when the switch is off", async () => {
    await harness();
    h.services.runtime.update({ oneModelAtATime: false });
    await ask(await makeBot("Planner", "ollama:a:1b"));
    await ask(await makeBot("Developer", "ollama:b:1b"));
    expect(traffic().filter((line) => line.startsWith("unload"))).toEqual([]);
  });
});

describe("a model nothing uses any more", () => {
  it("is unloaded after any model change, wherever it happens, unless a bot still uses it", async () => {
    await harness();
    h.services.runtime.update({ oneModelAtATime: false });
    const ann = await makeBot("Ann", "ollama:b:1b");
    const ben = await makeBot("Ben", "ollama:b:1b");
    await ask(ann);
    // Changed straight in the store, the way a Coding Bot sets its roles' models; Ben still uses b.
    const update = (bot: Bot, model: string | null) => {
      const updated = h.store.bots.update(bot.id, { model })!;
      h.bus.publish({ type: "bot.updated", bot: updated });
    };
    update(ann, null);
    await settle();
    expect(traffic().filter((line) => line.startsWith("unload"))).toEqual([]);
    update(ben, null);
    await settle();
    expect(traffic().filter((line) => line.startsWith("unload"))).toEqual(["unload b:1b"]);
  });
});

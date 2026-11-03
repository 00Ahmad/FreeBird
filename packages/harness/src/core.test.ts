import { describe, expect, it } from "vitest";

import type { ChatProvider } from "@mrog/providers";
import { ProviderRegistry } from "@mrog/providers";
import { newId, type Bot, type Message, type ModelInfo, type Thread } from "@mrog/shared";

import { EventBus } from "./bus";
import { ModelCatalog } from "./catalog";
import { buildSystemPrompt } from "./prompt";

const message = (text: string, id = newId("msg")) =>
  ({
    id,
    threadId: newId("thr"),
    role: "bot",
    botId: null,
    moderator: false,
    parts: [{ type: "text", text }],
    status: "streaming",
    model: null,
    usage: null,
    replyToId: null,
    reactions: [],
    createdAt: new Date().toISOString(),
  }) as Message;

describe("event replay", () => {
  it("replays only the newest full copy of a message, keeping the order of everything else", () => {
    const bus = new EventBus();
    const start = bus.publish({ type: "bot.deleted", botId: newId("bot") });
    const id = newId("msg");
    bus.publish({ type: "message.updated", message: message("one", id) });
    bus.publish({ type: "bot.deleted", botId: newId("bot") });
    bus.publish({ type: "message.updated", message: message("two", id) });
    const replay = bus.since(start.id)!;
    expect(replay.map((event) => event.type)).toEqual(["bot.deleted", "message.updated"]);
    const last = replay.at(-1);
    expect(last?.type === "message.updated" && last.message.parts).toEqual([{ type: "text", text: "two" }]);
  });

  it("can still resume after an event whose copy was replaced", () => {
    const bus = new EventBus();
    const id = newId("msg");
    const first = bus.publish({ type: "message.updated", message: message("one", id) });
    bus.publish({ type: "message.updated", message: message("two", id) });
    expect(bus.since(first.id)?.map((event) => event.type)).toEqual(["message.updated"]);
  });
});

describe("model catalog", () => {
  it("doesn't let a load that began before a refresh fill the cache", async () => {
    const registry = new ProviderRegistry();
    let models: ModelInfo[] = [];
    let release: () => void = () => {};
    const provider = {
      id: "fake",
      label: "Fake",
      kind: "openai",
      local: false,
      listModels: async () => {
        const answer = models;
        await new Promise<void>((resolve) => (release = resolve));
        return answer;
      },
      chat: async function* () {},
    } as unknown as ChatProvider;
    registry.register(provider);
    const catalog = new ModelCatalog(registry);

    const stale = catalog.all();
    // A provider gained a model while the first load was still running.
    models = [{ ref: "fake:new" } as ModelInfo];
    catalog.invalidate();
    const releaseStale = release;
    const fresh = catalog.all();
    release();
    releaseStale();
    await stale;
    expect((await fresh).models.map((model) => model.ref)).toEqual(["fake:new"]);
    expect((await catalog.all()).models.map((model) => model.ref)).toEqual(["fake:new"]);
  });
});

describe("system prompt", () => {
  it("names the date and hour, not the exact time, so it stays the same all hour", () => {
    const bot = { name: "Ada", label: null, instructions: "" } as unknown as Bot;
    const thread = { kind: "direct" } as Thread;
    const at = (minute: number) =>
      buildSystemPrompt(bot, { thread, teammates: [], now: new Date(2026, 10, 3, 16, minute, 12, 345) });
    expect(at(1)).toBe(at(59));
    expect(at(1)).toContain("2026-11-03");
    expect(at(1)).toContain("16:00 and 17:00");
  });
});

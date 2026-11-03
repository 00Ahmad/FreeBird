import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RUNTIME_SETTINGS,
  messageText,
  nextRun,
  type Bot,
  type Message,
  type Routine,
} from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("nextRun", () => {
  it("finds the next weekly slot, skipping days and past times", () => {
    const wed = new Date(2026, 9, 28, 9, 0); // Wednesday 09:00 local
    const trigger = { type: "weekly" as const, days: [1, 3], times: ["08:00", "14:00"] };
    expect(nextRun(trigger, wed)).toEqual(new Date(2026, 9, 28, 14, 0));
    expect(nextRun(trigger, new Date(2026, 9, 28, 15, 0))).toEqual(new Date(2026, 10, 2, 8, 0)); // next Monday
  });

  it("handles intervals, one-offs, webhooks and manual routines", () => {
    const now = new Date("2026-10-31T10:00:00Z");
    expect(nextRun({ type: "interval", minutes: 30 }, now, new Date("2026-10-31T09:50:00Z"))).toEqual(
      new Date("2026-10-31T10:20:00Z"),
    );
    expect(nextRun({ type: "once", at: "2026-11-01T08:00:00Z" }, now)).toEqual(
      new Date("2026-11-01T08:00:00Z"),
    );
    const ran = new Date("2026-11-01T08:00:20Z");
    expect(nextRun({ type: "once", at: "2026-11-01T08:00:00Z" }, ran, ran)).toBeNull();
    expect(nextRun({ type: "webhook" }, now)).toBeNull();
    expect(nextRun({ type: "manual" }, now)).toBeNull();
  });
});

async function setup() {
  const prompts: string[] = [];
  h = await makeHarness({
    handlers: fakeOllama((body) => {
      prompts.push(body.messages.at(-1).content);
      return ndjson([{ message: { content: "Report: all good." } }, { done: true }]);
    }),
  });
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const bot = (
    await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ops" } })
  ).json().bot as Bot;
  return { bot, prompts };
}

const routineDone = () =>
  nextEvent<Message>(
    h!.bus,
    (e) =>
      e.type === "message.updated" && e.message.role === "bot" && e.message.status === "done" && e.message,
  );

describe("routines", () => {
  it("runs due routines in the bot's chat and schedules the next run", async () => {
    const { bot, prompts } = await setup();
    const created = await h!.app.inject({
      method: "POST",
      url: "/api/routines",
      headers: auth,
      payload: {
        botId: bot.id,
        name: "Inbox check",
        prompt: "Check the inbox and summarize.",
        trigger: { type: "interval", minutes: 60 },
      },
    });
    expect(created.statusCode).toBe(201);
    const routine = created.json().routine as Routine;
    expect(routine.nextRunAt).not.toBeNull();

    const done = routineDone();
    await h!.services.routines.tick(new Date(Date.now() + 61 * 60_000));
    const reply = await done;
    expect(messageText(reply)).toBe("Report: all good.");
    expect(prompts[0]).toContain("Routine “Inbox check”");
    expect(prompts[0]).toContain("Check the inbox and summarize.");

    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = h!.store.routines.get(routine.id)!;
    expect(after.lastStatus).toBe("done");
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(Date.parse(after.lastRunAt!));
    const messages = (
      await h!.app.inject({ url: `/api/threads/${bot.threadId}/messages`, headers: auth })
    ).json().messages;
    expect(messages.map((m: Message) => m.role)).toEqual(["system", "bot"]);
  });

  it("runs on demand, and pauses", async () => {
    const { bot } = await setup();
    const routine = (
      await h!.app.inject({
        method: "POST",
        url: "/api/routines",
        headers: auth,
        payload: {
          botId: bot.id,
          name: "Taught task",
          prompt: "1. Open notes\n2. Summarize",
          trigger: { type: "manual" },
        },
      })
    ).json().routine as Routine;
    expect(routine.nextRunAt).toBeNull();
    const done = routineDone();
    expect(
      (await h!.app.inject({ method: "POST", url: `/api/routines/${routine.id}/run`, headers: auth }))
        .statusCode,
    ).toBe(202);
    await done;

    const paused = await h!.app.inject({
      method: "PATCH",
      url: `/api/routines/${routine.id}`,
      headers: auth,
      payload: { enabled: false },
    });
    expect(paused.json().routine).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("rejects moving a routine to a bot that doesn't exist", async () => {
    const { bot } = await setup();
    const routine = h!.store.routines.create({
      botId: bot.id,
      name: "Daily",
      prompt: "Report.",
      trigger: { type: "manual" },
    });
    const res = await h!.app.inject({
      method: "PATCH",
      url: `/api/routines/${routine.id}`,
      headers: auth,
      payload: { botId: `bot_${"0".repeat(32)}` },
    });
    expect(res.statusCode).toBe(400);
    expect(h!.store.routines.get(routine.id)?.botId).toBe(bot.id);
  });

  it("accepts webhooks only with the routine's secret and passes the payload on", async () => {
    const { bot, prompts } = await setup();
    const routine = (
      await h!.app.inject({
        method: "POST",
        url: "/api/routines",
        headers: auth,
        payload: {
          botId: bot.id,
          name: "New order",
          prompt: "Handle this order.",
          trigger: { type: "webhook" },
        },
      })
    ).json().routine as Routine;
    expect(routine.webhookSecret).toMatch(/^[\w-]{20,}$/);

    const wrong = await h!.app.inject({
      method: "POST",
      url: `/hooks/${routine.id}?key=nope`,
      payload: { id: 1 },
    });
    expect(wrong.statusCode).toBe(404);

    const done = routineDone();
    const ok = await h!.app.inject({
      method: "POST",
      url: `/hooks/${routine.id}?key=${routine.webhookSecret}`,
      payload: { order: 42, item: "lamp" },
    });
    expect(ok.statusCode).toBe(202);
    await done;
    expect(prompts[0]).toContain('"order": 42');
  });

  it("answers a webhook with 409 when its routine can't run, instead of accepting it", async () => {
    const { bot } = await setup();
    const routine = h!.store.routines.create({
      botId: bot.id,
      name: "Hook",
      prompt: "Go.",
      trigger: { type: "webhook" },
    });
    // Its bot is gone (as while the bot is being deleted).
    vi.spyOn(h!.store.bots, "get").mockReturnValue(null);
    const res = await h!.app.inject({
      method: "POST",
      url: `/hooks/${routine.id}?key=${routine.webhookSecret}`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const run = await h!.app.inject({
      method: "POST",
      url: `/api/routines/${routine.id}/run`,
      headers: auth,
    });
    expect(run.statusCode).toBe(409);
  });

  it("keeps ticking when reading the due routines fails", async () => {
    await setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const due = vi.spyOn(h!.store.routines, "due").mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      await expect(h!.services.routines.tick()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      due.mockRestore();
      error.mockRestore();
    }
  });

  it("validates triggers", async () => {
    const { bot } = await setup();
    const bad = await h!.app.inject({
      method: "POST",
      url: "/api/routines",
      headers: auth,
      payload: { botId: bot.id, name: "x", prompt: "y", trigger: { type: "interval", minutes: 1 } },
    });
    expect(bad.statusCode).toBe(400);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, ROUTINE_MARKER, type Bot, type RoutineInput } from "@mrog/shared";

import { RoutineRunner } from "./routines";
import { auth, fakeOllama, makeHarness, ndjson, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const HOUR = 3_600_000;

/** A harness whose model holds the first request until `release()` (a routine that is still running). */
async function setup() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  h = await makeHarness({
    handlers: fakeOllama(async () => {
      if (++calls === 1) await gate;
      return ndjson([{ message: { content: "Sent the report." } }, { done: true }]);
    }),
  });
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const bot = (
    await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ops" } })
  ).json().bot as Bot;
  /** A routine that was created `ago` ms back, so its first run is already due. */
  const due = (trigger: RoutineInput["trigger"], ago = 2 * HOUR) =>
    h!.store.routines.create(
      { botId: bot.id, name: "Report", prompt: "Send the report.", trigger },
      new Date(Date.now() - ago),
    );
  /** Another runner on the same database: the app after a restart. */
  const restarted = () => new RoutineRunner({ store: h!.store, bus: h!.bus, turns: h!.services.turns });
  const started = () =>
    h!.store.messages.list(bot.threadId).filter((m) => m.role === "system" && m.parts.some(isRoutine));
  const isRoutine = (part: { type: string; text?: string }) =>
    part.type === "text" && part.text?.startsWith(ROUTINE_MARKER);
  return { bot, due, restarted, started, release, calls: () => calls };
}

describe("a routine that was running when the app quit", () => {
  it("isn't run again from scratch at the next start", async () => {
    const { due, restarted, started, release } = await setup();
    const routine = due({ type: "interval", minutes: 60 });
    expect(Date.parse(routine.nextRunAt!)).toBeLessThan(Date.now());

    await h!.services.routines.tick();
    await vi.waitFor(() => expect(started()).toHaveLength(1));
    // The next run is already set, though the reply hasn't come back.
    expect(Date.parse(h!.store.routines.get(routine.id)!.nextRunAt!)).toBeGreaterThan(Date.now());

    // The app is closed and opened again: the catch-up check finds nothing due.
    await restarted().tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started()).toHaveLength(1);
    release();
  });

  it("is not run a second time when it was a one-off", async () => {
    const { due, restarted, started, release } = await setup();
    const routine = due({ type: "once", at: new Date(Date.now() - HOUR).toISOString() });
    expect(routine.nextRunAt).not.toBeNull();

    await h!.services.routines.tick();
    await vi.waitFor(() => expect(started()).toHaveLength(1));
    expect(h!.store.routines.get(routine.id)!.nextRunAt).toBeNull();

    await restarted().tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started()).toHaveLength(1);
    release();
  });

  it("still runs when it came due and never started", async () => {
    const { due, restarted, started, release } = await setup();
    const interval = due({ type: "interval", minutes: 60 });
    const once = due({ type: "once", at: new Date(Date.now() - HOUR).toISOString() }, 3 * HOUR);
    release();

    await restarted().tick();
    await vi.waitFor(() => expect(started()).toHaveLength(2));
    await vi.waitFor(() => expect(h!.store.routines.get(once.id)!.lastStatus).toBe("done"));
    await vi.waitFor(() => expect(h!.store.routines.get(interval.id)!.lastStatus).toBe("done"));
    // Each ran once, and the interval goes on from here.
    expect(h!.store.routines.get(once.id)!.nextRunAt).toBeNull();
    expect(Date.parse(h!.store.routines.get(interval.id)!.nextRunAt!)).toBeGreaterThan(Date.now());
    await restarted().tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started()).toHaveLength(2);
  });

  it("leaves a routine's schedule alone when it is run early, by hand", async () => {
    const { due, release } = await setup();
    release();
    const interval = due({ type: "interval", minutes: 60 }, 30 * 60_000);
    const later = new Date(Date.now() + HOUR).toISOString();
    const once = due({ type: "once", at: later }, 60_000);
    const before = { interval: interval.nextRunAt, once: once.nextRunAt };

    await h!.services.routines.run(interval);
    await h!.services.routines.run(once);
    expect(h!.store.routines.get(interval.id)!.nextRunAt).toBe(before.interval);
    // Run before its time: it still happens at its time.
    expect(h!.store.routines.get(once.id)!.nextRunAt).toBe(before.once);
  });
});

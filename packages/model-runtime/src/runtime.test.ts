import { describe, expect, it } from "vitest";

import { OllamaProvider } from "@mrog/providers";
import { DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from "@mrog/shared";

import { ModelRuntime } from ".";

function runtime(
  over: Partial<RuntimeSettings> = {},
  timing: ConstructorParameters<typeof ModelRuntime>[3] = {},
) {
  let settings: RuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS, ...over };
  const ollama = new OllamaProvider(
    "ollama",
    "Ollama",
    () => "http://127.0.0.1:1",
    async () => {
      throw new Error("offline");
    },
  );
  return new ModelRuntime(
    { load: () => settings, save: (next) => (settings = next) },
    ollama,
    undefined,
    timing,
  );
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ModelRuntime queue aging", () => {
  /** A runtime with a clock the test moves; one minute of waiting is worth one rank. */
  function aged() {
    let now = 0;
    const rt = runtime({}, { agingMs: 60_000, now: () => now });
    const order: string[] = [];
    const take = (priority: "user" | "routine" | "background", name: string) =>
      rt.acquire(priority).then((release) => {
        order.push(name);
        release();
      });
    return { rt, order, take, advance: (ms: number) => (now += ms) };
  }

  it("lets a background job that has waited long enough go before a user who just arrived", async () => {
    const { rt, order, take, advance } = aged();
    const hold = await rt.acquire("user");
    const waits = [take("background", "old-background")];
    advance(150_000); // two and a half minutes: two ranks up, as urgent as a user's chat
    waits.push(take("user", "new-user"));
    hold();
    await Promise.all(waits);
    expect(order).toEqual(["old-background", "new-user"]);
  });

  it("still serves a user who was there first, and one who has waited just as long", async () => {
    const { rt, order, take, advance } = aged();
    const hold = await rt.acquire("user");
    const waits = [take("user", "first-user")];
    advance(1_000);
    waits.push(take("background", "background"));
    advance(150_000);
    waits.push(take("user", "late-user"));
    hold();
    await Promise.all(waits);
    // The background job is as urgent as a user by now, but the user queued before it.
    expect(order).toEqual(["first-user", "background", "late-user"]);
  });

  it("moves up a rank at a time, and never past a user", async () => {
    const { rt, order, take, advance } = aged();
    const hold = await rt.acquire("user");
    const waits = [take("background", "background")];
    advance(61_000); // one rank: now routine-level
    waits.push(take("routine", "fresh-routine"));
    waits.push(take("user", "user"));
    hold();
    await Promise.all(waits);
    // A user first; then the background job (older, now routine-level) before the fresh routine.
    expect(order).toEqual(["user", "background", "fresh-routine"]);
  });

  it("changes nothing before anyone has waited a minute: priority, then first come first served", async () => {
    const { rt, order, take, advance } = aged();
    const hold = await rt.acquire("user");
    const waits = [take("background", "b")];
    advance(10_000);
    waits.push(take("routine", "r1"));
    advance(10_000);
    waits.push(take("user", "u"));
    advance(10_000);
    waits.push(take("routine", "r2"));
    hold();
    await Promise.all(waits);
    expect(order).toEqual(["u", "r1", "r2", "b"]);
  });

  it("keeps first come first served among requests that aged to the same urgency", async () => {
    const { rt, order, take, advance } = aged();
    const hold = await rt.acquire("user");
    const waits = [take("routine", "routine-a")];
    advance(5_000);
    waits.push(take("background", "background-b"));
    advance(200_000); // both are now as urgent as a user's chat
    hold();
    await Promise.all(waits);
    expect(order).toEqual(["routine-a", "background-b"]);
  });

  it("drops an aborted waiter whatever its age", async () => {
    const { rt, take, advance } = aged();
    const hold = await rt.acquire("user");
    const controller = new AbortController();
    const waiting = rt.acquire("background", { signal: controller.signal });
    const other = take("user", "other");
    advance(500_000);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    expect(rt.queueState()).toEqual({ running: 1, waiting: 1 });
    hold();
    await other;
  });
});

describe("ModelRuntime queue", () => {
  it("runs one at a time by default and grants by priority, then FIFO", async () => {
    const rt = runtime();
    const order: string[] = [];
    const first = await rt.acquire("user");
    const take = (priority: "user" | "routine" | "background", name: string) =>
      rt.acquire(priority).then((release) => {
        order.push(name);
        release();
      });
    const waits = [
      take("background", "background"),
      take("routine", "routine-1"),
      take("user", "user"),
      take("routine", "routine-2"),
    ];
    expect(rt.queueState()).toEqual({ running: 1, waiting: 4 });

    first();
    await Promise.all(waits);
    expect(order).toEqual(["user", "routine-1", "routine-2", "background"]);
    expect(rt.queueState()).toEqual({ running: 0, waiting: 0 });
  });

  it("honors the parallel setting and frees waiters when it grows", async () => {
    const rt = runtime({ parallel: 1 });
    const a = await rt.acquire("user");
    let bGranted = false;
    const b = rt.acquire("user").then((release) => ((bGranted = true), release));
    await tick();
    expect(bGranted).toBe(false);
    rt.update({ parallel: 2 });
    (await b)();
    expect(bGranted).toBe(true);
    a();
  });

  it("drops an aborted waiter", async () => {
    const rt = runtime();
    const hold = await rt.acquire("user");
    const controller = new AbortController();
    const waiting = rt.acquire("user", { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    expect(rt.queueState()).toEqual({ running: 1, waiting: 0 });
    hold();
    hold();
    expect(rt.queueState()).toEqual({ running: 0, waiting: 0 });
  });

  it("reports an unreachable Ollama instead of throwing", async () => {
    const status = await runtime().status();
    expect(status.ollama.reachable).toBe(false);
    expect(status.loaded).toEqual([]);
  });

  it("validates settings", () => {
    expect(() => runtime().update({ keepAlive: "forever" })).toThrow();
    expect(runtime().update({ keepAlive: "-1" }).keepAlive).toBe("-1");
  });
});

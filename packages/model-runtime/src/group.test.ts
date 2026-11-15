import { describe, expect, it } from "vitest";

import { OllamaProvider } from "@mrog/providers";
import { DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from "@mrog/shared";

import { ModelRuntime, RequestGroup } from ".";

function runtime(over: Partial<RuntimeSettings> = {}) {
  let settings: RuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS, ...over };
  const ollama = new OllamaProvider(
    "ollama",
    "Ollama",
    () => "http://127.0.0.1:1",
    async () => {
      throw new Error("offline");
    },
  );
  return new ModelRuntime({ load: () => settings, save: (next) => (settings = next) }, ollama);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RequestGroup", () => {
  it("lets one turn's requests run together on a single slot, while another bot waits", async () => {
    const rt = runtime({ parallel: 1 });
    const group = rt.group("user", { lanes: 3, local: true });
    const releases = await Promise.all([group.acquire(), group.acquire(), group.acquire()]);
    // Three requests in flight; the model's one slot is held once.
    expect(group.active).toBe(3);
    expect(rt.queueState()).toEqual({ running: 1, waiting: 0 });

    let other = false;
    const waiting = rt.acquire("user").then((release) => ((other = true), release));
    await tick();
    expect(other).toBe(false);
    // Still held while any request is in flight.
    releases[0]!();
    releases[1]!();
    await tick();
    expect(other).toBe(false);
    releases[2]!();
    (await waiting)();
    expect(other).toBe(true);
  });

  it("gives the slot back whenever every request is waiting on something else, and takes it again after", async () => {
    const rt = runtime({ parallel: 1 });
    const group = rt.group("user", { lanes: 3, local: true });
    const first = await group.acquire();
    first();
    expect(rt.queueState()).toEqual({ running: 0, waiting: 0 });
    // Another bot gets the model in between.
    (await rt.acquire("user"))();
    const again = await group.acquire();
    expect(rt.queueState()).toEqual({ running: 1, waiting: 0 });
    again();
    expect(rt.queueState()).toEqual({ running: 0, waiting: 0 });
  });

  it("lets only `lanes` requests run together and starts the next as one ends", async () => {
    const rt = runtime({ parallel: 1 });
    const group = rt.group("user", { lanes: 2, local: true });
    let peak = 0;
    const order: number[] = [];
    const lane = async (n: number, ms: number) => {
      const release = await group.acquire();
      peak = Math.max(peak, group.active);
      order.push(n);
      await new Promise((resolve) => setTimeout(resolve, ms));
      release();
    };
    await Promise.all([lane(1, 30), lane(2, 30), lane(3, 5)]);
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3]);
    expect(rt.queueState()).toEqual({ running: 0, waiting: 0 });
  });

  it("runs one at a time with a single lane", async () => {
    const rt = runtime({ parallel: 3 });
    const group = rt.group("user", { lanes: 1, local: true });
    const first = await group.acquire();
    let second = false;
    const next = group.acquire().then((release) => ((second = true), release));
    await tick();
    expect(second).toBe(false);
    first();
    (await next)();
    expect(second).toBe(true);
  });

  it("counts as one bot at once however many lanes it has: the other slots stay free", async () => {
    const rt = runtime({ parallel: 2 });
    const group = rt.group("user", { lanes: 3, local: true });
    const releases = await Promise.all([group.acquire(), group.acquire(), group.acquire()]);
    expect(rt.queueState()).toEqual({ running: 1, waiting: 0 });
    // A second bot still fits beside it.
    const other = await rt.acquire("user");
    expect(rt.queueState()).toEqual({ running: 2, waiting: 0 });
    other();
    releases.forEach((release) => release());
  });

  it("waits for the model's slot behind other bots, queueing every request of the group behind it", async () => {
    const rt = runtime({ parallel: 1 });
    const hold = await rt.acquire("user");
    const group = rt.group("user", { lanes: 3, local: true });
    let granted = 0;
    const lanes = [0, 1, 2].map(() => group.acquire().then((release) => (granted++, release)));
    await tick();
    expect(granted).toBe(0);
    // One attempt at the slot, not three.
    expect(rt.queueState()).toEqual({ running: 1, waiting: 1 });
    hold();
    const releases = await Promise.all(lanes);
    expect(granted).toBe(3);
    releases.forEach((release) => release());
    expect(rt.queueState()).toEqual({ running: 0, waiting: 0 });
  });

  it("is stopped by the turn's signal while it waits for the slot, leaving nothing behind", async () => {
    const rt = runtime({ parallel: 1 });
    const hold = await rt.acquire("user");
    const controller = new AbortController();
    const group = rt.group("user", { lanes: 3, local: true, signal: controller.signal });
    const waits = [group.acquire(), group.acquire()].map((wait) =>
      wait.catch((error: { code?: string }) => error),
    );
    await tick();
    controller.abort();
    const results = await Promise.all(waits);
    expect(results.map((result) => (result as { code?: string }).code)).toEqual(["aborted", "aborted"]);
    expect(group.active).toBe(0);
    expect(rt.queueState()).toEqual({ running: 1, waiting: 0 });
    hold();
    expect(rt.queueState()).toEqual({ running: 0, waiting: 0 });
  });

  it("drops a request that is stopped while it waits for a place among the lanes", async () => {
    const rt = runtime({ parallel: 1 });
    const group = rt.group("user", { lanes: 1, local: true });
    const first = await group.acquire();
    const controller = new AbortController();
    const waiting = group.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    first();
    // The place was not lost to the dropped request.
    (await group.acquire())();
    expect(rt.queueState()).toEqual({ running: 0, waiting: 0 });
  });

  it("limits a model that has no slot (a cloud one) without touching the runtime", async () => {
    const rt = runtime({ parallel: 1 });
    const group = rt.group("user", { lanes: 3, local: false });
    const releases = await Promise.all([group.acquire(), group.acquire(), group.acquire()]);
    expect(rt.queueState()).toEqual({ running: 0, waiting: 0 });
    releases.forEach((release) => release());
  });

  it("does not change how ordinary requests are queued (races take one at a time)", async () => {
    const rt = runtime({ parallel: 1 });
    const group = new RequestGroup(null, 3);
    const first = await group.acquire();
    const order: string[] = [];
    const a = await rt.acquire("user");
    const b = rt.acquire("user").then((release) => (order.push("b"), release));
    await tick();
    expect(order).toEqual([]);
    a();
    (await b)();
    first();
    expect(order).toEqual(["b"]);
  });
});

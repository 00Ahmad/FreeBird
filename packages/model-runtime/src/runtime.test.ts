import { describe, expect, it } from "vitest";

import { OllamaProvider } from "@mrog/providers";
import { DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from "@mrog/shared";

import { ModelRuntime } from ".";

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

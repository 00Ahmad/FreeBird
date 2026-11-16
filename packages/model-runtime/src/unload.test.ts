import { describe, expect, it } from "vitest";

import type { OllamaProvider } from "@mrog/providers";
import { DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from "@mrog/shared";

import { ModelRuntime } from ".";

/** A stand-in Ollama that records what was loaded and unloaded, in order. */
function fakeOllama(unloadMs = 0) {
  const log: string[] = [];
  const used = new Set<string>();
  const ollama = {
    id: "ollama",
    async warm(name: string) {
      used.add(name);
      log.push(`load ${name}`);
    },
    async unload(name: string, signal?: AbortSignal) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, unloadMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      used.delete(name);
      log.push(`unload ${name}`);
    },
    usedModels: () => [...used],
    status: async () => ({ loaded: [] }),
  };
  return { ollama: ollama as unknown as OllamaProvider, log, used };
}

function runtime(over: Partial<RuntimeSettings> = {}, unloadMs = 0) {
  let settings: RuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:old:9b", ...over };
  const fake = fakeOllama(unloadMs);
  const rt = new ModelRuntime({ load: () => settings, save: (next) => (settings = next) }, fake.ollama);
  return { rt, ...fake };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("loading and unloading models", () => {
  it("unloads the old shared model before loading the new one", async () => {
    const { rt, log } = runtime();
    rt.update({ sharedModel: "ollama:new:9b" });
    await settle();
    expect(log).toEqual(["unload old:9b", "load new:9b"]);
  });

  it("keeps the old model when a bot is still set to use it", async () => {
    const { rt, log } = runtime();
    rt.inUse = (name) => name === "old:9b";
    rt.update({ sharedModel: "ollama:new:9b" });
    await settle();
    expect(log).toEqual(["load new:9b"]);
  });

  it("never unloads the shared model, a cloud model, or nothing", () => {
    const { rt } = runtime();
    expect(rt.release("ollama:old:9b")).toBe(false);
    expect(rt.release("openai:gpt-5")).toBe(false);
    expect(rt.release(null)).toBe(false);
    expect(rt.release("ollama:other:3b")).toBe(true);
  });

  it("waits for a reply still being written on the model before unloading it", async () => {
    const { rt, log } = runtime();
    const busy = await rt.acquire("user");
    rt.release("ollama:other:3b");
    await settle();
    expect(log).toEqual([]);
    busy();
    await settle();
    expect(log).toEqual(["unload other:3b"]);
  });

  it("unloads every model it loaded when the app closes, giving up after the time limit", async () => {
    const { rt, ollama, log } = runtime({}, 0);
    await ollama.warm("a:1b", { numCtx: 1, keepAlive: "1m" });
    await ollama.warm("b:1b", { numCtx: 1, keepAlive: "1m" });
    expect((await rt.unloadUsed(500)).toSorted()).toEqual(["a:1b", "b:1b"]);
    expect(log.filter((l) => l.startsWith("unload")).toSorted()).toEqual(["unload a:1b", "unload b:1b"]);

    const slow = runtime({}, 5_000);
    await slow.ollama.warm("c:1b", { numCtx: 1, keepAlive: "1m" });
    const started = Date.now();
    await slow.rt.unloadUsed(100);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("one local model at a time", () => {
  it("unloads the other loaded models before a request to another one", async () => {
    const { rt, ollama, log } = runtime();
    await ollama.warm("a:1b", { numCtx: 1, keepAlive: "1m" });
    const release = await rt.acquire("user");
    expect(await rt.swapTo("b:1b")).toEqual(["a:1b"]);
    release();
    expect(log).toEqual(["load a:1b", "unload a:1b"]);
  });

  it("does nothing for the model already loaded, when switched off, or while other requests run", async () => {
    const one = runtime();
    await one.ollama.warm("a:1b", { numCtx: 1, keepAlive: "1m" });
    expect(await one.rt.swapTo("a:1b")).toEqual([]);

    const off = runtime({ oneModelAtATime: false });
    await off.ollama.warm("a:1b", { numCtx: 1, keepAlive: "1m" });
    expect(await off.rt.swapTo("b:1b")).toEqual([]);

    const busy = runtime({ parallel: 2 });
    await busy.ollama.warm("a:1b", { numCtx: 1, keepAlive: "1m" });
    const first = await busy.rt.acquire("user");
    const second = await busy.rt.acquire("user");
    expect(await busy.rt.swapTo("b:1b")).toEqual([]);
    first();
    second();
  });

  it("unloads what nothing is set to use, keeping the shared model and bots' own models", async () => {
    const { rt, ollama } = runtime();
    for (const name of ["old:9b", "kept:3b", "gone:3b"])
      await ollama.warm(name, { numCtx: 1, keepAlive: "1m" });
    rt.inUse = (name) => name === "kept:3b";
    expect(rt.releaseUnused()).toEqual(["gone:3b"]);
  });
});

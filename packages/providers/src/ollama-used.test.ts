import { describe, expect, it } from "vitest";

import { OllamaProvider } from "./ollama";

describe("models the app loaded", () => {
  it("are remembered when used, and forgotten once unloaded", async () => {
    const bodies: { model: string; keep_alive?: unknown }[] = [];
    const ollama = new OllamaProvider(
      "ollama",
      "Ollama",
      () => "http://127.0.0.1:1",
      async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    );
    expect(ollama.usedModels()).toEqual([]);
    await ollama.warm("qwen3.5:9b", { numCtx: 4096, keepAlive: "30m" });
    expect(ollama.usedModels()).toEqual(["qwen3.5:9b"]);
    await ollama.unload("qwen3.5:9b");
    expect(ollama.usedModels()).toEqual([]);
    expect(bodies.at(-1)).toMatchObject({ model: "qwen3.5:9b", keep_alive: 0 });
  });
});

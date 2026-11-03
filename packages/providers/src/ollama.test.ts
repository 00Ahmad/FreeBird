import { describe, expect, it } from "vitest";

import { OllamaProvider, type StreamChunk } from ".";

/** A fetch that answers from a table of handlers and records request bodies. */
function fakeFetch(handlers: Record<string, (body: any) => Response>) {
  const calls: { path: string; body: any }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const handler = handlers[path];
    return handler ? handler(body) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const ndjson = (rows: unknown[]) =>
  new Response(new Blob([rows.map((row) => JSON.stringify(row)).join("\n") + "\n"]).stream());

const collect = async (stream: AsyncIterable<StreamChunk>) => {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};

describe("OllamaProvider", () => {
  it("streams text, reasoning and tool calls, sending shared options every time", async () => {
    const { impl, calls } = fakeFetch({
      "/api/chat": () =>
        ndjson([
          { message: { thinking: "hmm" } },
          { message: { content: "Hel" } },
          { message: { content: "lo" } },
          { message: { tool_calls: [{ function: { name: "list_files", arguments: { path: "." } } }] } },
          { done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 5 },
        ]),
    });
    const ollama = new OllamaProvider("ollama", "Ollama", () => "http://x", impl);
    const chunks = await collect(
      ollama.chat({
        model: "qwen3.5:9b",
        messages: [{ role: "user", content: "hi", images: [{ mediaType: "image/png", data: "AAA" }] }],
        tools: [{ name: "list_files", description: "d", parameters: { type: "object" } }],
        think: true,
        local: { numCtx: 8192, keepAlive: "30m" },
      }),
    );

    expect(chunks.map((c) => c.type)).toEqual(["reasoning", "text", "text", "tool_call", "done"]);
    expect(chunks[3]).toMatchObject({ call: { name: "list_files", arguments: { path: "." } } });
    expect(chunks[4]).toEqual({
      type: "done",
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    expect(calls[0]?.body).toMatchObject({
      model: "qwen3.5:9b",
      keep_alive: "30m",
      think: true,
      options: { num_ctx: 8192 },
      messages: [{ role: "user", content: "hi", images: ["AAA"] }],
      tools: [{ type: "function", function: { name: "list_files" } }],
    });
  });

  it("lists models with capabilities and loaded flags", async () => {
    const { impl } = fakeFetch({
      "/api/tags": () =>
        Response.json({
          models: [
            {
              name: "a:1b",
              size: 10,
              capabilities: ["completion", "tools"],
              details: { context_length: 4096 },
            },
            { name: "b:1b", size: 20 },
          ],
        }),
      "/api/ps": () => Response.json({ models: [{ name: "a:1b", size: 10, size_vram: 10 }] }),
      "/api/show": () =>
        Response.json({
          capabilities: ["completion", "vision", "made-up"],
          model_info: { "x.context_length": 2048 },
        }),
    });
    const models = await new OllamaProvider("ollama", "Ollama", () => "http://x", impl).listModels();
    expect(models).toEqual([
      expect.objectContaining({
        ref: "ollama:a:1b",
        capabilities: ["completion", "tools"],
        loaded: true,
        contextWindow: 4096,
      }),
      expect.objectContaining({
        ref: "ollama:b:1b",
        capabilities: ["completion", "vision"],
        loaded: false,
        contextWindow: 2048,
      }),
    ]);
  });

  it("reads a model's details again after its tag is re-pulled", async () => {
    let digest = "d1";
    let context = 2048;
    const { impl, calls } = fakeFetch({
      "/api/tags": () => Response.json({ models: [{ name: "b:1b", digest }] }),
      "/api/ps": () => Response.json({ models: [] }),
      "/api/show": () =>
        Response.json({ capabilities: ["completion"], model_info: { "x.context_length": context } }),
      "/api/pull": () => ndjson([{ status: "success" }]),
    });
    const ollama = new OllamaProvider("ollama", "Ollama", () => "http://x", impl);
    const shows = () => calls.filter((call) => call.path === "/api/show").length;
    await ollama.listModels();
    await ollama.listModels();
    expect(shows()).toBe(1);

    // A newer build of the same tag: a new digest, so the cached details no longer apply.
    digest = "d2";
    context = 8192;
    expect((await ollama.listModels())[0]?.contextWindow).toBe(8192);
    expect(shows()).toBe(2);

    // Pulling clears the cache too, for callers that don't know the digest.
    for await (const progress of ollama.pull("b:1b")) expect(progress.status).toBe("success");
    await ollama.listModels();
    expect(shows()).toBe(3);
  });

  it("maps failures to typed errors", async () => {
    const down = new OllamaProvider("ollama", "Ollama", () => "http://x", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    await expect(collect(down.chat({ model: "m", messages: [] }))).rejects.toMatchObject({
      code: "provider_down",
    });

    const { impl } = fakeFetch({
      "/api/chat": () => Response.json({ error: 'model "nope" not found' }, { status: 404 }),
    });
    const missing = new OllamaProvider("ollama", "Ollama", () => "http://x", impl);
    await expect(collect(missing.chat({ model: "nope", messages: [] }))).rejects.toMatchObject({
      code: "model_missing",
      message: expect.stringContaining("not found"),
    });
  });
});

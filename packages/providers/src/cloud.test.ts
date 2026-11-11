import { describe, expect, it } from "vitest";

import { PROVIDER_PRESETS, type ProviderConfig } from "@mrog/shared";

import { createProvider, toAnthropicMessages, type ChatMessage, type StreamChunk } from ".";

const sse = (events: unknown[]) =>
  new Response(
    new Blob([
      events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""),
    ]).stream(),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );

function capture(handler: (url: string, body: any, headers: Headers) => Response) {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), body, headers });
    return handler(String(input), body, headers);
  }) as typeof fetch;
  return { impl, calls };
}

const collect = async (stream: AsyncIterable<StreamChunk>) => {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};

const config = (preset: string, over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: preset,
  preset,
  label: preset,
  baseUrl: "",
  enabled: true,
  ...over,
});

describe("OpenAI-compatible", () => {
  it("streams text and reasoning, assembles split tool calls, reports usage", async () => {
    const { impl, calls } = capture(() =>
      sse([
        { choices: [{ delta: { reasoning_content: "hmm" } }] },
        { choices: [{ delta: { content: "Hi" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "read_", arguments: '{"pa' } }],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: 'th":"a.txt"}' } }] } },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
        "[DONE]",
      ]),
    );
    const provider = createProvider(config("groq"), () => "gsk-test", impl);
    const chunks = await collect(
      provider.chat({
        model: "llama-3.3-70b",
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "look", images: [{ mediaType: "image/png", data: "AAA" }] },
        ],
        tools: [{ name: "read_file", description: "d", parameters: { type: "object" } }],
      }),
    );
    expect(chunks).toEqual([
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "Hi" },
      { type: "tool_call", call: { id: "call_1", name: "read_file", arguments: { path: "a.txt" } } },
      { type: "done", finishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 4 } },
    ]);
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer gsk-test");
    expect(calls[0]?.body.messages[1].content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
    expect(calls[0]?.body.stream_options).toEqual({ include_usage: true });
  });

  it("sends Azure's key in the api-key header and keeps query strings", async () => {
    const { impl, calls } = capture(() => sse(["[DONE]"]));
    const provider = createProvider(
      config("azure", { baseUrl: "https://r.openai.azure.com/openai/v1?api-version=preview" }),
      () => "az-key",
      impl,
    );
    await collect(provider.chat({ model: "gpt-5", messages: [] }));
    expect(calls[0]?.url).toBe("https://r.openai.azure.com/openai/v1/chat/completions?api-version=preview");
    expect(calls[0]?.headers.get("api-key")).toBe("az-key");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("lists chat models with guessed capabilities and hides non-chat models", async () => {
    const { impl } = capture(() =>
      Response.json({
        data: [{ id: "gpt-5-mini" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "gpt-4o" }],
      }),
    );
    const models = await createProvider(config("openai"), () => "k", impl).listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-5-mini"]);
    expect(models[1]).toMatchObject({
      ref: "openai:gpt-5-mini",
      capabilities: expect.arrayContaining(["tools", "thinking"]),
    });
  });

  it("falls back to known models when /models is missing, but not when the key is wrong", async () => {
    const missing = capture(() => new Response("nope", { status: 404 }));
    const models = await createProvider(config("deepseek"), () => "k", missing.impl).listModels();
    expect(models.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);

    const denied = capture(() => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }));
    await expect(
      createProvider(config("deepseek"), () => "bad", denied.impl).listModels(),
    ).rejects.toMatchObject({
      code: "invalid_key",
      message: expect.stringContaining("Invalid API key"),
    });
  });

  it("treats a local server as local with no key", async () => {
    const { impl, calls } = capture(() => Response.json({ data: [{ id: "qwen2.5-7b-instruct" }] }));
    const provider = createProvider(config("lmstudio"), () => null, impl);
    expect(provider.local).toBe(true);
    await provider.listModels();
    expect(calls[0]?.url).toBe("http://127.0.0.1:1234/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });
});

describe("Anthropic", () => {
  it("streams text, thinking and tool use with usage", async () => {
    const { impl, calls } = capture(() =>
      sse([
        { type: "message_start", message: { usage: { input_tokens: 20 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
        { type: "content_block_start", index: 1, content_block: { type: "text" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "On it" } },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "tu_1", name: "list_files" },
        },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"pa' } },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: 'th":"."}' },
        },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
        { type: "message_stop" },
      ]),
    );
    const provider = createProvider(config("anthropic"), () => "sk-ant", impl);
    const chunks = await collect(
      provider.chat({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        think: true,
      }),
    );
    expect(chunks).toEqual([
      { type: "reasoning", text: "plan" },
      { type: "text", text: "On it" },
      { type: "tool_call", call: { id: "tu_1", name: "list_files", arguments: { path: "." } } },
      { type: "done", finishReason: "tool_use", usage: { inputTokens: 20, outputTokens: 9 } },
    ]);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.headers.get("x-api-key")).toBe("sk-ant");
    expect(calls[0]?.body).toMatchObject({ system: "sys", thinking: { type: "enabled" } });
  });

  it("converts tool results to user blocks and merges same-role turns", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", arguments: { q: 1 } }] },
      { role: "tool", toolCallId: "t1", name: "x", content: "result" },
      { role: "user", content: "b" },
    ];
    expect(toAnthropicMessages(history).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: { q: 1 } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "result" },
          { type: "text", text: "b" },
        ],
      },
    ]);
  });
});

describe("presets", () => {
  it("covers the planned providers with unique ids", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.preset);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "openai",
        "anthropic",
        "google",
        "groq",
        "xai",
        "mistral",
        "deepseek",
        "openrouter",
        "together",
        "fireworks",
        "cerebras",
        "azure",
        "ollama-cloud",
        "lmstudio",
        "vllm",
        "llamacpp",
        "jan",
        "localai",
        "ollama-remote",
        "openai-compatible",
        "anthropic-compatible",
      ]),
    );
  });
});

describe("local detection", () => {
  it("treats loopback and private URLs as local and hides embedding models", async () => {
    const { isLocalUrl, isChatModel } = await import(".");
    expect(isLocalUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalUrl("http://192.168.1.4:1234/v1")).toBe(true);
    expect(isLocalUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalUrl("http://172.20.0.5:8000/v1")).toBe(true);
    expect(isLocalUrl("http://172.40.0.5:8000/v1")).toBe(false);
    expect(isLocalUrl("http://[::1]:1234/v1")).toBe(true);
    expect(isLocalUrl("https://127x0y0z1.example.com")).toBe(false);
    expect(isLocalUrl("http://nas.local:11434")).toBe(true);
    expect(isChatModel("bge-m3:latest")).toBe(false);
    expect(isChatModel("nomic-embed-text")).toBe(false);
    expect(isChatModel("qwen3:4b")).toBe(true);
  });
});

describe("Anthropic thinking and tool history", () => {
  it("keeps a thinking block's signature and sends it back before the tool call", async () => {
    const { impl } = capture(() =>
      sse([
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ]),
    );
    const provider = createProvider(config("anthropic"), () => "sk-ant", impl);
    const chunks = await collect(
      provider.chat({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], think: true }),
    );
    const block = { type: "thinking", thinking: "plan", signature: "abc" };
    expect(chunks).toContainEqual({ type: "thinking_block", block });
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "x", arguments: {} }],
        thinking: [block],
      },
    ];
    expect(toAnthropicMessages(history).messages[1]?.content[0]).toEqual(block);
  });

  it("writes earlier tool calls and results as text when the request has no tools", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "Looking", toolCalls: [{ id: "t1", name: "x", arguments: { q: 1 } }] },
      { role: "tool", toolCallId: "t1", name: "x", content: "result" },
    ];
    const messages = toAnthropicMessages(history, { withTools: false }).messages;
    expect(JSON.stringify(messages)).not.toMatch(/tool_use|tool_result/);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: 'Looking\n[called x({"q":1})]' }],
    });
    expect(messages[2]?.content).toEqual([{ type: "text", text: "[x result]: result" }]);
  });

  it("asks OpenAI reasoning models for max_completion_tokens", async () => {
    const { impl, calls } = capture(() => sse(["[DONE]"]));
    const provider = createProvider(config("openai"), () => "sk", impl);
    await collect(
      provider.chat({ model: "o4-mini", messages: [{ role: "user", content: "hi" }], maxTokens: 700 }),
    );
    await collect(
      provider.chat({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }], maxTokens: 700 }),
    );
    expect(calls[0]?.body).toMatchObject({ max_completion_tokens: 700 });
    expect(calls[0]?.body.max_tokens).toBeUndefined();
    expect(calls[1]?.body).toMatchObject({ max_tokens: 700 });
  });
});

describe("parallel tool calls and pictures", () => {
  it("keeps parallel OpenAI-style calls apart when the server sends each at index 0", async () => {
    const call = (id: string, name: string, args: string) => ({
      choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }],
    });
    const { impl } = capture(() =>
      sse([call("c1", "search", '{"q":"a"}'), call("c2", "search", '{"q":"b"}'), "[DONE]"]),
    );
    const provider = createProvider(config("google"), () => "k", impl);
    const chunks = await collect(provider.chat({ model: "gemini-2.5-flash", messages: [] }));
    expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([
      { type: "tool_call", call: { id: "c1", name: "search", arguments: { q: "a" } } },
      { type: "tool_call", call: { id: "c2", name: "search", arguments: { q: "b" } } },
    ]);
  });

  it("puts Anthropic tool results before a screenshot in the same user turn", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "look twice" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "t1", name: "look", arguments: {} },
          { id: "t2", name: "look", arguments: {} },
        ],
      },
      { role: "tool", toolCallId: "t1", name: "look", content: "one" },
      { role: "user", content: "(Picture from look)", images: [{ mediaType: "image/png", data: "A" }] },
      { role: "tool", toolCallId: "t2", name: "look", content: "two" },
    ];
    const content = toAnthropicMessages(history).messages[2]!.content;
    expect(content.map((block) => block.type)).toEqual(["tool_result", "tool_result", "image", "text"]);
  });
});

describe("streams", () => {
  it("cancels the response when reading stops early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n'),
        );
        // The server never closes the stream on its own.
      },
      cancel() {
        cancelled = true;
      },
    });
    const { impl } = capture(() => new Response(body));
    const provider = createProvider(config("groq"), () => "k", impl);
    const chunks = await collect(provider.chat({ model: "llama-3.3-70b", messages: [] }));
    expect(chunks[0]).toEqual({ type: "text", text: "Hi" });
    expect(cancelled).toBe(true);
  });
});

describe("schema flattening", () => {
  it("resolves refs reached through nullable unions and allOf, leaving none dangling", async () => {
    const { flattenSchema } = await import(".");
    const schema = {
      type: "object",
      $defs: {
        Point: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        Mode: { type: "string", enum: ["a", "b"] },
      },
      properties: {
        at: { anyOf: [{ $ref: "#/$defs/Point" }, { type: "null" }] },
        mode: { allOf: [{ $ref: "#/$defs/Mode" }], description: "How" },
        list: { type: "array", items: { oneOf: [{ $ref: "#/$defs/Point" }, { type: "null" }] } },
      },
    };
    const flat = flattenSchema(schema);
    expect(JSON.stringify(flat)).not.toMatch(/\$ref|anyOf|oneOf|allOf/);
    expect(flat).toEqual({
      type: "object",
      properties: {
        at: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        mode: { type: "string", enum: ["a", "b"], description: "How" },
        list: {
          type: "array",
          items: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        },
      },
    });
    // The same definitions are flattened once, not on every request.
    expect(flattenSchema(schema)).toBe(flat);
  });

  it("gives up on refs that point at each other instead of looping", async () => {
    const { flattenSchema } = await import(".");
    const flat = flattenSchema({
      type: "object",
      $defs: { A: { $ref: "#/$defs/B" }, B: { allOf: [{ $ref: "#/$defs/A" }] } },
      properties: { a: { $ref: "#/$defs/A" } },
    });
    expect(JSON.stringify(flat)).not.toMatch(/\$ref/);
  });
});

describe("telling out-of-memory from other failures", () => {
  it("knows memory trouble when it is named, and not when a word merely contains 'oom'", async () => {
    const { httpError, runtimeErrorCode } = await import("./types");
    for (const detail of [
      "model requires more system memory",
      "CUDA out of memory",
      "OOM killed",
      "the runtime hit an OOM",
    ]) {
      expect(runtimeErrorCode(detail), detail).toBe("oom");
      expect(httpError(500, detail, "X").code, detail).toBe("oom");
    }
    for (const detail of [
      "boom",
      "no room left in the queue",
      "bloom filter failed",
      "upstream ECONNRESET boom",
    ]) {
      expect(runtimeErrorCode(detail), detail).toBe("provider_down");
      expect(httpError(500, detail, "X").code, detail).toBe("provider_down");
    }
  });
});

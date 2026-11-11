import { describe, expect, it } from "vitest";

import type { ChatProvider, ChatRequest, StreamChunk } from "@mrog/providers";

import { askWith, summarizeWith } from ".";

/** A provider that answers every call with the same text and records each request. */
function replying(kind: ChatProvider["kind"], text = "ok"): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: "fake",
    label: "Fake",
    kind,
    local: kind === "ollama",
    requests,
    listModels: async () => [],
    async *chat(request) {
      requests.push({ ...request, signal: undefined as never });
      yield { type: "text", text } satisfies StreamChunk;
      yield { type: "done", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

const options = () => ({ signal: new AbortController().signal });

describe("one-shot questions and thinking", () => {
  it("turns thinking off on Ollama, whose thinking would eat a capped reply", async () => {
    const provider = replying("ollama");
    await askWith(provider, "qwen3.5", "Pick one.", "Who?", { ...options(), maxTokens: 60 });
    await summarizeWith(provider, "qwen3.5", "a long chat", options());
    expect(provider.requests.map((request) => request.think)).toEqual([false, false]);
  });

  it("lets an explicit setting win", async () => {
    const provider = replying("ollama");
    await askWith(provider, "m", "s", "u", { ...options(), think: true });
    expect(provider.requests[0]?.think).toBe(true);
  });

  it("leaves other providers on their own default", async () => {
    for (const kind of ["openai", "anthropic"] as const) {
      const provider = replying(kind);
      await askWith(provider, "m", "s", "u", options());
      expect(provider.requests[0]?.think).toBeUndefined();
    }
  });
});

import { modelRef, type ModelInfo } from "@mrog/shared";

import { guessCapabilities, guessContextWindow, isChatModel } from "./guess";
import { flattenSchema } from "./schema";
import {
  newCallId,
  ProviderError,
  request,
  runtimeErrorCode,
  sseData,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type StreamChunk,
} from "./types";

/** OpenAI reasoning models (o1, o3, o4-mini, gpt-5…), which take max_completion_tokens. */
const REASONING_MODEL = /^(o\d|gpt-5)/i;

interface OpenAICompatOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: () => string | null;
  /** Extra headers (e.g. Azure's api-key, OpenRouter's attribution). */
  headers?: Record<string, string>;
  /** "bearer" (default) or a header name to carry the key, e.g. "api-key" for Azure. */
  keyHeader?: string;
  local?: boolean;
  /** Ask for token usage in the stream (not every server supports it). */
  streamUsage?: boolean;
  /** Models to offer when the server has no /models endpoint. */
  fallbackModels?: string[];
  /** Flatten tool schemas ($ref/anyOf) for servers that choke on them. */
  flattenTools?: boolean;
  fetchImpl?: typeof fetch;
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      if (!message.images?.length) return { role: "user", content: message.content };
      return {
        role: "user",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mediaType};base64,${image.data}` },
          })),
        ],
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content || (message.toolCalls?.length ? null : ""),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                // Only Gemini sends one; it must come back with its call, or the next request is refused.
                ...(call.signature
                  ? { extra_content: { google: { thought_signature: call.signature } } }
                  : {}),
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

interface Delta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
    /** Gemini's OpenAI-compatible API puts a call's thought signature here. */
    extra_content?: { google?: { thought_signature?: string } };
  }[];
}

/** Any server speaking OpenAI's Chat Completions API: OpenAI, Groq, Mistral, LM Studio, vLLM, … */
export class OpenAICompatProvider implements ChatProvider {
  readonly kind = "openai" as const;
  readonly id: string;
  readonly label: string;
  readonly local: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatOptions) {
    this.id = options.id;
    this.label = options.label;
    this.local = options.local ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(path: string) {
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const [root, query] = base.split("?");
    return `${root}${path}${query ? `?${query}` : ""}`;
  }

  private headers(): Record<string, string> {
    const key = this.options.apiKey?.() ?? null;
    const headers: Record<string, string> = { "content-type": "application/json", ...this.options.headers };
    if (key) {
      const header = this.options.keyHeader ?? "bearer";
      if (header === "bearer") headers.authorization = `Bearer ${key}`;
      else headers[header] = key;
    }
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let ids: string[];
    try {
      const res = await request(
        this.fetchImpl,
        this.url("/models"),
        { headers: this.headers(), signal },
        this.label,
      );
      const body = (await res.json()) as { data?: { id: string; context_length?: number }[] };
      ids = (body.data ?? []).map((model) => model.id);
    } catch (error) {
      if (!this.options.fallbackModels?.length || (error as ProviderError).code === "invalid_key")
        throw error;
      ids = this.options.fallbackModels;
    }
    return ids
      .filter(isChatModel)
      .toSorted((a, b) => a.localeCompare(b))
      .map((id) => ({
        ref: modelRef(this.id, id),
        providerId: this.id,
        id,
        label: id,
        capabilities: guessCapabilities(id),
        contextWindow: this.local ? null : guessContextWindow(id),
        sizeBytes: null,
        loaded: false,
      }));
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamChunk> {
    const flatten = this.options.flattenTools ?? false;
    const body = {
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      stream: true,
      ...(this.options.streamUsage !== false ? { stream_options: { include_usage: true } } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((tool) => ({
              type: "function",
              function: { ...tool, parameters: flatten ? flattenSchema(tool.parameters) : tool.parameters },
            })),
          }
        : {}),
      // OpenAI's reasoning models take max_completion_tokens and reject max_tokens.
      ...(req.maxTokens
        ? REASONING_MODEL.test(req.model)
          ? { max_completion_tokens: req.maxTokens }
          : { max_tokens: req.maxTokens }
        : {}),
    };
    const res = await request(
      this.fetchImpl,
      this.url("/chat/completions"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal },
      this.label,
    );

    /** Calls in the order they started; `serverId` is the id the server gave, if any. */
    const calls: { id: string; serverId?: string; name: string; args: string; signature?: string }[] = [];
    /** Which call each stream index currently feeds. */
    const slots = new Map<number, number>();
    // Some OpenAI-style servers leave out the call index, and some (Gemini) send every parallel call at index 0;
    // either way a new call id starts a new call.
    let last = -1;
    let finishReason: string | null = null;
    let usage: { inputTokens: number; outputTokens: number } | null = null;

    for await (const data of sseData(res.body!, req.signal)) {
      if (data === "[DONE]") break;
      let chunk: {
        choices?: { delta?: Delta; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        error?: { message?: string };
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) {
        const message = chunk.error.message ?? "Unknown error";
        throw new ProviderError(runtimeErrorCode(message), `${this.label}: ${message}`);
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) yield { type: "reasoning", text: reasoning };
        if (delta.content) yield { type: "text", text: delta.content };
        for (const toolDelta of delta.tool_calls ?? []) {
          const hasIndex = typeof toolDelta.index === "number";
          let slot = hasIndex ? slots.get(toolDelta.index!) : last >= 0 ? last : undefined;
          // At a known index, only an id the server already gave that slot counts (one sent late is the same call).
          const known = slot === undefined ? undefined : hasIndex ? calls[slot]!.serverId : calls[slot]!.id;
          if (slot === undefined || (toolDelta.id && known && toolDelta.id !== known)) {
            slot = calls.push({ id: toolDelta.id || newCallId(), name: "", args: "" }) - 1;
          }
          if (hasIndex) slots.set(toolDelta.index!, slot);
          last = slot;
          const current = calls[slot]!;
          if (toolDelta.id) current.id = current.serverId = toolDelta.id;
          if (toolDelta.function?.name) current.name += toolDelta.function.name;
          if (toolDelta.function?.arguments) current.args += toolDelta.function.arguments;
          const signature = toolDelta.extra_content?.google?.thought_signature;
          if (signature) current.signature = signature;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
      } catch {
        throw new ProviderError(
          "bad_output",
          `${this.label}: the model wrote tool arguments that aren't valid JSON.`,
        );
      }
      yield {
        type: "tool_call",
        call: {
          id: call.id,
          name: call.name,
          arguments: args,
          ...(call.signature ? { signature: call.signature } : {}),
        },
      };
    }
    yield { type: "done", finishReason, usage };
  }
}

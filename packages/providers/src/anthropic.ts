import { modelRef, type ModelInfo } from "@mrog/shared";

import { guessCapabilities, guessContextWindow } from "./guess";
import {
  ProviderError,
  request,
  runtimeErrorCode,
  sseData,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type StreamChunk,
} from "./types";

interface AnthropicOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: () => string | null;
  fetchImpl?: typeof fetch;
}

const VERSION = "2023-06-01";

type Block = Record<string, unknown>;

/**
 * Anthropic wants system separate, tool results as user blocks, and strictly alternating roles. A request without
 * tools may not contain tool blocks, so `withTools: false` writes earlier tool calls and results as text.
 */
export function toAnthropicMessages(
  messages: ChatMessage[],
  { withTools = true }: { withTools?: boolean } = {},
): {
  system: string;
  messages: { role: string; content: Block[] }[];
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const out: { role: string; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out.at(-1);
    if (last?.role !== role) {
      out.push({ role, content: blocks });
    } else if (blocks[0]?.type === "tool_result") {
      // Tool results must open the user turn that follows the tool calls; anything else (a screenshot, the user's
      // own words) goes after them.
      const at = last.content.findIndex((block) => block.type !== "tool_result");
      last.content.splice(at === -1 ? last.content.length : at, 0, ...blocks);
    } else {
      last.content.push(...blocks);
    }
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      push("user", [
        ...(message.images ?? []).map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        })),
        ...(message.content ? [{ type: "text", text: message.content }] : []),
      ]);
    } else if (message.role === "assistant") {
      const calls = message.toolCalls ?? [];
      if (!withTools) {
        const written = calls.map((call) => `[called ${call.name}(${JSON.stringify(call.arguments)})]`);
        const text = [message.content, ...written].filter(Boolean).join("\n");
        push("assistant", text ? [{ type: "text", text }] : []);
        continue;
      }
      push("assistant", [
        ...(calls.length > 0 ? (message.thinking ?? []) : []),
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...calls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        })),
      ]);
    } else if (!withTools) {
      push("user", [{ type: "text", text: `[${message.name} result]: ${message.content}` }]);
    } else {
      push("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }]);
    }
  }
  return { system, messages: out };
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = "anthropic" as const;
  readonly local = false;
  readonly id: string;
  readonly label: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicOptions) {
    this.id = options.id;
    this.label = options.label;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "anthropic-version": VERSION,
      "x-api-key": this.options.apiKey() ?? "",
    };
  }

  private url(path: string) {
    return `${this.options.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await request(
      this.fetchImpl,
      this.url("/v1/models?limit=100"),
      { headers: this.headers(), signal },
      this.label,
    );
    const body = (await res.json()) as { data?: { id: string; display_name?: string }[] };
    return (body.data ?? []).map((model) => ({
      ref: modelRef(this.id, model.id),
      providerId: this.id,
      id: model.id,
      label: model.display_name ?? model.id,
      capabilities: guessCapabilities(model.id),
      contextWindow: guessContextWindow(model.id),
      sizeBytes: null,
      loaded: false,
    }));
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamChunk> {
    const { system, messages } = toAnthropicMessages(req.messages, { withTools: Boolean(req.tools?.length) });
    const thinking = req.think === true;
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? (thinking ? 16_000 : 8192),
      stream: true,
      ...(system ? { system } : {}),
      messages,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      ...(thinking ? { thinking: { type: "enabled", budget_tokens: 8000 } } : {}),
    };
    const res = await request(
      this.fetchImpl,
      this.url("/v1/messages"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal },
      this.label,
    );

    const blocks = new Map<
      number,
      {
        type: string;
        id?: string;
        name?: string;
        json: string;
        thinking: string;
        signature: string;
        data?: string;
      }
    >();
    const usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: string | null = null;

    for await (const data of sseData(res.body!, req.signal)) {
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      switch (event.type) {
        case "message_start":
          usage.inputTokens = event.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_start":
          blocks.set(event.index, {
            type: event.content_block?.type,
            id: event.content_block?.id,
            name: event.content_block?.name,
            json: "",
            thinking: "",
            signature: "",
            data: event.content_block?.data,
          });
          break;
        case "content_block_delta": {
          const delta = event.delta ?? {};
          if (delta.type === "text_delta") yield { type: "text", text: delta.text };
          else if (delta.type === "thinking_delta") {
            const block = blocks.get(event.index);
            if (block) block.thinking += delta.thinking;
            yield { type: "reasoning", text: delta.thinking };
          } else if (delta.type === "signature_delta") {
            const block = blocks.get(event.index);
            if (block) block.signature += delta.signature;
          } else if (delta.type === "input_json_delta") {
            const block = blocks.get(event.index);
            if (block) block.json += delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const block = blocks.get(event.index);
          if (block?.type === "thinking") {
            yield {
              type: "thinking_block",
              block: { type: "thinking", thinking: block.thinking, signature: block.signature },
            };
          } else if (block?.type === "redacted_thinking") {
            yield { type: "thinking_block", block: { type: "redacted_thinking", data: block.data } };
          } else if (block?.type === "tool_use") {
            let args: Record<string, unknown> = {};
            try {
              args = block.json ? JSON.parse(block.json) : {};
            } catch {
              throw new ProviderError(
                "bad_output",
                `${this.label}: the model wrote tool input that isn't valid JSON.`,
              );
            }
            yield {
              type: "tool_call",
              call: { id: block.id ?? "", name: block.name ?? "", arguments: args },
            };
          }
          break;
        }
        case "message_delta":
          finishReason = event.delta?.stop_reason ?? finishReason;
          usage.outputTokens = event.usage?.output_tokens ?? usage.outputTokens;
          break;
        case "error": {
          const message = event.error?.message ?? "Unknown error";
          const code = event.error?.type === "overloaded_error" ? "provider_down" : runtimeErrorCode(message);
          throw new ProviderError(code, `${this.label}: ${message}`);
        }
      }
    }
    yield { type: "done", finishReason, usage };
  }
}

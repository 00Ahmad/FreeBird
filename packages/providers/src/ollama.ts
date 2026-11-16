import { modelRef, type LoadedModel, type ModelCapability, type ModelInfo } from "@mrog/shared";

import {
  lines,
  newCallId,
  ProviderError,
  request,
  runtimeErrorCode,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type StreamChunk,
} from "./types";
import { flattenSchema } from "./schema";

interface TagModel {
  name: string;
  size?: number;
  digest?: string;
  capabilities?: string[];
  details?: { context_length?: number; parameter_size?: string };
}

interface ShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

interface ChatLine {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export interface PullProgress {
  status: string;
  completed: number | null;
  total: number | null;
}

const KNOWN_CAPABILITIES = new Set<ModelCapability>([
  "completion",
  "tools",
  "vision",
  "thinking",
  "embedding",
]);

function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content: message.content,
        ...(message.images?.length ? { images: message.images.map((image) => image.data) } : {}),
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", content: message.content, tool_name: message.name };
  }
}

/** Ollama's native API: the only way to set keep_alive and num_ctx per request. */
export class OllamaProvider implements ChatProvider {
  readonly kind = "ollama" as const;
  readonly local = true;
  private readonly showCache = new Map<string, ShowResponse>();
  /** Local models this app has loaded (sent a request to) and not unloaded since: what it unloads on close. */
  private readonly used = new Set<string>();

  /** The models this app has loaded and not unloaded since. */
  usedModels(): string[] {
    return [...this.used];
  }

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly baseUrl: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string) {
    return `${this.baseUrl().replace(/\/+$/, "")}${path}`;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await request(this.fetchImpl, this.url(path), init, this.label);
    return (await res.json()) as T;
  }

  private post(body: unknown, signal?: AbortSignal): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    };
  }

  async version(signal?: AbortSignal): Promise<string> {
    return (await this.json<{ version: string }>("/api/version", { signal })).version;
  }

  /**
   * A model's details, cached by name and digest: re-pulling a tag changes its digest (and maybe its
   * capabilities or context size), so the old entry no longer matches.
   */
  async show(name: string, signal?: AbortSignal, digest?: string): Promise<ShowResponse> {
    const key = `${name}@${digest ?? ""}`;
    const cached = this.showCache.get(key);
    if (cached) return cached;
    const show = await this.json<ShowResponse>("/api/show", this.post({ model: name }, signal));
    for (const old of this.showCache.keys()) if (old.startsWith(`${name}@`)) this.showCache.delete(old);
    this.showCache.set(key, show);
    return show;
  }

  async ps(signal?: AbortSignal): Promise<LoadedModel[]> {
    const res = await this.json<{
      models?: {
        name: string;
        size?: number;
        size_vram?: number;
        context_length?: number;
        expires_at?: string;
      }[];
    }>("/api/ps", { signal });
    return (res.models ?? []).map((model) => ({
      name: model.name,
      sizeBytes: model.size ?? 0,
      vramBytes: model.size_vram ?? 0,
      contextLength: model.context_length ?? null,
      expiresAt: model.expires_at ?? null,
    }));
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const [tags, loaded] = await Promise.all([
      this.json<{ models?: TagModel[] }>("/api/tags", { signal }),
      this.ps(signal).catch(() => [] as LoadedModel[]),
    ]);
    const loadedNames = new Set(loaded.map((model) => model.name));
    return Promise.all(
      (tags.models ?? []).map(async (tag) => {
        let capabilities = tag.capabilities;
        let contextWindow = tag.details?.context_length ?? null;
        // Older Ollama versions leave capabilities out of /api/tags.
        if (!capabilities || contextWindow === null) {
          const show = await this.show(tag.name, signal, tag.digest).catch(() => null);
          capabilities ??= show?.capabilities ?? ["completion"];
          contextWindow ??= contextLengthOf(show);
        }
        return {
          ref: modelRef(this.id, tag.name),
          providerId: this.id,
          id: tag.name,
          label: tag.name,
          capabilities: capabilities.filter((cap): cap is ModelCapability =>
            KNOWN_CAPABILITIES.has(cap as ModelCapability),
          ),
          contextWindow,
          sizeBytes: tag.size ?? null,
          loaded: loadedNames.has(tag.name),
        } satisfies ModelInfo;
      }),
    );
  }

  async *pull(name: string, signal?: AbortSignal): AsyncIterable<PullProgress> {
    const res = await request(
      this.fetchImpl,
      this.url("/api/pull"),
      this.post({ model: name, stream: true }, signal),
      this.label,
    );
    try {
      for await (const line of lines(res.body!, signal)) {
        if (!line.trim()) continue;
        const progress = JSON.parse(line) as {
          status?: string;
          completed?: number;
          total?: number;
          error?: string;
        };
        if (progress.error) throw new ProviderError("bad_request", `${this.label}: ${progress.error}`);
        yield {
          status: progress.status ?? "",
          completed: progress.completed ?? null,
          total: progress.total ?? null,
        };
      }
    } finally {
      // A (re-)pulled tag may come with new capabilities or a new context size; read them afresh next time.
      this.showCache.clear();
    }
  }

  /** Loads the model with the shared options so the first real message doesn't pay the load time. */
  async warm(
    name: string,
    local: { numCtx: number; keepAlive: string },
    signal?: AbortSignal,
  ): Promise<void> {
    this.used.add(name);
    await this.json(
      "/api/chat",
      this.post(
        {
          model: name,
          messages: [],
          keep_alive: keepAliveValue(local.keepAlive),
          options: { num_ctx: local.numCtx },
        },
        signal,
      ),
    );
  }

  /** Frees the model's memory now (keep_alive 0). */
  async unload(name: string, signal?: AbortSignal): Promise<void> {
    await this.json("/api/chat", this.post({ model: name, messages: [], keep_alive: 0 }, signal));
    this.used.delete(name);
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamChunk> {
    this.used.add(req.model);
    const body = {
      model: req.model,
      messages: req.messages.map(toOllamaMessage),
      stream: true,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((tool) => ({
              type: "function",
              function: { ...tool, parameters: flattenSchema(tool.parameters) },
            })),
          }
        : {}),
      ...(req.think === undefined ? {} : { think: req.think }),
      ...(req.local ? { keep_alive: keepAliveValue(req.local.keepAlive) } : {}),
      options: {
        ...(req.local ? { num_ctx: req.local.numCtx } : {}),
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
      },
    };
    const res = await request(this.fetchImpl, this.url("/api/chat"), this.post(body, req.signal), this.label);
    for await (const line of lines(res.body!, req.signal)) {
      if (!line.trim()) continue;
      let chunk: ChatLine;
      try {
        chunk = JSON.parse(line) as ChatLine;
      } catch {
        throw new ProviderError("bad_output", `${this.label} sent a reply that couldn't be read.`);
      }
      if (chunk.error) {
        throw new ProviderError(runtimeErrorCode(chunk.error), `${this.label}: ${chunk.error}`);
      }
      const message = chunk.message;
      if (message?.thinking) yield { type: "reasoning", text: message.thinking };
      if (message?.content) yield { type: "text", text: message.content };
      for (const call of message?.tool_calls ?? []) {
        const args = call.function.arguments;
        yield {
          type: "tool_call",
          call: {
            id: newCallId(),
            name: call.function.name,
            arguments: typeof args === "string" ? safeJson(args) : (args ?? {}),
          },
        };
      }
      if (chunk.done) {
        yield {
          type: "done",
          finishReason: chunk.done_reason ?? null,
          usage:
            chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined
              ? { inputTokens: chunk.prompt_eval_count ?? 0, outputTokens: chunk.eval_count ?? 0 }
              : null,
        };
      }
    }
  }
}

/** Ollama takes -1 / 0 as numbers and durations as strings. */
function keepAliveValue(keepAlive: string): string | number {
  return /^-?\d+$/.test(keepAlive) ? Number(keepAlive) : keepAlive;
}

function contextLengthOf(show: ShowResponse | null): number | null {
  for (const [key, value] of Object.entries(show?.model_info ?? {})) {
    if (key.endsWith(".context_length") && typeof value === "number") return value;
  }
  return null;
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

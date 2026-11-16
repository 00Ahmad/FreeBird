import type { ModelInfo, Usage } from "@mrog/shared";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * The provider's signature for this call, sent back with it exactly as it came. Gemini 3 gives one (a "thought
   * signature") and rejects the next request if the call comes back without it.
   */
  signature?: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: { mediaType: string; data: string }[] }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      /** The provider's own thinking blocks, sent back as they came (Anthropic needs them beside tool calls). */
      thinking?: Record<string, unknown>[];
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** JSON Schema for a tool's arguments (an object schema). */
export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  /** Only sent to models that can think; undefined leaves the model's default. */
  think?: boolean;
  maxTokens?: number;
  /** Local-runtime options (Ollama): identical on every request so the loaded model is reused. */
  local?: { numCtx: number; keepAlive: string };
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "thinking_block"; block: Record<string, unknown> }
  | { type: "done"; usage: Usage | null; finishReason: string | null };

export type ProviderKind = "ollama" | "openai" | "anthropic";

export interface ChatProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  /** Runs on this machine (no per-token cost, shares local memory). */
  readonly local: boolean;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(request: ChatRequest): AsyncIterable<StreamChunk>;
}

export type ProviderErrorCode =
  | "provider_down"
  | "model_missing"
  | "invalid_key"
  | "quota"
  | "oom"
  | "timeout"
  | "bad_request"
  /** The model wrote output the runtime could not parse (e.g. a malformed tool call). */
  | "bad_output"
  /** The model stopped sending anything for too long (a hung runtime or connection), so the turn was ended. */
  | "stalled"
  /** The bot works from pictures (a Visual Bot) and this model can't see them. */
  | "needs_vision"
  | "aborted"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Runtime messages that mean the model produced unparseable output, not that the server is down. */
const BAD_OUTPUT =
  /syntax error|failed to parse|error parsing|unexpected end of json|invalid character|unmarshal/i;

/** The runtime ran out of memory. "oom" as a whole word only: "boom", "room" and "bloom" are not it. */
const OUT_OF_MEMORY = /memory|\boom\b/i;

/** Code for an error message a runtime reports mid-stream. */
export function runtimeErrorCode(detail: string): ProviderErrorCode {
  if (OUT_OF_MEMORY.test(detail)) return "oom";
  return BAD_OUTPUT.test(detail) ? "bad_output" : "provider_down";
}

/** Maps an HTTP failure to a typed error, keeping the provider's own message when it has one. */
export function httpError(status: number, body: string, providerLabel: string): ProviderError {
  let detail = body.slice(0, 500);
  try {
    const json = JSON.parse(body) as { error?: string | { message?: string } };
    detail = typeof json.error === "string" ? json.error : (json.error?.message ?? detail);
  } catch {
    // keep raw text
  }
  const code: ProviderErrorCode =
    status === 401 || status === 403
      ? "invalid_key"
      : status === 404
        ? "model_missing"
        : status === 429 || status === 402
          ? "quota"
          : status === 408 || status === 504
            ? "timeout"
            : status >= 500
              ? OUT_OF_MEMORY.test(detail)
                ? "oom"
                : BAD_OUTPUT.test(detail)
                  ? "bad_output"
                  : "provider_down"
              : "bad_request";
  return new ProviderError(code, `${providerLabel}: ${detail || `HTTP ${status}`}`, status);
}

/** Wraps fetch so network failures and aborts become ProviderErrors. */
export async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  providerLabel: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw new ProviderError("aborted", "Stopped.");
    throw new ProviderError(
      "provider_down",
      `${providerLabel} is not reachable (${(error as Error).message}).`,
    );
  }
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""), providerLabel);
  return res;
}

/** Lines of a streamed response body. */
export async function* lines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // Cancel the read ourselves: not every body stops when its request's signal aborts.
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
      }
    }
    if (signal?.aborted) throw new ProviderError("aborted", "Stopped.");
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } catch (error) {
    if (signal?.aborted || error instanceof ProviderError) {
      throw error instanceof ProviderError ? error : new ProviderError("aborted", "Stopped.");
    }
    throw new ProviderError("provider_down", `The stream broke: ${(error as Error).message}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Left early (a parse error, `[DONE]`, the caller stopped reading): close the response so the server stops
    // generating instead of carrying on while the engine retries.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** `data:` payloads of an SSE body (OpenAI / Anthropic streams). */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const data: string[] = [];
  for await (const line of lines(body, signal)) {
    if (line === "") {
      if (data.length) yield data.join("\n");
      data.length = 0;
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (data.length) yield data.join("\n");
}

let callCounter = 0;
export const newCallId = () => `call_${Date.now().toString(36)}_${(callCounter++).toString(36)}`;

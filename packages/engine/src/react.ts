import { newCallId, type ToolCall, type ToolDef } from "@mrog/providers";

/** Text tool protocol for models without native tool calling. */
const FENCE = "```tool";

/**
 * Where a tool call written as text starts. Besides our own fence, models trained on other formats write
 * `<tool_call>{json}</tool_call>` (Hermes/Qwen) or `<function=name>…</function>` (Qwen-coder, MiMo).
 */
const MARKERS = [FENCE, "<tool_call", "<function="];

export function reactInstructions(tools: ToolDef[]): string {
  const list = tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  arguments: ${JSON.stringify(tool.parameters)}`)
    .join("\n");
  return [
    "You can use tools. To call one, reply with only this block and nothing after it:",
    "```tool",
    '{"name": "<tool name>", "arguments": { } }',
    "```",
    "You will get the result in the next message. When you have the final answer, reply normally with no tool block.",
    "Tools:",
    list,
  ].join("\n");
}

/** The first balanced {...} in text (respecting strings), so stray characters after it don't spoil a call. */
function firstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function parseJson(text: string): Record<string, unknown> | null {
  const asObject = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  try {
    return asObject(JSON.parse(text.trim()));
  } catch {
    // Small models add a stray "}" or words after the JSON; use the first complete object if there is one.
    const first = text.trim().startsWith("{") ? firstObject(text) : null;
    if (!first) return null;
    try {
      return asObject(JSON.parse(first));
    } catch {
      return null;
    }
  }
}

const asArgs = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** `{"name": …, "arguments"|"parameters": {…}}` → a call. */
function fromNamedJson(json: Record<string, unknown> | null): ToolCall | null {
  if (!json || typeof json.name !== "string") return null;
  return { id: newCallId(), name: json.name, arguments: asArgs(json.arguments ?? json.parameters) };
}

/**
 * The body of `<function=name>…</function>`: empty, JSON arguments, or `<parameter=key>value</parameter>` pairs.
 * Anything else is prose that happens to mention a function, not a call.
 */
function fromFunctionBody(name: string, body: string): ToolCall | null {
  if (!body.trim()) return { id: newCallId(), name, arguments: {} };
  const json = parseJson(body);
  if (json) return { id: newCallId(), name, arguments: json };
  if (!/<parameter=/.test(body)) return null;
  const args: Record<string, unknown> = {};
  for (const match of body.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)) {
    const raw = match[2]!.trim();
    const parsed = parseJson(raw);
    args[match[1]!] =
      parsed ??
      (/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw);
  }
  return { id: newCallId(), name, arguments: args };
}

/**
 * Takes the ```tool blocks out of a reply, leaving numbered placeholders so calls keep their order. A block's JSON
 * may itself contain ``` (writing a Markdown file with a code block), so the block ends where its JSON object does,
 * not at the first ``` after the marker.
 */
function cutFences(text: string): { text: string; fenced: (ToolCall | null)[] } {
  const fenced: (ToolCall | null)[] = [];
  let out = "";
  let rest = text;
  for (let at = rest.indexOf(FENCE); at !== -1; at = rest.indexOf(FENCE)) {
    out += rest.slice(0, at);
    const after = rest.slice(at + FENCE.length);
    const body = after.trimStart();
    const json = body.startsWith("{") ? firstObject(body) : null;
    let end: number;
    if (json) {
      const close = after.length - body.length + json.length;
      end = close + (/^\s*```/.exec(after.slice(close))?.[0].length ?? 0);
      fenced.push(fromNamedJson(parseJson(json)));
    } else {
      // No complete object (cut off, or not JSON at all): the block runs to the next ``` or the end.
      const close = after.indexOf("```");
      end = close === -1 ? after.length : close + 3;
      fenced.push(fromNamedJson(parseJson(close === -1 ? after : after.slice(0, close))));
    }
    out += `\uE000${fenced.length - 1}\uE000`;
    rest = after.slice(end);
  }
  return { text: out + rest, fenced };
}

/**
 * Every tool call written as text in a reply, in order, and the reply with those blocks removed. Understands
 * ```tool fences, <tool_call>{json}</tool_call>, and <function=name>{json | <parameter=…>}</function> (with or
 * without a <tool_call> wrapper, and tolerating a missing closing tag at the very end).
 */
export function parseToolCalls(text: string): { calls: ToolCall[]; cleaned: string } {
  const calls: ToolCall[] = [];
  const { text: marked, fenced } = cutFences(text);
  const pattern =
    /\uE000(\d+)\uE000|<tool_call>\s*(?:<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)\s*(?:<\/tool_call>|$)|([\s\S]*?)(?:<\/tool_call>|$))|<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g;
  const cleaned = marked.replace(
    pattern,
    (_whole, fence, wrappedName, wrappedBody, wrappedJson, bareName, bareBody) => {
      let call: ToolCall | null = null;
      if (fence !== undefined) call = fenced[Number(fence)] ?? null;
      else if (wrappedName !== undefined) call = fromFunctionBody(wrappedName, wrappedBody ?? "");
      else if (wrappedJson !== undefined) call = fromNamedJson(parseJson(wrappedJson));
      else if (bareName !== undefined) call = fromFunctionBody(bareName, bareBody ?? "");
      if (call) calls.push(call);
      return "";
    },
  );
  return { calls, cleaned: cleaned.trim() };
}

/**
 * Whether text begins a tool call body (`{…`, `<parameter=…`) that never finished, as when a model is cut off
 * mid-call, as opposed to prose that merely mentions `<function=x>`.
 */
export function startsToolCall(text: string): boolean {
  return /```tool\s*\{|<tool_call>\s*(\{|<function=)|<function=[\w.-]+>\s*(\{|<parameter=)/.test(text);
}

/** The first tool call written as text in a reply, if any. */
export function parseToolBlock(text: string): ToolCall | null {
  return parseToolCalls(text).calls[0] ?? null;
}

/**
 * Passes streamed text through until a written tool call starts, then holds everything back so the raw block
 * never shows in the chat. Keeps a short tail in reserve in case a marker is split across chunks.
 */
export class FenceFilter {
  private held = "";
  private inFence = false;

  push(text: string): string {
    if (this.inFence) return "";
    this.held += text;
    const at = Math.min(
      ...MARKERS.map((marker) => this.held.indexOf(marker)).filter((index) => index !== -1),
    );
    if (Number.isFinite(at)) {
      this.inFence = true;
      const out = this.held.slice(0, at);
      this.held = "";
      return out;
    }
    // Hold back only a tail that could be the start of a marker ("<", "<tool", "``"…); everything else streams now.
    let keep = 0;
    for (const marker of MARKERS) {
      for (let n = Math.min(marker.length - 1, this.held.length); n > keep; n--) {
        if (this.held.endsWith(marker.slice(0, n))) {
          keep = n;
          break;
        }
      }
    }
    const out = this.held.slice(0, this.held.length - keep);
    this.held = this.held.slice(this.held.length - keep);
    return out;
  }

  flush(): string {
    if (this.inFence) return "";
    const out = this.held;
    this.held = "";
    return out;
  }
}

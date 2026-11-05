import type { ChatMessage, ToolCall, ToolDef } from "@mrog/providers";
import type { Message } from "@mrog/shared";

const IMAGE_TOKENS = 800;

/** Rough token estimate (no tokenizer for every model): ~3.5 characters per token; a picture costs about 800. */
export function estimateTokens(message: ChatMessage): number {
  let chars = message.content.length + 8;
  if (message.role === "assistant" && message.toolCalls) chars += JSON.stringify(message.toolCalls).length;
  const images = message.role === "user" ? (message.images?.length ?? 0) : 0;
  return Math.ceil(chars / 3.5) + images * IMAGE_TOKENS;
}

/** Rough token cost of the tool definitions sent with every request. */
export function estimateToolTokens(tools: ToolDef[]): number {
  return tools.length > 0 ? Math.ceil(JSON.stringify(tools).length / 3.5) : 0;
}

/**
 * Which stored message (and which piece of it) each chat message from `toChatHistory` came from. Lets a history
 * summary find its place again exactly, even when the same text ("ok", a routine's note) appears many times.
 */
const sources = new WeakMap<ChatMessage, string>();

/** The stored message a chat message came from, when it was built by `toChatHistory`. */
export const sourceOf = (message: ChatMessage): string | undefined => sources.get(message);

/**
 * Turns stored messages into chat history from one bot's point of view: its own messages are "assistant",
 * everything else is "user" (other bots are named so group chats read naturally).
 */
export function toChatHistory(
  messages: Message[],
  selfBotId: string,
  botNames: Map<string, string>,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    let piece = 0;
    const emit = (chat: ChatMessage) => {
      sources.set(chat, `${message.id}:${piece++}`);
      out.push(chat);
    };

    if (message.role === "bot" && message.botId === selfBotId) {
      // Replay tool use so the model sees what it already did.
      let pending = "";
      for (const part of message.parts) {
        if (part.type === "text") pending += part.text;
        if (
          part.type === "tool" &&
          (part.status === "done" || part.status === "error" || part.status === "denied")
        ) {
          const call: ToolCall = { id: part.callId, name: part.name, arguments: part.args };
          emit({ role: "assistant", content: pending, toolCalls: [call] });
          emit({
            role: "tool",
            toolCallId: part.callId,
            name: part.name,
            // A call nobody answered in time wasn't refused: it says what really happened, as the bot was told then.
            content:
              part.status === "denied" && part.decidedBy !== "timeout"
                ? "The user denied this action."
                : (part.result ?? ""),
          });
          pending = "";
        }
        if (part.type === "question" && part.answer !== undefined) {
          pending += `\n[You asked: ${part.question}] [User answered: ${part.answer}]\n`;
        }
      }
      if (pending.trim()) emit({ role: "assistant", content: pending });
      continue;
    }

    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");

    // App notes (e.g. a routine starting) read as instructions from the user.
    if (message.role === "system") {
      if (text.trim()) emit({ role: "user", content: text });
      continue;
    }

    if (message.role === "bot") {
      // A bot message with no bot is a moderator's summary, or from a bot that has since been deleted.
      const name = message.moderator
        ? "Moderator"
        : message.botId
          ? botNames.get(message.botId) || "Another bot"
          : "A former member";
      if (text.trim()) emit({ role: "user", content: `[${name}]: ${text}` });
      continue;
    }

    const images = message.parts.flatMap((part) =>
      part.type === "image" ? [{ mediaType: part.mediaType, data: part.data }] : [],
    );
    emit({ role: "user", content: text, ...(images.length ? { images } : {}) });
  }
  return mergeAdjacentUsers(out);
}

/** Some models reject two user turns in a row; join them. */
function mergeAdjacentUsers(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    const source = sources.get(message);
    if (last?.role === "user" && message.role === "user") {
      last.content = `${last.content}\n\n${message.content}`;
      if (message.images?.length) last.images = [...(last.images ?? []), ...message.images];
      // The joined message ends where its last part does.
      if (source) sources.set(last, source);
    } else {
      const copy = message.role === "user" ? { ...message } : message;
      if (source) sources.set(copy, source);
      out.push(copy);
    }
  }
  return out;
}

/**
 * Rewrites native tool calls and results from earlier turns into the written form (a ```tool block, then
 * "Result of X:"), for models that only use tools as text: their templates drop `tool` messages, so the model
 * would otherwise forget what it already did and found.
 */
export function writeToolUse(history: ChatMessage[]): ChatMessage[] {
  return history.map((message): ChatMessage => {
    if (message.role === "tool")
      return { role: "user", content: `Result of ${message.name}:\n${message.content}` };
    if (message.role !== "assistant" || !message.toolCalls?.length) return message;
    const blocks = message.toolCalls.map(
      (call) => `\`\`\`tool\n${JSON.stringify({ name: call.name, arguments: call.arguments })}\n\`\`\``,
    );
    return { role: "assistant", content: [message.content.trim(), ...blocks].filter(Boolean).join("\n") };
  });
}

/** Without vision a model can't use pictures; drop them (they'd cost room on every turn) and say so. */
export function withoutPictures(history: ChatMessage[]): ChatMessage[] {
  return history.map((message) => {
    if (message.role !== "user" || !message.images?.length) return message;
    const { images: _images, ...rest } = message;
    const note = "(picture omitted: this model can't see images)";
    return { ...rest, content: rest.content ? `${rest.content}\n${note}` : note };
  });
}

/**
 * Keeps the newest history that fits the context window, never splitting a tool call from its result and always
 * keeping the latest message. Returns how many messages were dropped.
 */
export function fitHistory(
  history: ChatMessage[],
  budgetTokens: number,
): { messages: ChatMessage[]; dropped: number } {
  let used = 0;
  let start = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTokens(history[i]!);
    if (used + cost > budgetTokens && start < history.length) break;
    used += cost;
    start = i;
  }
  // Don't open with an orphaned tool result or a dangling assistant tool call.
  while (start < history.length - 1 && history[start]!.role === "tool") start += 1;
  return { messages: history.slice(start), dropped: start };
}

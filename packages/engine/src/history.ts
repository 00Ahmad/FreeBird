import type { ChatMessage, ToolCall, ToolDef } from "@mrog/providers";
import type { Message } from "@mrog/shared";

const IMAGE_TOKENS = 800;

/** Chinese, Japanese and Korean: about one token per character. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
/** Other letters outside the Latin script (Arabic, Urdu, Cyrillic, Devanagari, Hebrew, Thai…): about two per token. */
const OTHER_SCRIPTS =
  /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Rough token count of a text, with no tokenizer for every model: about 3.5 characters per token in Latin letters,
 * digits and punctuation, two per token in other alphabets, one per token in Chinese, Japanese and Korean. Counting all
 * text as English made a chat in Urdu or Chinese look several times smaller than it is, so it overran the window.
 */
export function estimateTextTokens(text: string): number {
  // Text in Latin letters (most of it) is counted without looking at each character.
  // (Other control characters take the slow path, which counts them the same way.)
  if (!/[^\t\n\r -ɏ]/.test(text)) return text.length / 3.5;
  const cjk = text.match(CJK)?.length ?? 0;
  const other = text.match(OTHER_SCRIPTS)?.length ?? 0;
  return (text.length - cjk - other) / 3.5 + other / 2 + cjk;
}

/** Rough token estimate of a message; a picture costs about 800. */
export function estimateTokens(message: ChatMessage): number {
  let tokens = estimateTextTokens(message.content) + 8 / 3.5;
  if (message.role === "assistant" && message.toolCalls)
    tokens += estimateTextTokens(JSON.stringify(message.toolCalls));
  const images = message.role === "user" ? (message.images?.length ?? 0) : 0;
  return Math.ceil(tokens) + images * IMAGE_TOKENS;
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

/** Added to a file change the user undid from the chat. */
export const UNDONE_NOTE =
  "(The user undid this change afterwards: the file is back to how it was before it, or gone if this call created it.)";

/** Put before a message the bot took in while it was writing its reply above. */
export const TOOK_IN_NOTE =
  "(Sent while you were working on your reply above, which already took it into account: don't answer or do it again.)";

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
  // The user's messages this bot already took in while writing a reply: saved after that reply, so without a word they
  // read as new and get answered (or acted on) a second time.
  const answered = new Set(
    messages.flatMap((message) =>
      message.role === "bot" && message.botId === selfBotId ? (message.tookIn ?? []) : [],
    ),
  );
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
          const call: ToolCall = {
            id: part.callId,
            name: part.name,
            arguments: part.args,
            ...(part.signature ? { signature: part.signature } : {}),
          };
          emit({ role: "assistant", content: pending, toolCalls: [call] });
          emit({
            role: "tool",
            toolCallId: part.callId,
            name: part.name,
            // A call nobody answered in time wasn't refused: it says what really happened, as the bot was told then.
            content:
              part.status === "denied" && part.decidedBy !== "timeout"
                ? "The user denied this action."
                : // The user undid this file change from the chat: the file no longer holds what was written.
                  `${part.result ?? ""}${part.undo?.undone ? `\n${UNDONE_NOTE}` : ""}`,
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
    const content = answered.has(message.id) ? `${TOOK_IN_NOTE}\n${text}` : text;
    emit({ role: "user", content, ...(images.length ? { images } : {}) });
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

/** Pictures the user attached that are sent in full; older ones are replaced by a note. */
export const KEEP_USER_PICTURES = 3;

/**
 * Keeps only the newest `keep` pictures the user attached (the newest message's always), and replaces older ones with
 * a note. Each picture costs room and time on every step of every turn, long after the conversation moved on.
 */
export function onlyRecentPictures(history: ChatMessage[], keep = KEEP_USER_PICTURES): ChatMessage[] {
  let seen = 0;
  const out = [...history];
  for (let index = out.length - 1; index >= 0; index--) {
    const message = out[index]!;
    if (message.role !== "user" || !message.images?.length) continue;
    const room = index === out.length - 1 ? message.images.length : Math.max(0, keep - seen);
    seen += message.images.length;
    if (room >= message.images.length) continue;
    const dropped = message.images.length - room;
    const note = `(${dropped === 1 ? "a picture" : `${dropped} pictures`} from earlier left out to save room: ask the user to send it again if you need it)`;
    const { images, ...rest } = message;
    out[index] = {
      ...rest,
      ...(room > 0 ? { images: images.slice(-room) } : {}),
      content: rest.content ? `${rest.content}\n${note}` : note,
    };
  }
  return out;
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

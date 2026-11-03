import type { ChatMessage } from "@mrog/providers";

import { estimateTokens } from "./history";

const SHORTENED = "\n…(older result shortened to save room; repeat the tool call if you need it again)";
const KEEP_CHARS = 400;

const isResult = (message: ChatMessage) =>
  message.role === "tool" || (message.role === "user" && message.content.startsWith("Result of "));

/** A picture that came from a tool (a screenshot), not one the user attached. */
const isToolPicture = (message: ChatMessage) =>
  message.role === "user" &&
  Boolean(message.images?.length) &&
  (message.content.startsWith("(Picture from ") || message.content.startsWith("Result of "));

/**
 * A long tool-using turn grows past the context window step by step, and local runtimes then silently drop the
 * start of the prompt (the system prompt with it). Shorten the oldest tool results, and drop old screenshots, until
 * the conversation fits again. The newest `keepLast` results are left alone. Returns how many were shortened.
 */
export function shrinkOldResults(messages: ChatMessage[], budget: number, keepLast = 2): number {
  let total = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  if (total <= budget) return 0;
  const results = messages.flatMap((message, index) => (isResult(message) ? [index] : []));
  let shortened = 0;
  for (const index of results.slice(0, Math.max(0, results.length - keepLast))) {
    if (total <= budget) break;
    const message = messages[index]!;
    if (message.content.endsWith(SHORTENED) && !(message.role === "user" && message.images?.length)) continue;
    const before = estimateTokens(message);
    const content = message.content.endsWith(SHORTENED)
      ? message.content
      : `${message.content.slice(0, KEEP_CHARS)}${SHORTENED}`;
    const next: ChatMessage =
      message.role === "tool" ? { ...message, content } : { role: "user", content: content };
    messages[index] = next;
    total += estimateTokens(next) - before;
    shortened += 1;
  }
  // Screenshots attached after tool results are user messages of their own. Pictures the user attached stay.
  for (let index = 0; index < messages.length - 1 && total > budget; index++) {
    const message = messages[index]!;
    if (isToolPicture(message)) {
      const before = estimateTokens(message);
      messages[index] = { role: "user", content: `${message.content} (picture removed to save room)` };
      total += estimateTokens(messages[index]!) - before;
    }
  }
  // Still too big (a small context window and long newest results): cut the newest ones down too, sharing what
  // room there is, rather than letting the runtime silently drop the start of the prompt.
  const newest = results.slice(Math.max(0, results.length - keepLast));
  if (total > budget && newest.length > 0) {
    const over = total - budget;
    const resultTokens = newest.reduce((sum, index) => sum + estimateTokens(messages[index]!), 0);
    const keepChars = Math.max(KEEP_CHARS * 2, Math.floor(((resultTokens - over) / newest.length) * 3.5));
    for (const index of newest) {
      const message = messages[index]!;
      if (message.content.length <= keepChars) continue;
      const content = `${message.content.slice(0, keepChars)}\n…(cut to fit the context window; ask for less at a time)`;
      const before = estimateTokens(message);
      messages[index] = { ...message, content };
      total += estimateTokens(messages[index]!) - before;
      shortened += 1;
    }
  }
  return shortened;
}

/**
 * Keeps only the newest `keep` tool screenshots. A model that looks at the screen every step needs the latest
 * picture, not twenty old ones (each costs time and room). Pictures the user attached are never removed.
 */
export function dropOldPictures(messages: ChatMessage[], keep: number): number {
  let seen = 0;
  let dropped = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (!isToolPicture(message)) continue;
    seen += 1;
    if (seen <= keep) continue;
    messages[index] = { role: "user", content: `${message.content} (older screenshot removed)` };
    dropped += 1;
  }
  return dropped;
}

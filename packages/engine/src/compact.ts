import { createHash } from "node:crypto";

import type { ChatMessage, ChatProvider } from "@mrog/providers";

import { estimateTokens, fitHistory, sourceOf } from "./history";

/**
 * What has already been summarized: the history up to and including the message `mark` identifies (`covered` is
 * where that was in the history at the time), as `summary`. The history is a sliding window of the newest messages,
 * so positions move; `mark` is what finds the spot again.
 */
export interface CompactCache {
  covered: number;
  summary: string;
  mark?: string;
  /** Caches saved before `mark`: a loose fingerprint of the last summarized message, used once and then replaced. */
  last?: string;
}

/** Room for the new messages in one summary request, in characters. */
const MAX_SUMMARY_INPUT = 50_000;

/** Messages before the boundary that go into its hash when there's no stored id, so a repeated "ok" isn't enough. */
const MARK_CONTEXT = 3;

/**
 * Names the message at `index` so it can be found again: the stored message it came from when the history was built
 * by `toChatHistory` (exact even when the same text repeats), otherwise a hash of its full content and the few
 * messages before it.
 */
function markAt(history: ChatMessage[], index: number): string {
  const source = sourceOf(history[index]!);
  if (source) return `id:${source}`;
  const hash = createHash("sha256");
  for (let i = Math.max(0, index - MARK_CONTEXT); i <= index; i++) {
    const message = history[i]!;
    hash.update(
      JSON.stringify([
        message.role,
        message.content,
        message.role === "assistant" ? (message.toolCalls ?? []) : [],
        message.role === "tool" ? message.toolCallId : "",
        message.role === "user" ? (message.images?.length ?? 0) : 0,
      ]),
    );
  }
  return `hash:${hash.digest("base64url")}`;
}

/** How caches saved before `mark` named their last message; it collides on repeated text, so it's only read. */
const legacyFingerprint = (message: ChatMessage) =>
  `${message.role}:${message.content.length}:${message.content.slice(0, 200)}:${
    message.role === "assistant" ? JSON.stringify(message.toolCalls ?? []) : ""
  }`;

/** Where the summarized part ends in this history (0 when nothing can be reused, -1 when it slid out entirely). */
function coveredUpTo(history: ChatMessage[], start: number, cache?: CompactCache): number {
  if (!cache?.summary || cache.covered <= 0) return 0;
  const matches =
    cache.mark !== undefined
      ? (index: number) => markAt(history, index) === cache.mark
      : cache.last !== undefined
        ? (index: number) => legacyFingerprint(history[index]!) === cache.last
        : null;
  if (!matches) return cache.covered <= start ? cache.covered : 0;
  for (let index = Math.min(start, history.length) - 1; index >= 0; index--) {
    if (matches(index)) return index + 1;
  }
  return -1;
}

const render = (messages: ChatMessage[]) =>
  messages
    .map((message) => {
      if (message.role === "tool") return `[tool ${message.name} result]: ${message.content.slice(0, 1500)}`;
      if (message.role === "assistant" && message.toolCalls?.length) {
        const calls = message.toolCalls
          .map((call) => `${call.name}(${JSON.stringify(call.arguments)})`)
          .join(", ");
        return `assistant: ${message.content} [called ${calls}]`;
      }
      return `${message.role}: ${message.content}`;
    })
    .join("\n");

/**
 * When the history no longer fits, replaces the oldest part with a running summary (kept in `cache` so each
 * stretch of conversation is summarized once) and keeps the newest messages verbatim.
 */
export async function compactHistory(
  history: ChatMessage[],
  budgetTokens: number,
  summarize: (text: string) => Promise<string>,
  cache?: CompactCache,
): Promise<{ messages: ChatMessage[]; cache?: CompactCache }> {
  const total = history.reduce((sum, message) => sum + estimateTokens(message), 0);
  if (total <= budgetTokens) return { messages: history, cache };

  const recent = fitHistory(history, Math.floor(budgetTokens * 0.6)).messages;
  const start = history.length - recent.length;
  const covered = coveredUpTo(history, start, cache);
  // -1: the summarized part has slid out of the window entirely; keep its summary and add everything before `start`.
  const from = Math.max(0, covered);
  let summary = covered !== 0 && cache ? cache.summary : "";
  const unsummarized = history.slice(from, start);
  if (unsummarized.length > 0) {
    const previous = summary ? `Summary so far:\n${summary}\n\nNew messages:\n` : "";
    // Cut the new messages, never the summary so far, and keep the request within the model's window.
    const room = Math.max(4_000, Math.min(MAX_SUMMARY_INPUT, Math.floor(budgetTokens * 3)));
    summary = (await summarize(previous + render(unsummarized).slice(-room))).trim();
  }
  if (!summary) return { messages: recent, cache };
  return {
    messages: [{ role: "user", content: `(Summary of our earlier conversation)\n${summary}` }, ...recent],
    cache: start > 0 ? { covered: start, summary, mark: markAt(history, start - 1) } : cache,
  };
}

export interface AskOptions {
  signal: AbortSignal;
  local?: { numCtx: number; keepAlive: string };
  /** Longest reply wanted (default 700 tokens). */
  maxTokens?: number;
  /** Only for models that can think; left out, the model's default. */
  think?: boolean;
}

/** One-shot question to a model, without tools: the text of its reply. */
export async function askWith(
  provider: ChatProvider,
  model: string,
  system: string,
  user: string,
  options: AskOptions,
): Promise<string> {
  let out = "";
  for await (const chunk of provider.chat({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    maxTokens: options.maxTokens ?? 700,
    think: options.think,
    local: options.local,
    signal: options.signal,
  })) {
    if (chunk.type === "text") out += chunk.text;
  }
  return out;
}

/** One-shot summary with the same model the turn uses. */
export function summarizeWith(
  provider: ChatProvider,
  model: string,
  text: string,
  options: AskOptions,
): Promise<string> {
  return askWith(
    provider,
    model,
    "Summarize this conversation for your own memory. Keep decisions, facts, names, file paths, open tasks and what the user wants. Use short bullet points. No preamble.",
    text.slice(-60_000),
    options,
  );
}

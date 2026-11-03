import { messageText, type Discussion, type Message } from "@mrog/shared";

/** The messages of a discussion: from its start note on. */
export function discussionMessages(
  messages: Message[],
  discussion: Discussion | null | undefined,
): Message[] {
  if (!discussion) return [];
  return messages.filter((message) => message.createdAt >= discussion.startedAt);
}

/** How many turns each bot took and how many lookups (searches, pages) it made. */
export function botStats(messages: Message[]): Map<string, { turns: number; lookups: number }> {
  const stats = new Map<string, { turns: number; lookups: number }>();
  for (const message of messages) {
    if (message.role !== "bot" || !message.botId) continue;
    const entry = stats.get(message.botId) ?? { turns: 0, lookups: 0 };
    entry.turns += 1;
    entry.lookups += message.parts.filter((part) => part.type === "tool").length;
    stats.set(message.botId, entry);
  }
  return stats;
}

export interface Source {
  url: string;
  host: string;
  /** Who used it. */
  by: string[];
  /** Linked in someone's message (not just opened). */
  cited: boolean;
}

// Balanced parentheses belong to the address (…/wiki/Mercury_(planet)); the harness matches links the same way.
const LINK =
  /\[[^\]]*\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/(?:[^\s<>"'()[\]]|\([^\s<>"'()[\]]*\))+)/g;

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Addresses linked in a message's text, in order, without repeats. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(LINK)) {
    const url = (match[1] ?? match[2] ?? "").replace(/[.,;:!?]+$/, "");
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

const linkCache = new WeakMap<Message, string[]>();

/**
 * The addresses linked in a message, worked out once per message object. The cache replaces a message when it
 * changes, so while one reply streams the others aren't scanned again.
 */
export function messageLinks(message: Message): string[] {
  let links = linkCache.get(message);
  if (!links) {
    links = linksIn(messageText(message));
    linkCache.set(message, links);
  }
  return links;
}

/** Every source in the discussion: pages the bots opened and addresses they linked, cited ones first. */
export function discussionSources(messages: Message[], names: Map<string, string>): Source[] {
  const found = new Map<string, Source>();
  const add = (url: string, who: string, cited: boolean) => {
    const key = url.replace(/\/+$/, "").toLowerCase();
    const source = found.get(key) ?? { url, host: hostOf(url), by: [], cited: false };
    if (!source.by.includes(who)) source.by.push(who);
    source.cited ||= cited;
    found.set(key, source);
  };
  for (const message of messages) {
    if (message.role !== "bot") continue;
    const who = message.moderator
      ? "Moderator"
      : message.botId
        ? (names.get(message.botId) ?? "A bot")
        : "A former member";
    for (const url of messageLinks(message)) add(url, who, true);
    for (const part of message.parts) {
      if (part.type === "tool" && typeof part.args.url === "string") add(part.args.url, who, false);
    }
  }
  return [...found.values()].toSorted((a, b) => Number(b.cited) - Number(a.cited));
}

/** What a speaking bot is doing right now, in a few words. */
export function liveActivity(message: Message | undefined): string {
  if (!message || message.status !== "streaming") return "Getting ready…";
  const last = message.parts.at(-1);
  if (last?.type === "tool" && last.status === "running") {
    const args = last.args as { query?: unknown; url?: unknown };
    if (last.name === "web_search" && typeof args.query === "string") return `Searching: “${args.query}”`;
    if (typeof args.url === "string") return `Reading ${hostOf(args.url)}`;
    if (last.name.startsWith("browser_")) return "Reading a page";
    return "Looking something up";
  }
  if (last?.type === "reasoning") return "Thinking…";
  if (last?.type === "text") return "Writing…";
  return "Thinking…";
}

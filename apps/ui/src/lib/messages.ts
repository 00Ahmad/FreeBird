import type { Message, MessagePart } from "@mrog/shared";

/** A chunk of streamed text for one part of a message (the payload of a message.delta event). */
export interface Delta {
  threadId: string;
  messageId: string;
  partIndex: number;
  kind: "text" | "reasoning";
  text: string;
}

/** Joins back-to-back chunks for the same part, so a burst of tokens updates the cache once. */
export function coalesceDeltas(deltas: Delta[]): Delta[] {
  const out: Delta[] = [];
  for (const delta of deltas) {
    const last = out.at(-1);
    if (
      last &&
      last.messageId === delta.messageId &&
      last.partIndex === delta.partIndex &&
      last.kind === delta.kind
    )
      out[out.length - 1] = { ...last, text: last.text + delta.text };
    else out.push(delta);
  }
  return out;
}

const streamedLength = (message: Message) =>
  message.parts.reduce(
    (total, part) => total + (part.type === "text" || part.type === "reasoning" ? part.text.length : 0),
    0,
  );

/**
 * Whether the cached copy of a reply is the better one. The harness saves a streaming reply every 750 ms, so a
 * fetched copy can hold older text, miss a part that arrived since (an approval, a question), or still say
 * "streaming" for a reply that has since ended and will not be announced again.
 */
function cachedIsAhead(mine: Message, fetched: Message): boolean {
  if (mine.status !== "streaming" && fetched.status === "streaming") return true;
  if (mine.status !== "streaming" || fetched.status !== "streaming") return false;
  return mine.parts.length > fetched.parts.length || streamedLength(mine) > streamedLength(fetched);
}

/**
 * A refetched page of messages, keeping cached replies that are ahead of it. A fetch can return text older than
 * the chunks already shown, or miss a reply that started while it was in flight; taking it as is would make the
 * text jump back, drop the next chunks, or leave a finished reply "streaming" for good.
 */
export function keepStreamed(cached: Message[] | undefined, fetched: Message[]): Message[] {
  const live = new Map((cached ?? []).map((message) => [message.id, message]));
  if (live.size === 0) return fetched;
  let changed = false;
  const merged = fetched.map((message) => {
    const mine = live.get(message.id);
    live.delete(message.id);
    if (!mine || !cachedIsAhead(mine, message)) return message;
    changed = true;
    return mine;
  });
  // Started after the fetch was answered. An empty answer means the chat was cleared: nothing to keep.
  const newest = fetched.at(-1)?.createdAt;
  const started = newest
    ? [...live.values()].filter((message) => message.status === "streaming" && message.createdAt > newest)
    : [];
  if (started.length > 0) {
    changed = true;
    merged.push(...started.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }
  return changed ? merged : fetched;
}

/** A message in the live page: replaced where it is, or added in order. */
export function mergeMessage(old: Message[], message: Message): Message[] {
  const at = old.findIndex((existing) => existing.id === message.id);
  // Older than everything loaded: it belongs to history that isn't shown, not to the live page.
  if (at === -1 && old[0] && message.createdAt < old[0].createdAt) return old;
  if (at === -1) return [...old, message].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const next = old.slice();
  next[at] = message;
  return next;
}

/**
 * A streamed chunk appended to its message, creating the part if it is the next one. `partIndex` counts from the
 * start of the message, so a copy that lacks the parts before it (a saved copy that is behind) can't take the
 * chunk: it is left out, `behind` says so, and the caller refetches rather than leave a hole in the parts.
 */
export function mergeDelta(old: Message[], delta: Delta): { messages: Message[]; behind: boolean } {
  const at = old.findIndex((message) => message.id === delta.messageId);
  if (at === -1) return { messages: old, behind: false };
  const message = old[at]!;
  if (delta.partIndex > message.parts.length) return { messages: old, behind: true };
  const parts: MessagePart[] = message.parts.slice();
  const part = parts[delta.partIndex];
  if (part && part.type === delta.kind) parts[delta.partIndex] = { ...part, text: part.text + delta.text };
  else parts[delta.partIndex] = { type: delta.kind, text: delta.text };
  const next = old.slice();
  next[at] = { ...message, parts };
  return { messages: next, behind: false };
}

/** An event that arrived for a thread whose first page of messages was still on its way. */
export type HeldEvent = { message: Message } | { delta: Delta };

/** The held events applied, in the order they arrived, to the page that has just landed. */
export function replayHeld(page: Message[], held: HeldEvent[]): Message[] {
  let messages = page;
  for (const event of held)
    messages =
      "message" in event ? mergeMessage(messages, event.message) : mergeDelta(messages, event.delta).messages;
  return messages;
}

/**
 * Events for threads whose messages are being fetched for the first time. With nothing cached they would have
 * nothing to land on, and the text they carry is newer than anything the fetch returns.
 */
export class HeldEvents {
  private readonly held = new Map<string, { fetches: number; events: HeldEvent[] }>();

  /** Starts holding for a thread; call before the request goes out. */
  begin(threadId: string): void {
    const entry = this.held.get(threadId);
    if (entry) entry.fetches += 1;
    else this.held.set(threadId, { fetches: 1, events: [] });
  }

  /** Keeps the event if the thread is being fetched; false when nobody is waiting for it. */
  hold(threadId: string, event: HeldEvent): boolean {
    const entry = this.held.get(threadId);
    entry?.events.push(event);
    return Boolean(entry);
  }

  /**
   * One fetch is over. The last one still running gets what was kept; an earlier one (cancelled by a newer request)
   * gets nothing, as the newer one will replay it.
   */
  end(threadId: string): HeldEvent[] {
    const entry = this.held.get(threadId);
    if (!entry) return [];
    entry.fetches -= 1;
    if (entry.fetches > 0) return [];
    this.held.delete(threadId);
    return entry.events;
  }
}

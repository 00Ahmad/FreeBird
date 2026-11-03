import type { Message } from "@mrog/shared";

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
 * A refetched page of messages, keeping cached replies that are ahead of it. The harness saves a streaming
 * reply every 750 ms, so a fetch can return text older than the chunks already shown, or miss a reply that
 * started while it was in flight; taking it as is would make the text jump back and drop the next chunks.
 */
export function keepStreamed(cached: Message[] | undefined, fetched: Message[]): Message[] {
  const live = new Map(
    (cached ?? [])
      .filter((message) => message.status === "streaming")
      .map((message) => [message.id, message]),
  );
  if (live.size === 0) return fetched;
  let changed = false;
  const merged = fetched.map((message) => {
    const mine = live.get(message.id);
    live.delete(message.id);
    if (!mine || message.status !== "streaming" || streamedLength(mine) <= streamedLength(message))
      return message;
    changed = true;
    return mine;
  });
  // Started after the fetch was answered. An empty answer means the chat was cleared: nothing to keep.
  const newest = fetched.at(-1)?.createdAt;
  const started = newest ? [...live.values()].filter((message) => message.createdAt > newest) : [];
  if (started.length > 0) {
    changed = true;
    merged.push(...started.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }
  return changed ? merged : fetched;
}

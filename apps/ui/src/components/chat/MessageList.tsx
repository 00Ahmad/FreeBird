import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Bot, Message } from "@mrog/shared";
import { Button } from "@mrog/ui-kit";

import { useLibrary } from "../../hooks/library";
import { revealFrom, windowStart, WINDOW_SIZE, WINDOW_STEP } from "../../lib/transcript-window";
import { MessageActions, ReplyQuote } from "./MessageActions";
import { MessageItem } from "./MessageItem";

const GROUP_WINDOW_MS = 5 * 60_000;

interface MessageListProps {
  messages: Message[];
  bots: Map<string, Bot>;
  onReply(message: Message): void;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder(): void;
  /** The first reply that arrived while the user was away: a "New messages" line goes above it. */
  newFromId?: string | null;
}

export function MessageList({
  messages,
  bots,
  onReply,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  newFromId = null,
}: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** The first drawn message and its offset after the last render, to hold the view still when rows are added above. */
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const { data: library } = useLibrary();
  const saved = useMemo(() => new Set(library?.map((item) => item.messageId)), [library]);

  // Only the newest messages are drawn, and more as the user scrolls up. The window is kept by its first message's id
  // so that new replies at the bottom never take a row off the top while someone is reading there.
  const ids = useMemo(() => messages.map((message) => message.id), [messages]);
  const [startId, setStartId] = useState<string | null>(null);
  const start = windowStart(ids, startId, WINDOW_SIZE, [newFromId]);
  const visible = useMemo(() => messages.slice(start), [messages, start]);
  // Remember where the window begins (the newest 120 the first time; further up if something had to be reached).
  // Adjusted while rendering, as React advises for state that follows other state: React re-renders at once, before
  // anything is drawn, so there is no frame with the wrong window.
  const windowFirst = ids[start] ?? null;
  if (windowFirst !== startId) setStartId(windowFirst);

  // "Show earlier messages" at the very top fetches an older page; when it arrives, the window takes it in.
  const fetchedOlder = useRef(false);
  useEffect(() => {
    if (!fetchedOlder.current || !ids[0] || ids[0] === startId) return;
    fetchedOlder.current = false;
    setStartId(ids[0]);
  }, [ids, startId]);

  const showEarlier = () => {
    if (start > 0) {
      setStartId(ids[revealFrom(start, WINDOW_STEP)] ?? null);
    } else if (hasOlder) {
      fetchedOlder.current = true;
      onLoadOlder();
    }
  };

  // Reaching the top of what is drawn draws more of what is already loaded. Never fetches: with a short chat the top
  // is always in view, and that would fetch for ever.
  useEffect(() => {
    const sentinel = top.current;
    const root = scroller.current;
    if (start === 0 || !sentinel || !root) return;
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setStartId(ids[revealFrom(start, WINDOW_STEP)] ?? null);
      },
      { root, rootMargin: "300px 0px 0px 0px" },
    );
    watcher.observe(sentinel);
    return () => watcher.disconnect();
  }, [start, ids]);

  // Stay at the bottom while new text streams in, unless the user scrolled up to read.
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const find = (id: string) => el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    const previous = anchor.current;
    const head = visible[0];
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else if (previous && previous.id !== head?.id) {
      // Rows were added above (an older page, or more of the window): move by however far the old first row was pushed.
      const pushed = find(previous.id);
      if (pushed) el.scrollTop += pushed.offsetTop - previous.top;
    }
    const first = head && find(head.id);
    anchor.current = head && first ? { id: head.id, top: first.offsetTop } : null;
  }, [visible]);

  /** The newest reply of each bot: the only one that can be tried again. */
  const latestOf = useMemo(() => {
    const latest = new Map<string, string>();
    for (const message of messages)
      if (message.role === "bot" && message.botId) latest.set(message.botId, message.id);
    return latest;
  }, [messages]);

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto"
      role="log"
      aria-label="Messages"
    >
      <div className="mx-auto max-w-3xl px-5 pt-2 pb-6">
        {start > 0 && <div ref={top} aria-hidden className="h-px" />}
        {(start > 0 || hasOlder) && (
          <div className="flex justify-center py-2">
            <Button size="sm" variant="ghost" disabled={loadingOlder} onClick={showEarlier}>
              {loadingOlder ? "Loading…" : "Show earlier messages"}
            </Button>
          </div>
        )}
        {visible.map((message, index) => {
          const previous = visible[index - 1] ?? messages[start + index - 1];
          const grouped =
            !!previous &&
            !message.replyToId &&
            previous.role === message.role &&
            previous.botId === message.botId &&
            message.id !== newFromId &&
            Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUP_WINDOW_MS;
          return (
            <div key={message.id}>
              {message.id === newFromId && <NewMessagesLine />}
              <Row
                message={message}
                bot={message.botId ? bots.get(message.botId) : undefined}
                bots={bots}
                grouped={grouped}
                original={message.replyToId ? byId.get(message.replyToId) : undefined}
                saved={saved.has(message.id)}
                latest={message.botId !== null && latestOf.get(message.botId) === message.id}
                onReply={onReply}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Where what the user has not seen begins. */
function NewMessagesLine() {
  return (
    <div
      role="separator"
      aria-label="New messages"
      className="mt-4 flex items-center gap-3 text-[11px] font-semibold text-accent"
    >
      <span className="h-px flex-1 bg-accent/40" />
      <span className="tracking-wide uppercase">New messages</span>
      <span className="h-px flex-1 bg-accent/40" />
    </div>
  );
}

/**
 * One message with its reply quote and actions. Memoized: while a reply streams, only its own row re-renders,
 * since the cache keeps every other message object as it was.
 */
const Row = memo(function Row({
  message,
  bot,
  bots,
  grouped,
  original,
  saved,
  latest,
  onReply,
}: {
  message: Message;
  bot: Bot | undefined;
  bots: Map<string, Bot>;
  grouped: boolean;
  /** The message this one replies to. */
  original: Message | undefined;
  /** Already in the Library. */
  saved: boolean;
  /** The bot's newest reply in this chat. */
  latest: boolean;
  onReply(message: Message): void;
}) {
  return (
    <div data-message-id={message.id}>
      {message.replyToId && (
        <div className={message.role === "user" ? "mt-4 flex justify-end" : "mt-4 pl-11"}>
          <ReplyQuote original={original} bots={bots} />
        </div>
      )}
      <MessageItem
        message={message}
        bot={bot}
        grouped={grouped}
        latest={latest}
        actions={
          message.status !== "streaming" && (
            <MessageActions
              message={message}
              saved={saved}
              onReply={() => onReply(message)}
              align={message.role === "user" ? "end" : "start"}
            />
          )
        }
      />
    </div>
  );
});

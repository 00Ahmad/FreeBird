import { memo, useLayoutEffect, useMemo, useRef } from "react";

import type { Bot, Message } from "@mrog/shared";
import { Button } from "@mrog/ui-kit";

import { useLibrary } from "../../hooks/library";
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
}

export function MessageList({
  messages,
  bots,
  onReply,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** The first message and its offset after the last render, to hold the view still when older ones arrive. */
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const { data: library } = useLibrary();
  const saved = useMemo(() => new Set(library?.map((item) => item.messageId)), [library]);

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
    const head = messages[0];
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else if (previous && previous.id !== head?.id) {
      // Older messages were prepended: move by however far the old first message was pushed down.
      const pushed = find(previous.id);
      if (pushed) el.scrollTop += pushed.offsetTop - previous.top;
    }
    const first = head && find(head.id);
    anchor.current = head && first ? { id: head.id, top: first.offsetTop } : null;
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
        {hasOlder && (
          <div className="flex justify-center py-2">
            <Button size="sm" variant="ghost" disabled={loadingOlder} onClick={onLoadOlder}>
              {loadingOlder ? "Loading…" : "Show earlier messages"}
            </Button>
          </div>
        )}
        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const grouped =
            !!previous &&
            !message.replyToId &&
            previous.role === message.role &&
            previous.botId === message.botId &&
            Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUP_WINDOW_MS;
          return (
            <Row
              key={message.id}
              message={message}
              bot={message.botId ? bots.get(message.botId) : undefined}
              bots={bots}
              grouped={grouped}
              original={message.replyToId ? byId.get(message.replyToId) : undefined}
              saved={saved.has(message.id)}
              onReply={onReply}
            />
          );
        })}
      </div>
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

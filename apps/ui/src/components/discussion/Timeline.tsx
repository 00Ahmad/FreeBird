import { ArrowUp, ExternalLink, Gavel, Link2, Search } from "lucide-react";
import { forwardRef, memo, useEffect, useRef, useState } from "react";

import { messageText, type Bot, type Message } from "@mrog/shared";
import { BotAvatar, cn } from "@mrog/ui-kit";

import { hostOf, messageLinks, type Source } from "../../lib/discussion";
import { Markdown } from "../chat/Markdown";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

interface TimelineProps {
  messages: Message[];
  bots: Map<string, Bot>;
  roles: Record<string, string>;
  sources: Source[];
  disabled: boolean;
  onSend(text: string): Promise<unknown>;
}

/** The debate as it happens: one card per turn, the moderator's report last, and every source on its own tab. */
export const Timeline = forwardRef<HTMLTextAreaElement, TimelineProps>(function Timeline(
  { messages, bots, roles, sources, disabled, onSend },
  inputRef,
) {
  const [tab, setTab] = useState<"timeline" | "sources">("timeline");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const visible = messages.filter((message) => message.role !== "system");

  // Follow new turns and streaming text unless the user scrolled up to read.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const element = scroller.current;
      if (element && pinned.current) element.scrollTop = element.scrollHeight;
    });
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, []);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(trimmed);
      setText("");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="stage-panel flex min-h-0 w-[min(380px,36%)] shrink-0 flex-col">
      <div className="flex items-center gap-4 border-b border-border px-4 pt-3">
        <h2 className="flex-1 pb-2.5 text-[15px] font-semibold">Debate</h2>
        {(["timeline", "sources"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={cn(
              "-mb-px border-b-2 pb-2.5 text-[13px] capitalize",
              tab === name ? "border-accent text-accent" : "border-transparent text-ink-3 hover:text-ink",
            )}
          >
            {name}
            {name === "sources" && sources.length > 0 && (
              <span className="ml-1 rounded-full bg-selected px-1.5 text-[11px]">{sources.length}</span>
            )}
          </button>
        ))}
      </div>

      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        <div ref={content}>
          {tab === "sources" ? (
            <SourceList sources={sources} />
          ) : visible.length === 0 ? (
            <p className="px-2 py-8 text-center text-[13px] text-ink-3">
              The bots' turns appear here as they speak.
            </p>
          ) : (
            <ol className="relative flex flex-col gap-3 before:absolute before:top-2 before:bottom-2 before:left-[58px] before:w-px before:bg-border">
              {visible.map((message) => (
                <TurnCard
                  key={message.id}
                  message={message}
                  bot={message.botId ? bots.get(message.botId) : undefined}
                  role={message.botId ? roles[message.botId] : undefined}
                />
              ))}
            </ol>
          )}
        </div>
      </div>

      <form
        className="border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {error && <p className="mb-1.5 px-1 text-xs text-danger">{error}</p>}
        <div className="flex items-end gap-2 rounded-xl border border-border bg-bg px-3 py-2 focus-within:border-accent">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={1}
            disabled={disabled}
            placeholder="Add to the discussion… (@Name speaks next)"
            aria-label="Add to the discussion"
            className="max-h-32 min-h-6 flex-1 resize-none bg-transparent text-[13px] leading-6 outline-none placeholder:text-ink-3"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={disabled || sending || !text.trim()}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink disabled:bg-hover disabled:text-ink-3"
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </form>
    </aside>
  );
});

/** Memoized: while one turn streams, the cards before it stay as they are. */
const TurnCard = memo(function TurnCard({
  message,
  bot,
  role,
}: {
  message: Message;
  bot: Bot | undefined;
  role: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const text = messageText(message);
  const streaming = message.status === "streaming";
  const lookups = message.parts.filter((part) => part.type === "tool").length;
  const links = messageLinks(message);
  const report = message.role === "bot" && message.moderator;
  const user = message.role === "user";
  const long = text.length > 700;

  return (
    <li className="relative flex gap-3">
      <div className="w-[52px] shrink-0 pt-3 text-right text-[10.5px] whitespace-nowrap text-ink-3 tabular-nums">
        {time(message.createdAt)}
      </div>
      <span
        className={cn(
          "absolute top-4 left-[55px] size-[7px] rounded-full ring-4 ring-[var(--mrog-bg)]",
          streaming ? "bg-success" : report ? "bg-warning" : "bg-accent",
        )}
      />
      <div
        className={cn(
          "min-w-0 flex-1 rounded-xl border p-3",
          report
            ? "border-warning/40 bg-warning/5"
            : user
              ? "border-accent/30 bg-selected"
              : "border-border bg-surface/70",
          streaming && "border-success/50",
        )}
      >
        <div className="mb-1.5 flex items-center gap-2">
          {report ? (
            <span className="flex size-6 items-center justify-center rounded-full bg-warning/15 text-warning">
              <Gavel size={13} />
            </span>
          ) : bot ? (
            <BotAvatar avatar={bot.avatar} size={24} />
          ) : null}
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-semibold">
              {report ? "Final report" : user ? "You" : (bot?.name ?? "Bot")}
            </div>
            {role && !report && <div className="truncate text-[11px] text-ink-3">{role}</div>}
          </div>
          {streaming && <span className="text-[11px] font-medium text-success">live</span>}
        </div>

        {text ? (
          <div
            className={cn(
              "relative text-[13px] leading-relaxed",
              long && !open && "max-h-56 overflow-hidden",
            )}
          >
            <Markdown text={text} />
            {long && !open && (
              <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--mrog-surface)] to-transparent" />
            )}
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-3">{streaming ? "Researching…" : "No text."}</p>
        )}
        {long && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mt-1 text-[12px] text-accent hover:underline"
          >
            {open ? "Show less" : "Show all"}
          </button>
        )}

        {(lookups > 0 || links.length > 0) && !report && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-[11px] text-ink-3">
            {lookups > 0 && (
              <span className="flex items-center gap-1">
                <Search size={11} /> {lookups} lookup{lookups === 1 ? "" : "s"}
              </span>
            )}
            {links.slice(0, 4).map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="flex max-w-[11rem] items-center gap-1 rounded-full border border-border px-2 py-0.5 hover:border-accent hover:text-accent"
              >
                <Link2 size={10} className="shrink-0" />
                <span className="truncate">{hostOf(url)}</span>
              </a>
            ))}
            {links.length > 4 && <span>+{links.length - 4}</span>}
          </div>
        )}
      </div>
    </li>
  );
});

function SourceList({ sources }: { sources: Source[] }) {
  if (sources.length === 0)
    return <p className="px-2 py-8 text-center text-[13px] text-ink-3">No sources yet.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {sources.map((source) => (
        <li key={source.url} className="rounded-xl border border-border bg-surface/70 p-3">
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1.5 text-[13px] font-medium hover:text-accent"
          >
            <span className="truncate">{source.host}</span>
            <ExternalLink size={12} className="shrink-0" />
          </a>
          <div className="mt-0.5 truncate text-[11px] text-ink-3">{source.url}</div>
          <div className="mt-1.5 flex items-center gap-2 text-[11px]">
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5",
                source.cited ? "bg-success/15 text-success" : "bg-hover text-ink-3",
              )}
            >
              {source.cited ? "Cited" : "Opened"}
            </span>
            <span className="text-ink-3">by {source.by.join(", ")}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

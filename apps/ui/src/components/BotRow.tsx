import { BellRing, Briefcase, CodeXml, Handshake, Pin, Star } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import type { Bot } from "@mrog/shared";
import { BotAvatar, cn } from "@mrog/ui-kit";

import { useUpdateBot } from "../hooks/bots";
import { useCodingSeen } from "../codingSeen";
import { useCodingProject } from "../hooks/coding";
import { shownAttention } from "../lib/codingAttention";
import { badgeText } from "../lib/unread";
import { useUi } from "../state";
import { useUnread } from "../unread";

interface BotRowProps {
  bot: Bot;
  /** The chat a click opens: the bot's own, or for a helper its conversation with the bot that made it. */
  chatId: string;
  selected: boolean;
  /** Avatar only (compact sidebar, Ctrl+B). */
  compact?: boolean;
  /** False for a Coding Bot's role bots, which are named after their team. */
  canRename?: boolean;
  onContextMenu(event: MouseEvent, bot: Bot): void;
}

export function BotRow({ bot, chatId, selected, compact, canRename = true, onContextMenu }: BotRowProps) {
  const select = useUi((state) => state.select);
  const startRename = useUi((state) => state.startRename);
  const busy = useUi((state) => Boolean(state.activity[bot.threadId]));
  const unread = useUnread((store) => store.state.threads[bot.threadId]?.ids.length ?? 0);
  // A Coding Bot that is waiting for you says so on its row, whatever chat is open. "Finished" and "Error" go once
  // you have opened its chat since.
  const { data: project } = useCodingProject(bot.id, bot.coding);
  const seen = useCodingSeen((store) => store.byBot[bot.id]);
  const attention = bot.coding ? shownAttention(project, seen) : null;
  const renaming = useUi((state) => state.renamingBotId === bot.id) && !compact && canRename;

  if (renaming) return <RenameRow bot={bot} onDone={() => startRename(null)} />;

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => select(chatId)}
        onContextMenu={(event) => onContextMenu(event, bot)}
        aria-current={selected ? "page" : undefined}
        aria-label={[bot.name, attention, unread > 0 ? `${unread} unread` : null].filter(Boolean).join(", ")}
        title={attention ? `${bot.name}: ${attention}` : bot.name}
        className={cn(
          "relative flex h-10 w-full items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent",
          selected ? "bg-selected" : "hover:bg-hover",
        )}
      >
        <BotAvatar avatar={bot.avatar} size={26} />
        {busy && (
          <span className="absolute top-1.5 right-1.5 size-1.5 animate-pulse rounded-full bg-accent" />
        )}
        {attention && (
          // The same wait the full row spells out, as a small bell on the avatar.
          <span
            aria-hidden
            className="absolute right-1 bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-warning text-accent-ink ring-2 ring-sidebar"
          >
            <BellRing size={8} />
          </span>
        )}
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute top-1 left-1.5 size-2.5 rounded-full bg-accent ring-2 ring-sidebar"
          />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => select(chatId)}
      onDoubleClick={() => canRename && startRename(bot.id)}
      onContextMenu={(event) => onContextMenu(event, bot)}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "group flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left outline-none",
        "focus-visible:ring-2 focus-visible:ring-accent",
        selected ? "bg-selected text-ink" : "text-ink hover:bg-hover",
        bot.hidden && "opacity-60",
      )}
    >
      <BotAvatar avatar={bot.avatar} size={26} />
      <span
        className={cn("min-w-0 flex-1 truncate text-[13.5px]", unread > 0 ? "font-semibold" : "font-medium")}
      >
        {bot.name}
      </span>
      {bot.coding && <CodeXml size={13} className="shrink-0 text-ink-3" aria-label="Coding Bot" />}
      {bot.job && <Briefcase size={13} className="shrink-0 text-ink-3" aria-label="Job Bot" />}
      {bot.client && <Handshake size={13} className="shrink-0 text-ink-3" aria-label="Client Bot" />}
      {attention && (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-hover px-1.5 py-px text-[11px] font-medium text-warning">
          <BellRing size={10} aria-hidden /> {attention}
        </span>
      )}
      {busy && (
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-label="Working" />
      )}
      {unread > 0 && <UnreadBadge count={unread} />}
      {bot.isPrimary && (
        <Star size={13} className="shrink-0 fill-current text-warning" aria-label="Primary Bot" />
      )}
      {bot.pinned && !bot.isPrimary && <Pin size={13} className="shrink-0 text-ink-3" aria-label="Pinned" />}
    </button>
  );
}

/** How many replies are waiting in a chat, as a small badge at the end of its row. */
export function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      className="min-w-[18px] shrink-0 rounded-full bg-accent px-1.5 text-center text-[11px] leading-[18px] font-semibold text-accent-ink"
      aria-label={`${count} unread`}
    >
      {badgeText(count)}
    </span>
  );
}

function RenameRow({ bot, onDone }: { bot: Bot; onDone(): void }) {
  const update = useUpdateBot();
  const [value, setValue] = useState(bot.name);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const name = value.trim();
    if (save && name && name !== bot.name) update.mutate({ id: bot.id, patch: { name } });
    onDone();
  };

  return (
    <div className="flex h-10 items-center gap-2.5 rounded-lg bg-selected px-2">
      <BotAvatar avatar={bot.avatar} size={26} />
      <input
        ref={input}
        value={value}
        maxLength={60}
        aria-label="Bot name"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") finish(true);
          if (event.key === "Escape") finish(false);
        }}
        className="min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 py-0.5 text-[13.5px] font-medium text-ink outline-none"
      />
    </div>
  );
}

import { Pin, Star } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import type { Bot } from "@mrog/shared";
import { BotAvatar, cn } from "@mrog/ui-kit";

import { useUpdateBot } from "../hooks/bots";
import { useUi } from "../state";

interface BotRowProps {
  bot: Bot;
  selected: boolean;
  /** Avatar only (compact sidebar, Ctrl+B). */
  compact?: boolean;
  onContextMenu(event: MouseEvent, bot: Bot): void;
}

export function BotRow({ bot, selected, compact, onContextMenu }: BotRowProps) {
  const select = useUi((state) => state.select);
  const startRename = useUi((state) => state.startRename);
  const busy = useUi((state) => Boolean(state.activity[bot.threadId]));
  const renaming = useUi((state) => state.renamingBotId === bot.id) && !compact;

  if (renaming) return <RenameRow bot={bot} onDone={() => startRename(null)} />;

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => select(bot.threadId)}
        onContextMenu={(event) => onContextMenu(event, bot)}
        aria-current={selected ? "page" : undefined}
        aria-label={bot.name}
        title={bot.name}
        className={cn(
          "relative flex h-10 w-full items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent",
          selected ? "bg-selected" : "hover:bg-hover",
        )}
      >
        <BotAvatar avatar={bot.avatar} size={26} />
        {busy && (
          <span className="absolute top-1.5 right-1.5 size-1.5 animate-pulse rounded-full bg-accent" />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => select(bot.threadId)}
      onDoubleClick={() => startRename(bot.id)}
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
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{bot.name}</span>
      {busy && (
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-label="Working" />
      )}
      {bot.isPrimary && (
        <Star size={13} className="shrink-0 fill-current text-warning" aria-label="Primary Bot" />
      )}
      {bot.pinned && !bot.isPrimary && <Pin size={13} className="shrink-0 text-ink-3" aria-label="Pinned" />}
    </button>
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

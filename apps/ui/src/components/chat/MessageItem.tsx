import { Brain, ChevronRight, Columns3, Gavel } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { messageText, type Bot, type Message, type MessagePart } from "@mrog/shared";
import { BotAvatar, cn } from "@mrog/ui-kit";

import { Markdown } from "./Markdown";
import { parallelLabel, parallelView } from "../../lib/parallelLanes";
import { LaneCards } from "./LaneCards";
import { ParallelCards } from "./ParallelCards";
import { PlanCard } from "./PlanCard";
import { ToolCard } from "./ToolCard";
import { QuestionCard } from "./QuestionCard";
import { ErrorNotice, SlowReply } from "./ReplyTrouble";
import { SecretCard } from "./SecretCard";

interface MessageItemProps {
  message: Message;
  bot: Bot | undefined;
  /** Hide the avatar/name when the previous message came from the same sender. */
  grouped: boolean;
  /** Extra controls (reply, reactions) added by later phases. */
  actions?: ReactNode;
  /** The newest reply from this bot in its chat: the only one that can be tried again. */
  latest?: boolean;
}

export function MessageItem({ message, bot, grouped, actions, latest = false }: MessageItemProps) {
  // App notes (a routine starting) sit centered between messages.
  if (message.role === "system") {
    const [title, ...rest] = messageText(message).split("\n");
    return (
      <div className="mt-5 flex justify-center">
        <div className="max-w-[80%] rounded-xl border border-border bg-surface px-3.5 py-2 text-center text-[12.5px]">
          <div className="font-medium text-ink-2">{title}</div>
          {rest.join("\n").trim() && (
            <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-ink-3 select-text">
              {rest.join("\n").trim()}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (message.role === "user") {
    return (
      <div className={cn("group flex justify-end", grouped ? "mt-1" : "mt-4")}>
        <div className="flex max-w-[78%] flex-col items-end gap-1">
          {message.parallel && (
            <span className="flex items-center gap-1 text-[11px] text-ink-3">
              <Columns3 size={11} /> {parallelLabel(message)}
            </span>
          )}
          {message.parts.map((part, index) => (
            <UserPart key={index} part={part} />
          ))}
          {actions}
        </div>
      </div>
    );
  }

  const streaming = message.status === "streaming";
  const empty = message.parts.length === 0;
  const lanes = parallelView(message) === "lanes";
  return (
    <div className={cn("group flex gap-3", grouped ? "mt-1" : "mt-4")}>
      <div className="w-8 shrink-0">
        {!grouped && bot && <BotAvatar avatar={bot.avatar} size={30} />}
        {!grouped && message.moderator && (
          <span className="flex size-[30px] items-center justify-center rounded-full bg-selected text-ink-2">
            <Gavel size={15} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="mb-0.5 text-[13px] font-semibold">
            {bot?.name ?? (message.moderator ? "Moderator" : message.botId ? "Bot" : "A former member")}
          </div>
        )}
        <div className="flex flex-col gap-1.5 text-[14.5px] leading-relaxed">
          {lanes ? (
            // The roles ran as separate conversations (with tools, or three requests on a cloud model): three cards.
            <LaneCards message={message} bot={bot} latest={latest} />
          ) : (
            message.parts.map((part, index) => (
              <BotPart
                key={index}
                part={part}
                message={message}
                bot={bot}
                latest={latest}
                last={index === message.parts.length - 1}
              />
            ))
          )}
          {streaming && empty && !lanes && <TypingDots />}
          {streaming && empty && <SlowReply message={message} bot={bot} />}
          {message.status === "stopped" && <span className="text-xs text-ink-3">Stopped</span>}
        </div>
        {actions}
      </div>
    </div>
  );
}

function UserPart({ part }: { part: MessagePart }) {
  if (part.type === "image") return <UserImage mediaType={part.mediaType} data={part.data} />;
  if (part.type !== "text") return null;
  return (
    <div className="rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-[14.5px] whitespace-pre-wrap text-accent-ink select-text">
      {part.text}
    </div>
  );
}

/** An attached picture; its data: URL (up to 5 MB) is built once, not on every render. */
function UserImage({ mediaType, data }: { mediaType: string; data: string }) {
  const src = useMemo(() => `data:${mediaType};base64,${data}`, [mediaType, data]);
  return (
    <img src={src} alt="Attached" className="max-h-64 rounded-2xl border border-border object-contain" />
  );
}

function BotPart({
  part,
  message,
  bot,
  latest,
  last,
}: {
  part: MessagePart;
  message: Message;
  bot: Bot | undefined;
  latest: boolean;
  last: boolean;
}) {
  const streaming = message.status === "streaming" && last;
  switch (part.type) {
    case "text":
      if (message.parallel)
        return <ParallelCards text={part.text} streaming={streaming} done={message.status === "done"} />;
      return (
        <div className={cn("select-text", streaming && "streaming-caret")}>
          <Markdown text={part.text} />
        </div>
      );
    case "reasoning":
      return <Reasoning text={part.text} active={streaming} />;
    case "tool":
      // The plan shows once, at its latest version, where the bot first wrote it.
      if (part.name === "update_plan") {
        const plans = message.parts.filter((p) => p.type === "tool" && p.name === "update_plan");
        return plans[0] === part ? <PlanCard part={plans.at(-1) as typeof part} /> : null;
      }
      return <ToolCard part={part} />;
    case "question":
      return <QuestionCard part={part} live={message.status === "streaming"} />;
    case "secret":
      return <SecretCard part={part} live={message.status === "streaming"} />;
    case "error":
      return <ErrorNotice part={part} message={message} bot={bot} latest={latest} />;
    default:
      return null;
  }
}

function Reasoning({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[13px] text-ink-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md py-0.5 hover:text-ink-2"
      >
        <Brain size={13} />
        {active ? "Thinking…" : "Thought it through"}
        <ChevronRight size={13} className={cn("transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border pl-3 whitespace-pre-wrap select-text">{text}</div>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex h-6 items-center gap-1" aria-label="Typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-ink-3"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Hourglass,
  PenLine,
  Search,
  Square,
  TriangleAlert,
} from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";

import type { Bot, Message } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

import { useRuntime } from "../../hooks/runtime";
import {
  laneLayout,
  laneToolTitle,
  LANE_STATUS_LABEL,
  splitShared,
  type LaneCard,
  type LaneStatus,
} from "../../lib/parallelLanes";
import { Markdown } from "./Markdown";
import { ErrorNotice } from "./ReplyTrouble";
import { ToolCard } from "./ToolCard";

/** How many sources show before "more". */
const SOURCES_SHOWN = 4;
/** The default steps per role, until the settings have loaded. */
const DEFAULT_STEPS = 6;

const STATUS_ICON: Record<LaneStatus, ReactNode> = {
  waiting: <Hourglass size={11} aria-hidden />,
  searching: <Search size={11} aria-hidden className="animate-pulse motion-reduce:animate-none" />,
  writing: <PenLine size={11} aria-hidden className="animate-pulse motion-reduce:animate-none" />,
  done: <Check size={11} aria-hidden />,
  failed: <TriangleAlert size={11} aria-hidden />,
  stopped: <Square size={11} aria-hidden />,
  no_answer: <CircleSlash size={11} aria-hidden />,
};

const STATUS_TONE: Record<LaneStatus, string> = {
  waiting: "bg-hover text-ink-3",
  searching: "bg-selected text-accent",
  writing: "bg-selected text-accent",
  done: "bg-hover text-success",
  failed: "bg-hover text-danger",
  stopped: "bg-hover text-ink-3",
  no_answer: "bg-hover text-warning",
};

/**
 * A Parallel Bots reply with tools: one card per role, each with its own searches, sources, step count and answer,
 * all filling in at the same time. Parts that belong to no lane (a note about memory, say) sit above the cards.
 */
export const LaneCards = memo(function LaneCards({
  message,
  bot,
  latest,
}: {
  message: Message;
  bot: Bot | undefined;
  latest: boolean;
}) {
  const { data: runtime } = useRuntime();
  const stepsMax = runtime?.settings.parallelSteps ?? DEFAULT_STEPS;
  const { cards, shared } = useMemo(
    () => laneLayout(message.parts, stepsMax, message.status, message.parallelTools),
    [message.parts, stepsMax, message.status, message.parallelTools],
  );
  const { notices, rest } = useMemo(() => splitShared(shared), [shared]);

  return (
    <div className="flex flex-col gap-2">
      {notices.map((notice, at) => (
        <p
          key={at}
          role="note"
          className="rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] text-ink-2 select-text"
        >
          {notice}
        </p>
      ))}
      {rest.map((part, at) =>
        part.type === "tool" ? (
          <ToolCard key={at} part={part} />
        ) : part.type === "error" ? (
          <ErrorNotice key={at} part={part} message={message} bot={bot} latest={latest} />
        ) : null,
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-2">
        {cards.map((card, at) =>
          card ? (
            <LaneCardView key={card.index} card={card} />
          ) : (
            <Placeholder key={`wait-${at}`} index={at + 1} />
          ),
        )}
      </div>
      {cards.length === 0 && message.status !== "streaming" && (
        <p className="text-xs text-ink-3">
          This reply has no sections. Send your question again for a fresh reply.
        </p>
      )}
    </div>
  );
});

function Placeholder({ index }: { index: number }) {
  return (
    <div
      aria-hidden
      className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-[13px] text-ink-3"
    >
      <Hourglass size={13} /> Bot {index} is starting…
    </div>
  );
}

function LaneCardView({ card }: { card: LaneCard }) {
  const [more, setMore] = useState(false);
  const shown = more ? card.sources : card.sources.slice(0, SOURCES_SHOWN);
  const hidden = card.sources.length - SOURCES_SHOWN;
  return (
    <section
      aria-label={`${card.name}: ${LANE_STATUS_LABEL[card.status]}`}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5"
    >
      <h4 className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-selected text-[11px] text-ink-2">
          {card.index}
        </span>
        <span className="min-w-0 flex-1 truncate" title={card.name}>
          {card.name}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
            STATUS_TONE[card.status],
          )}
        >
          {STATUS_ICON[card.status]}
          {LANE_STATUS_LABEL[card.status]}
        </span>
      </h4>
      {card.focus && (
        <p className="-mt-1.5 line-clamp-2 pl-7 text-[12px] text-ink-3" title={card.focus}>
          {card.focus}
        </p>
      )}

      {card.withTools && <p className="text-[11.5px] text-ink-3 tabular-nums">{card.stepsText}</p>}

      {card.tools.length > 0 && (
        <div className="flex flex-col gap-1" aria-label="Searches">
          {card.tools.map((tool) => (
            <ToolCard key={tool.callId} part={tool} label={laneToolTitle(tool)} />
          ))}
        </div>
      )}

      {card.sources.length > 0 && (
        <div className="text-[12px]">
          <p className="mb-0.5 text-ink-3">Sources</p>
          <ul className="flex flex-wrap gap-x-2 gap-y-0.5">
            {shown.map((source) => (
              <li key={source.url} className="min-w-0 max-w-full">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={source.url}
                  className="block truncate text-accent underline-offset-2 hover:underline"
                >
                  {source.host}
                </a>
              </li>
            ))}
            {hidden > 0 && (
              <li>
                <button
                  type="button"
                  onClick={() => setMore((open) => !open)}
                  aria-expanded={more}
                  className="inline-flex items-center gap-0.5 text-ink-3 hover:text-ink"
                >
                  {more ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
                  {more ? "fewer" : `${hidden} more`}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      {card.hasAnswer && (
        <div className={cn("text-[14px] select-text", card.status === "writing" && "streaming-caret")}>
          <Markdown text={card.answer} />
        </div>
      )}

      {card.error && (
        <p role="alert" className="flex items-start gap-1.5 text-[12.5px] text-danger select-text">
          <TriangleAlert size={13} aria-hidden className="mt-px shrink-0" />
          {card.error}
        </p>
      )}
      {card.status === "no_answer" && (
        <p className="text-[12.5px] text-ink-3">This role finished without writing an answer.</p>
      )}
      {!card.hasAnswer && !card.error && card.status === "waiting" && (
        <p className="text-[12.5px] text-ink-3">Getting started…</p>
      )}
    </section>
  );
}

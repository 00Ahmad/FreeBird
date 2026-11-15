import { ArrowRight, Cable, FileCode, MessageSquareWarning, Timer, TriangleAlert } from "lucide-react";
import { useEffect, useMemo } from "react";

import type { CodingProject } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

import type { CardActivity } from "../../lib/codingActivity";
import { buildBoard, COLUMN_COLOR, columnLabel, type BoardCard } from "../../lib/codingBoard";
import { emptyPlanText } from "../../lib/codingFeedback";
import { cardElapsedSeconds, cardWorkLine, isSlowCard, slowBadge, SLOW_TOOLTIP } from "../../lib/codingWork";
import { Chip, Comments, KindBadge, tint } from "./parts";

export const cardDomId = (cardId: string) => `coding-card-${cardId}`;

/** Todo / In progress / QA / Done. On a narrow panel the columns scroll sideways. */
export function CodingBoard({
  project,
  now,
  selectedRef,
  onSelect,
  activity,
  onAcknowledge,
}: {
  project: CodingProject;
  /** The panel's clock, so a card being worked on shows a live timer. */
  now: number;
  selectedRef: string | null;
  onSelect(ref: string | null): void;
  /** What changed lately: cards that moved flash, and cards with a new QA comment get a badge. */
  activity: CardActivity | undefined;
  onAcknowledge(cardId: string): void;
}) {
  const board = useMemo(() => buildBoard(project), [project]);

  // A card picked in the diagram or the checklist is brought into view here: when the pick changes (or the board
  // opens with one), not on every update of the project, which would pull the board back while you scroll it.
  const pickedId = project.cards.find((card) => card.ref === selectedRef)?.id ?? null;
  useEffect(() => {
    if (pickedId)
      document.getElementById(cardDomId(pickedId))?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pickedId]);

  if (project.cards.length === 0) {
    return <p className="p-6 text-center text-[13px] text-ink-3">{emptyPlanText(project.status, "board")}</p>;
  }

  return (
    // As many columns as fit (two across in the default panel, four when it is widened): none hides off to the side.
    <div className="grid h-full auto-rows-min grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] items-start gap-x-3 gap-y-5 overflow-auto p-3">
      {board.map((column) => (
        <section
          key={column.column}
          aria-label={`${column.label}, ${column.count} ${column.count === 1 ? "card" : "cards"}`}
          className="flex min-w-0 flex-col gap-2"
        >
          <h3 className="sticky top-0 z-10 flex items-center gap-2 bg-surface pb-1 text-[12.5px] font-semibold">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ background: COLUMN_COLOR[column.column] }}
            />
            {column.label}
            <span className="rounded-full bg-hover px-1.5 text-[11px] font-medium text-ink-2">
              {column.count}
            </span>
          </h3>
          {column.cards.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-2 py-3 text-center text-xs text-ink-3">
              Nothing here
            </p>
          )}
          {column.cards.map((item) => (
            <Card
              key={item.card.id}
              item={item}
              selected={item.card.ref === selectedRef}
              workLine={cardWorkLine(item.card, project, now)}
              slowFor={
                isSlowCard(item.card, project, now) ? cardElapsedSeconds(item.card, project, now) : null
              }
              movedTo={activity?.moved[item.card.id]?.to ?? null}
              newQa={Boolean(activity?.unseenQa[item.card.id])}
              onSelect={() => {
                onAcknowledge(item.card.id);
                onSelect(item.card.ref === selectedRef ? null : item.card.ref);
              }}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function Card({
  item,
  selected,
  workLine,
  slowFor,
  movedTo,
  newQa,
  onSelect,
}: {
  item: BoardCard;
  selected: boolean;
  /** Time and tokens spent, or null before any. */
  workLine: string | null;
  /** Seconds, when the card has taken 10 minutes or more. */
  slowFor: number | null;
  /** The column it just moved to, while that is news. */
  movedTo: BoardCard["card"]["column"] | null;
  newQa: boolean;
  onSelect(): void;
}) {
  const { card } = item;
  const file = card.kind === "file";
  const Icon = file ? FileCode : Cable;
  const summary = file ? item.node?.purpose : item.edge?.description;
  return (
    <article
      id={cardDomId(card.id)}
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-bg p-2.5 text-[12.5px]",
        // A connector is a different kind of thing from a file, so its card is shaped differently too.
        !file && "border-dashed",
        item.needsFixing ? "border-danger/60" : "border-border",
        selected && "ring-2 ring-accent",
        movedTo && "coding-flash",
      )}
      style={{
        ...(item.needsFixing ? { background: tint("var(--mrog-danger)", 7) } : {}),
        // The flash is in the colour of the column the card moved to.
        ...(movedTo ? ({ "--flash": COLUMN_COLOR[movedTo] } as object) : {}),
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex w-full items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          className="mt-px flex size-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: tint(COLUMN_COLOR[card.column], 16), color: COLUMN_COLOR[card.column] }}
        >
          <Icon size={13} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <KindBadge kind={card.kind} />
            {item.label && <Chip color="var(--mrog-ink-2)">{item.label}</Chip>}
            {movedTo && (
              <span
                className="inline-flex items-center gap-1 text-[11px] font-medium"
                style={{ color: COLUMN_COLOR[movedTo] }}
              >
                <ArrowRight size={11} aria-hidden /> Moved to {columnLabel(movedTo)}
              </span>
            )}
            {newQa && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning px-1.5 py-px text-[11px] font-semibold text-accent-ink">
                <MessageSquareWarning size={11} aria-hidden /> New QA comment
              </span>
            )}
            {slowFor !== null && (
              <span
                title={SLOW_TOOLTIP}
                className="inline-flex items-center gap-1 rounded-full bg-hover px-1.5 py-px text-[11px] font-semibold text-warning"
              >
                <Timer size={11} aria-hidden /> {slowBadge(slowFor)}
                <span className="sr-only">. {SLOW_TOOLTIP}</span>
              </span>
            )}
            {item.needsFixing && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-danger">
                <TriangleAlert size={11} aria-hidden /> Needs fixing
              </span>
            )}
          </span>
          <span className={cn("font-medium break-all", file && item.node && "font-mono text-[12px]")}>
            {file && item.node ? item.node.path : card.title}
          </span>
          {workLine && <span className="text-[11px] text-ink-3 tabular-nums">{workLine}</span>}
          {summary && (
            <span className="line-clamp-3 text-ink-2" title={summary}>
              {summary}
            </span>
          )}
        </span>
      </button>
      {!file && item.linked.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Links these files">
          {item.linked.map((linked) => (
            <li
              key={linked.id}
              className="max-w-full truncate rounded bg-hover px-1.5 py-px font-mono text-[11px] text-ink-2"
              title={linked.path}
            >
              {linked.path}
            </li>
          ))}
        </ul>
      )}
      <Comments card={card} />
    </article>
  );
}

import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { Bot, JobCard, JobProject } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { useCheckOpen } from "../../hooks/jobs";
import {
  boardColumns,
  canScan,
  cardCompany,
  cardTitle,
  COLUMN_LABELS,
  foundOn,
  isNew,
  scoreTone,
  type BoardSort,
} from "../../lib/jobs";
import { JobDetails } from "./JobDetails";

const TONE = {
  strong: "bg-success/15 text-success",
  good: "bg-accent/15 text-accent",
  weak: "bg-ink-3/15 text-ink-3",
} as const;

/** The board as a list of columns; a column with nothing in it stays folded away. */
export function JobBoard({ bot, project }: { bot: Bot; project: JobProject }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({ not_for_me: true, rejected: true });
  const [sort, setSort] = useState<BoardSort>("best");
  const [onlyNew, setOnlyNew] = useState(false);
  const check = useCheckOpen(bot.id);
  const open = project.cards.find((card) => card.id === openId);
  if (open) return <JobDetails bot={bot} card={open} onBack={() => setOpenId(null)} />;
  if (project.cards.length === 0)
    return (
      <p className="p-4 text-[13px] text-ink-3">
        No jobs yet.{" "}
        {project.status === "ready"
          ? "Press Scan to look for some."
          : "Once your profile is approved, start a scan."}
      </p>
    );
  const columns = boardColumns(project.cards, {
    sort,
    onlyNew,
    latestScan: project.scan?.number ?? null,
  }).filter((column) => column.cards.length > 0);
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <select
          aria-label="Sort the board"
          value={sort}
          onChange={(event) => setSort(event.target.value as BoardSort)}
          className="h-7 rounded-lg border border-border bg-bg px-2"
        >
          <option value="best">Best match first</option>
          <option value="newest">Newest first</option>
        </select>
        <label className="flex items-center gap-1 text-ink-2">
          <input type="checkbox" checked={onlyNew} onChange={(event) => setOnlyNew(event.target.checked)} />
          Only new
        </label>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => check.mutate()}
          disabled={check.isPending || !canScan(project)}
          title="Reads each Found and Shortlisted job again (no model), and marks the ones gone or closed"
        >
          <RefreshCw size={12} /> Check still open
        </Button>
      </div>
      {check.error && <p className="text-[12px] text-danger">{check.error.message}</p>}
      {columns.length === 0 && <p className="px-1 text-[12.5px] text-ink-3">No jobs from the latest scan.</p>}
      {columns.map(({ column, cards }) => {
        const shut = folded[column] ?? false;
        return (
          <section key={column} aria-label={COLUMN_LABELS[column]}>
            <button
              type="button"
              onClick={() => setFolded((current) => ({ ...current, [column]: !shut }))}
              className="flex w-full items-center gap-1 px-1 pb-1 text-[12px] font-medium text-ink-2"
              aria-expanded={!shut}
            >
              {shut ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              {COLUMN_LABELS[column]} <span className="text-ink-3">· {cards.length}</span>
            </button>
            {!shut && (
              <ul className="flex flex-col gap-1.5">
                {cards.map((card) => (
                  <li key={card.id}>
                    <CardRow card={card} fresh={isNew(card, project)} onOpen={() => setOpenId(card.id)} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function CardRow({ card, fresh, onOpen }: { card: JobCard; fresh: boolean; onOpen(): void }) {
  const tone = scoreTone(card.score);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2.5 rounded-xl border border-border bg-bg px-3 py-2 text-left hover:border-accent"
    >
      <span
        className={cn("mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold", TONE[tone])}
      >
        {card.score}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{cardTitle(card)}</span>
          {fresh && (
            <span className="shrink-0 rounded bg-accent/15 px-1 text-[10.5px] font-semibold text-accent">
              New
            </span>
          )}
        </span>
        <span className="block truncate text-[12px] text-ink-3">
          {cardCompany(card)} · found {foundOn(card)}
          {card.summary ? ` · ${card.summary}` : ""}
        </span>
      </span>
      {card.warnings.length > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5 text-[11.5px] text-warning"
          title={card.warnings.map((w) => w.text).join("\n")}
        >
          <AlertTriangle size={12} /> {card.warnings.length}
        </span>
      )}
    </button>
  );
}

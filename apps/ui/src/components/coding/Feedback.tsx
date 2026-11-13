import {
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CodeXml,
  Hand,
  Loader2,
  MessageSquare,
  Pause,
  Search,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import type { CodingProject } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

import type { StatusTone } from "../../lib/coding";
import {
  cardProgress,
  recentLog,
  roundSummary,
  statusBanner,
  workingStrip,
  type BannerIcon,
} from "../../lib/codingFeedback";
import { activeElapsed, formatDuration, projectTotals, slowHint, totalsLine } from "../../lib/codingWork";
import { tint } from "./parts";

const TONE_COLOR: Record<StatusTone, string> = {
  busy: "var(--mrog-accent)",
  wait: "var(--mrog-warning)",
  ok: "var(--mrog-success)",
  bad: "var(--mrog-danger)",
  idle: "var(--mrog-ink-3)",
};

const ICON: Record<BannerIcon, LucideIcon> = {
  message: MessageSquare,
  working: Loader2,
  hand: Hand,
  code: CodeXml,
  search: Search,
  check: CheckCheck,
  pause: Pause,
  alert: TriangleAlert,
};

/** One plain line for the status, in a colour and with an icon, and what to do next. */
export function StatusBanner({ project, now }: { project: CodingProject; now: number }) {
  const banner = statusBanner(project);
  const slow = slowHint(project, now);
  const color = TONE_COLOR[banner.tone];
  const Icon = ICON[banner.icon];
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-xl border px-3 py-2"
      style={{ background: tint(color, 10), borderColor: tint(color, 40) }}
    >
      <Icon
        size={16}
        aria-hidden
        className={cn("mt-px shrink-0", banner.icon === "working" && "animate-spin")}
        style={{ color }}
      />
      <div className="min-w-0 text-[12.5px]">
        <p className="font-medium text-ink">{banner.line}</p>
        {banner.next && <p className="text-ink-2">{banner.next}</p>}
        {slow && (
          <p className="mt-0.5 flex items-start gap-1.5 text-warning">
            <Timer size={13} aria-hidden className="mt-px shrink-0" />
            {slow}
          </p>
        )}
        {project.error && <p className="mt-0.5 break-words text-danger select-text">{project.error}</p>}
        {project.note && project.note !== banner.line && <p className="mt-0.5 text-ink-3">{project.note}</p>}
      </div>
    </div>
  );
}

/** Planner, Developer and QA: the one at work is highlighted and says which card it is on. */
export function WorkingStrip({ project, now }: { project: CodingProject; now: number }) {
  const chips = workingStrip(project);
  const elapsed = activeElapsed(project, now);
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Who is working">
      {chips.map((chip) => (
        <li
          key={chip.role}
          aria-current={chip.active ? "true" : undefined}
          className={cn(
            "flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
            chip.active ? "border-accent bg-selected font-medium text-ink" : "border-border text-ink-3",
          )}
        >
          {chip.active ? (
            <Loader2 size={11} aria-hidden className="shrink-0 animate-spin text-accent" />
          ) : (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-ink-3 opacity-50" />
          )}
          <span>{chip.label}</span>
          {chip.active && (
            <span
              className="min-w-0 truncate font-mono text-[11px] text-ink-2"
              title={chip.work ?? undefined}
            >
              {chip.work ? `on ${chip.work}` : "working"}
              {elapsed !== null && ` · ${formatDuration(elapsed)}`}
            </span>
          )}
          {!chip.active && <span className="sr-only">, not working now</span>}
        </li>
      ))}
    </ul>
  );
}

/** "7 of 12 cards done" with a bar, and the round with how many cards failed in it. */
export function Progress({ project, now }: { project: CodingProject; now: number }) {
  const progress = cardProgress(project);
  const total = totalsLine(projectTotals(project, now));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="font-medium">{progress.text}</span>
        <span className="text-right text-ink-2">{roundSummary(project)}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Cards done"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        aria-valuetext={progress.text}
        className="h-1.5 overflow-hidden rounded-full bg-hover"
      >
        <div
          className="h-full rounded-full bg-success transition-[width] motion-reduce:transition-none"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      {total && <p className="text-xs text-ink-3">{total}</p>}
    </div>
  );
}

const time = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

/** The last 20 things that happened, newest first. Closed, it shows the latest one. */
export function ActivityLog({ project }: { project: CodingProject }) {
  const [open, setOpen] = useState(false);
  const lines = recentLog(project, 20);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label="Activity" className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-[12.5px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Chevron size={13} aria-hidden className="shrink-0 text-ink-3" />
        <span className="font-medium">Activity</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-ink-3">
            {lines[0] ? lines[0].text : "Nothing has happened yet."}
          </span>
        )}
      </button>
      {open && (
        <ul className="max-h-44 overflow-y-auto px-4 pb-2.5 text-[12px]">
          {lines.length === 0 && <li className="text-ink-3">Nothing has happened yet.</li>}
          {lines.map((line, index) => (
            <li key={`${line.at}-${index}`} className="flex gap-2 py-0.5">
              <time dateTime={line.at} className="shrink-0 font-mono text-[11px] text-ink-3">
                {time(line.at)}
              </time>
              <span className="min-w-0 break-words select-text">{line.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

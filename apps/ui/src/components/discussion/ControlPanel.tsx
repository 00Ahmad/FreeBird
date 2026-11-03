import { Plus } from "lucide-react";

import { DISCUSSION_GOALS, type Bot, type Discussion } from "@mrog/shared";
import { BotAvatar, cn } from "@mrog/ui-kit";

import type { SeatState } from "./RoundTable";

interface Phase {
  label: string;
  /** 0–1; null while it's under way with no measurable progress. */
  progress: number | null;
}

/** Roles, then each round, then the report, each with how far along it is. */
export function phases(discussion: Discussion | null | undefined, teamSize: number): Phase[] {
  if (!discussion) return [];
  const finished = discussion.status === "done";
  const out: Phase[] = [{ label: "Choosing roles", progress: discussion.round > 0 || finished ? 1 : null }];
  for (let round = 1; round <= discussion.rounds; round += 1) {
    const progress =
      round < discussion.round || discussion.status === "summarizing" || finished
        ? 1
        : round === discussion.round
          ? (discussion.spoken?.length ?? 0) / Math.max(teamSize, 1)
          : 0;
    out.push({ label: `Round ${round}`, progress });
  }
  out.push({
    label: "Final report",
    progress: finished ? 1 : discussion.status === "summarizing" ? null : 0,
  });
  return out;
}

export function PhaseBar({ phase, compact }: { phase: Phase; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1", compact && "min-w-16 flex-1")}>
      <div className="flex items-center justify-between text-[12px]">
        <span className={cn(phase.progress === 0 ? "text-ink-3" : "text-ink")}>{phase.label}</span>
        {!compact && phase.progress !== null && phase.progress > 0 && phase.progress < 1 && (
          <span className="text-[11px] text-ink-3">{Math.round(phase.progress * 100)}%</span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-hover">
        <div
          className={cn(
            "h-full rounded-full bg-gradient-to-r from-accent to-success transition-[width] duration-500",
            phase.progress === null && "w-1/3 animate-pulse",
          )}
          style={phase.progress === null ? undefined : { width: `${phase.progress * 100}%` }}
        />
      </div>
    </div>
  );
}

const STATE_TEXT: Record<SeatState, string> = {
  speaking: "Speaking",
  spoke: "Done this round",
  waiting: "Waiting",
  idle: "Idle",
};

interface ControlPanelProps {
  discussion: Discussion | null | undefined;
  members: Bot[];
  states: Map<string, SeatState>;
  stats: Map<string, { turns: number; lookups: number }>;
  canStart: boolean;
  onNew(): void;
}

/** The left column: what's being discussed, how far along it is, and who is at the table. */
export function ControlPanel({ discussion, members, states, stats, canStart, onNew }: ControlPanelProps) {
  const running = discussion?.status === "running" || discussion?.status === "summarizing";
  return (
    <aside className="stage-panel hidden min-h-0 w-56 shrink-0 flex-col overflow-y-auto xl:flex">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-[15px] font-semibold">Discussion control</h2>
      </div>
      <div className="flex flex-col gap-5 p-4">
        {discussion ? (
          <>
            <section className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium tracking-wider text-ink-3 uppercase">Goal</span>
              <span className="w-fit rounded-full border border-accent/40 bg-selected px-2.5 py-0.5 text-[12px] text-accent">
                {DISCUSSION_GOALS[discussion.goal].label}
              </span>
            </section>
            <section className="flex flex-col gap-3">
              <span className="text-[11px] font-medium tracking-wider text-ink-3 uppercase">Progress</span>
              {phases(discussion, members.length).map((phase) => (
                <PhaseBar key={phase.label} phase={phase} />
              ))}
            </section>
          </>
        ) : (
          <p className="text-[13px] text-ink-2">
            Give the bots a topic: they take turns, back their claims with sources, challenge each other, and
            a moderator writes the final report.
          </p>
        )}

        <section className="flex flex-col gap-2">
          <span className="text-[11px] font-medium tracking-wider text-ink-3 uppercase">
            At the table · {members.length}
          </span>
          {members.map((bot) => {
            const state = states.get(bot.id) ?? "idle";
            const stat = stats.get(bot.id);
            return (
              <div key={bot.id} className="flex items-center gap-2.5">
                <div className="relative">
                  <BotAvatar avatar={bot.avatar} size={28} />
                  <span
                    className={cn(
                      "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-[var(--mrog-surface)]",
                      state === "speaking" ? "bg-accent" : state === "spoke" ? "bg-success" : "bg-ink-3",
                    )}
                  />
                </div>
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-[13px] font-medium">{bot.name}</div>
                  <div className="truncate text-[11px] text-ink-3">
                    {running ? STATE_TEXT[state] : (discussion?.roles[bot.id] ?? bot.label ?? "")}
                    {stat?.lookups ? ` · ${stat.lookups} lookups` : ""}
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </div>
      <div className="mt-auto border-t border-border p-3">
        <button
          type="button"
          className="stage-button w-full justify-center"
          disabled={!canStart}
          onClick={onNew}
        >
          <Plus size={14} /> New discussion
        </button>
      </div>
    </aside>
  );
}

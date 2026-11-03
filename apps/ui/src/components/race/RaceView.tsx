import { Flag, Gavel, Loader2, Plus, Scale, Search, Square, Trophy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  messageText,
  parseModelRef,
  type Bot,
  type Message,
  type Race,
  type Racer,
  type Thread,
} from "@mrog/shared";
import { BotAvatar, cn } from "@mrog/ui-kit";

import { useJudgeNow, useRace, useStopRace } from "../../hooks/race";
import { useRuntime } from "../../hooks/runtime";
import { useMessages } from "../../hooks/threads";
import { liveActivity } from "../../lib/discussion";
import { useUi } from "../../state";
import { Markdown } from "../chat/Markdown";

/** "Strategy: …" from the first line of a racer's answer, and the answer without it. */
export function splitStrategy(text: string): { strategy: string | null; body: string } {
  const match = /^\s*\**strategy\**\s*[:：]\s*(.+)$/im.exec(text);
  if (!match || text.slice(0, match.index).trim()) return { strategy: null, body: text };
  return {
    strategy: match[1]!.replaceAll("**", "").trim(),
    body: text.slice(match.index + match[0].length).trim(),
  };
}

const elapsed = (from: string | null, to: string | null, now: number) => {
  if (!from) return "";
  const seconds = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/** A clock that ticks once a second while something is running. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** Keeps a scroll box at the bottom while its content grows, unless the user scrolled up. */
function useFollow() {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // A callback ref: the content may only appear later (the judge's report once judging starts).
  const content = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (box.current && pinned.current) box.current.scrollTop = box.current.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  };
  return { box, content, onScroll };
}

const modelName = (bot: Bot, shared: string | null | undefined) => {
  const ref = bot.model ?? shared;
  return ref ? parseModelRef(ref).model : "no model";
};

/** A race, live: one lane per racer, then the judge's scores and compiled result. */
export function RaceView({ thread, bots }: { thread: Thread; bots: Map<string, Bot> }) {
  const { data: race } = useRace(thread.id, true);
  const { data: messages } = useMessages(thread.id);
  const { data: runtime } = useRuntime();
  const judgeNow = useJudgeNow(thread.id);
  const stop = useStopRace(thread.id);
  const setOverlay = useUi((state) => state.setOverlay);
  const now = useNow(race?.status === "racing" || race?.status === "judging");
  const shared = runtime?.settings.sharedModel;

  if (!race) return <div className="mrog-stage flex-1" />;
  const judge = bots.get(race.judgeId);
  const done = race.racers.filter((racer) => racer.status !== "waiting" && racer.status !== "running").length;
  const report =
    (race.reportId && messages?.find((message) => message.id === race.reportId)) ||
    messages?.findLast((message) => message.botId === race.judgeId);
  const ended = race.status === "done" || race.status === "stopped" || race.status === "error";
  const status =
    race.status === "racing"
      ? `Racing · ${done} of ${race.racers.length} finished`
      : race.status === "judging"
        ? "The judge is scoring…"
        : race.status === "done"
          ? "Finished"
          : race.status === "stopped"
            ? "Stopped"
            : `Stopped: ${race.error ?? "something went wrong"}`;

  return (
    <div className="mrog-stage flex min-h-0 flex-1 flex-col gap-3 p-3">
      <header className="stage-panel flex items-center gap-4 px-5 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-selected text-accent">
          <Flag size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px] text-ink-3">
            <span
              className={cn(
                "size-2 rounded-full",
                ended ? "bg-ink-3" : "animate-pulse bg-success",
                race.status === "error" && "bg-danger",
              )}
            />
            {status}
          </div>
          <p className="line-clamp-2 text-[15px] leading-snug font-semibold" title={race.task}>
            {race.task}
          </p>
        </div>
        {race.status === "racing" && (
          <button
            type="button"
            className="stage-button"
            data-tone="primary"
            disabled={judgeNow.isPending || done === 0}
            onClick={() => judgeNow.mutate()}
            title={
              done === 0
                ? "Wait until at least one racer has finished"
                : "Stop the racers still going and judge what's in"
            }
          >
            <Gavel size={14} /> Judge now
          </button>
        )}
        {!ended && (
          <button type="button" className="stage-button" data-tone="danger" onClick={() => stop.mutate()}>
            <Square size={13} /> Stop
          </button>
        )}
        {ended && (
          <button
            type="button"
            className="stage-button"
            data-tone="primary"
            onClick={() => setOverlay("newRace")}
          >
            <Plus size={14} /> New race
          </button>
        )}
      </header>

      <div
        className={cn("grid min-h-0 gap-3", race.status === "racing" ? "flex-1" : "h-[42%] shrink-0")}
        style={{ gridTemplateColumns: `repeat(${race.racers.length}, minmax(0, 1fr))` }}
      >
        {race.racers.map((racer) => {
          const bot = bots.get(racer.botId);
          return bot ? (
            <Lane
              key={racer.botId}
              racer={racer}
              bot={bot}
              model={modelName(bot, shared)}
              winner={race.winnerId === racer.botId}
              now={now}
            />
          ) : null;
        })}
      </div>

      <JudgePanel
        race={race}
        judge={judge}
        model={judge ? modelName(judge, shared) : ""}
        report={report || undefined}
        winner={race.winnerId ? bots.get(race.winnerId) : undefined}
        done={done}
      />
    </div>
  );
}

const RACER_STATUS: Record<Racer["status"], string> = {
  waiting: "Waiting",
  running: "Racing",
  done: "Finished",
  stopped: "Stopped",
  error: "Failed",
};

function Lane({
  racer,
  bot,
  model,
  winner,
  now,
}: {
  racer: Racer;
  bot: Bot;
  model: string;
  winner: boolean;
  now: number;
}) {
  const { data: messages } = useMessages(bot.threadId);
  const queued = useUi((state) => state.activity[bot.threadId]?.activity === "queued");
  const answer = messages?.findLast((message) => message.role === "bot");
  const { strategy, body } = splitStrategy(answer ? messageText(answer) : "");
  const lookups = answer?.parts.filter((part) => part.type === "tool").length ?? 0;
  const words = body.split(/\s+/).filter(Boolean).length;
  const running = racer.status === "running";
  const { box, content, onScroll } = useFollow();

  return (
    <section
      className={cn(
        "stage-panel flex min-h-0 min-w-0 flex-col",
        running && !queued && "border-accent",
        winner && "border-warning shadow-[0_0_0_2px_color-mix(in_srgb,var(--mrog-warning)_35%,transparent)]",
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-border px-3 py-2.5">
        <BotAvatar
          avatar={bot.avatar}
          size={28}
          className={cn(running && !queued && "mrog-breathe rounded-full")}
        />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1.5 truncate text-[13.5px] font-semibold">
            {bot.name}
            {winner && <Trophy size={13} className="shrink-0 text-warning" />}
          </div>
          <div className="truncate text-[11px] text-ink-3" title={model}>
            {model}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end leading-tight">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium",
              racer.status === "done" && "bg-success/15 text-success",
              racer.status === "running" && "bg-selected text-accent",
              racer.status === "error" && "bg-danger/15 text-danger",
              (racer.status === "waiting" || racer.status === "stopped") && "bg-hover text-ink-3",
            )}
          >
            {running && queued ? "In line" : RACER_STATUS[racer.status]}
          </span>
          <span className="mt-0.5 text-[11px] text-ink-3 tabular-nums">
            {elapsed(racer.startedAt, racer.finishedAt, now)}
          </span>
        </div>
      </div>

      {strategy && (
        <div className="border-b border-border bg-selected/50 px-3 py-1.5 text-[12px] leading-snug">
          <span className="font-medium text-accent">Strategy · </span>
          {strategy}
        </div>
      )}

      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <div ref={content} className="text-[13px] leading-relaxed">
          {body ? (
            <Markdown text={body} />
          ) : (
            <p className="py-6 text-center text-[12.5px] text-ink-3">
              {running && queued
                ? "Waiting for the model: another racer is using it."
                : running
                  ? "Working out a strategy…"
                  : racer.status === "waiting"
                    ? "About to start."
                    : "No answer."}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-ink-3">
        {running && !queued && (
          <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-success">
            <Loader2 size={11} className="shrink-0 animate-spin" />
            {liveActivity(answer)}
          </span>
        )}
        {!running && <span className="flex-1" />}
        <span className="flex shrink-0 items-center gap-1">
          <Search size={11} /> {lookups}
        </span>
        <span className="shrink-0">{words} words</span>
      </div>
    </section>
  );
}

function JudgePanel({
  race,
  judge,
  model,
  report,
  winner,
  done,
}: {
  race: Race;
  judge: Bot | undefined;
  model: string;
  report: Message | undefined;
  winner: Bot | undefined;
  done: number;
}) {
  const { box, content, onScroll } = useFollow();
  const text = report ? messageText(report) : "";
  const judging = race.status === "judging";
  const waiting = race.status === "racing";

  return (
    <section
      className={cn(
        "stage-panel flex min-h-0 flex-col",
        waiting ? "shrink-0" : "flex-1",
        judging && "border-accent",
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-full bg-hover text-ink-2",
            judging && "mrog-breathe bg-selected text-accent",
          )}
        >
          <Scale size={14} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[13.5px] font-semibold">{judge?.name ?? "Judge"}</div>
          <div className="truncate text-[11px] text-ink-3">{model}</div>
        </div>
        {winner && (
          <span className="flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-[12px] font-medium text-warning">
            <Trophy size={13} /> {winner.name} wins
          </span>
        )}
      </div>
      {waiting ? (
        <p className="px-4 py-3 text-[12.5px] text-ink-3">
          The judge waits for the racers ({done} of {race.racers.length} finished), then picks criteria for
          this task, scores everyone and combines the best parts into one result.
        </p>
      ) : (
        <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <div ref={content} className="text-[13.5px] leading-relaxed">
            {text ? (
              <Markdown text={text} />
            ) : (
              <p className="py-4 text-center text-[12.5px] text-ink-3">
                {judging ? "Reading every racer's work…" : "No report."}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

import { FileText, MessageSquarePlus, Pause, Play, Plus, SkipForward, Square } from "lucide-react";
import { useMemo, useRef } from "react";

import type { Bot, Discussion, Message, Thread } from "@mrog/shared";

import { useDiscussionControl, useStopDiscussion } from "../../hooks/discussion";
import { useSendMessage } from "../../hooks/threads";
import { botStats, discussionMessages, discussionSources, liveActivity } from "../../lib/discussion";
import { ControlPanel, PhaseBar, phases } from "./ControlPanel";
import { IdeaNetwork, RoundTable, type Seat, type SeatState } from "./RoundTable";
import { Timeline } from "./Timeline";

interface DiscussionViewProps {
  thread: Thread;
  members: Bot[];
  bots: Map<string, Bot>;
  messages: Message[];
  discussion: Discussion | null | undefined;
  noModel: boolean;
  onNew(): void;
}

/** A group discussion as a round table: controls on the left, the table in the middle, the debate on the right. */
export function DiscussionView({
  thread,
  members,
  bots,
  messages,
  discussion,
  noModel,
  onNew,
}: DiscussionViewProps) {
  const control = useDiscussionControl(thread.id);
  const stop = useStopDiscussion(thread.id);
  const send = useSendMessage(thread.id);
  const input = useRef<HTMLTextAreaElement>(null);

  const running = discussion?.status === "running";
  const active = running || discussion?.status === "summarizing";
  const paused = Boolean(discussion?.paused) && running;
  const roles = discussion?.roles ?? {};

  const own = useMemo(() => discussionMessages(messages, discussion), [messages, discussion]);
  const stats = useMemo(() => botStats(own), [own]);
  const names = useMemo(() => new Map([...bots.values()].map((bot) => [bot.id, bot.name])), [bots]);
  const sources = useMemo(() => discussionSources(own, names), [own, names]);

  const speaker = discussion?.speakerId && running ? bots.get(discussion.speakerId) : undefined;
  const speakerMessage = speaker
    ? own.findLast((message) => message.botId === speaker.id && message.status === "streaming")
    : undefined;

  const states = new Map<string, SeatState>(
    members.map((bot) => [
      bot.id,
      !active
        ? "idle"
        : bot.id === discussion?.speakerId
          ? "speaking"
          : discussion?.spoken?.includes(bot.id)
            ? "spoke"
            : "waiting",
    ]),
  );
  const seats: Seat[] = members.map((bot) => ({
    bot,
    role: roles[bot.id] ?? bot.label,
    state: states.get(bot.id)!,
    activity:
      bot.id === speaker?.id ? (paused ? "Paused after this turn" : liveActivity(speakerMessage)) : undefined,
  }));

  const status = !discussion
    ? "No discussion yet"
    : discussion.status === "summarizing"
      ? "The moderator is writing the final report…"
      : discussion.status === "done"
        ? discussion.error
          ? `Ended early (${discussion.error}) · the final report is in the debate`
          : "Finished · the final report is in the debate"
        : discussion.status === "stopped"
          ? "Stopped"
          : discussion.status === "error"
            ? (discussion.error ?? "Something went wrong")
            : discussion.round === 0
              ? "Choosing roles…"
              : paused
                ? `Round ${discussion.round} of ${discussion.rounds} · paused`
                : `Round ${discussion.round} of ${discussion.rounds}${speaker ? ` · ${speaker.name} is speaking` : ""}`;

  return (
    <div className="mrog-stage flex min-h-0 flex-1 gap-3 p-3">
      <ControlPanel
        discussion={discussion}
        members={members}
        states={states}
        stats={stats}
        canStart={!active && !noModel}
        onNew={onNew}
      />

      <section className="stage-panel flex min-w-0 flex-1 flex-col">
        <div className="flex items-start gap-3 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold tracking-tight">Round table</h2>
            <p className="truncate text-[12.5px] text-ink-3">
              {members.map((bot) => bot.name).join(", ")} · each claim needs a source or reasoning you can
              check
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px]">
            <span
              className={`size-2 rounded-full ${active && !paused ? "animate-pulse bg-success" : paused ? "bg-warning" : "bg-ink-3"}`}
            />
            {active ? (paused ? "Paused" : "Live") : "Idle"} · {members.length} bots
          </span>
        </div>

        {discussion && (
          <div className="flex gap-3 px-5 pt-3 xl:hidden">
            {phases(discussion, members.length).map((phase) => (
              <PhaseBar key={phase.label} phase={phase} compact />
            ))}
          </div>
        )}

        <div className="flex min-h-0 flex-1 p-2">
          <RoundTable
            seats={seats}
            paused={paused || !active}
            center={
              <>
                <span className="text-[10px] font-medium tracking-[0.18em] text-ink-3 uppercase">
                  Shared topic
                </span>
                <p className="mt-1 line-clamp-3 text-[clamp(12px,1.5vw,16px)] leading-snug font-medium">
                  {discussion?.topic ?? "Start a discussion to give the table a topic"}
                </p>
                <IdeaNetwork className="my-1 w-[62%]" />
                <p className="line-clamp-2 text-[12px] font-medium text-accent">{status}</p>
              </>
            }
          />
        </div>

        <div className="flex flex-wrap items-center justify-center gap-1.5 border-t border-border px-3 py-3">
          {active ? (
            <>
              <button
                type="button"
                className="stage-button"
                onClick={() => input.current?.focus()}
                title="Write to the discussion; the next speaker answers you"
              >
                <MessageSquarePlus size={14} /> Message
              </button>
              <button
                type="button"
                className="stage-button"
                disabled={!running || control.isPending}
                onClick={() => control.mutate(paused ? "resume" : "pause")}
                title={paused ? "Carry on with the discussion" : "Hold before the next turn"}
              >
                {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                className="stage-button"
                disabled={!running || control.isPending}
                onClick={() => control.mutate("step")}
                title="Run one turn, then pause"
              >
                <SkipForward size={14} /> {paused ? "Next turn" : "Step"}
              </button>
              <button
                type="button"
                className="stage-button"
                data-tone="primary"
                disabled={!running || control.isPending}
                onClick={() => control.mutate("finish")}
                title="Finish after the current turn and write the report"
              >
                <FileText size={14} /> Final report
              </button>
              <button type="button" className="stage-button" data-tone="danger" onClick={() => stop.mutate()}>
                <Square size={13} /> Stop
              </button>
            </>
          ) : (
            <button
              type="button"
              className="stage-button"
              data-tone="primary"
              disabled={noModel}
              onClick={onNew}
            >
              <Plus size={14} /> {discussion ? "Start a new discussion" : "Start a discussion"}
            </button>
          )}
        </div>
        {control.error && (
          <p className="px-4 pb-2 text-center text-xs text-danger">{control.error.message}</p>
        )}
      </section>

      <Timeline
        ref={input}
        messages={own}
        bots={bots}
        roles={roles}
        sources={sources}
        disabled={noModel}
        onSend={(text) => send.mutateAsync({ text })}
      />
    </div>
  );
}

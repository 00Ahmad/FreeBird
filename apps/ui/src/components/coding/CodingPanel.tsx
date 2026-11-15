import { useQueryClient } from "@tanstack/react-query";
import { CodeXml, Loader2, MessageSquarePlus, Play, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { MAX_ROUNDS_LIMIT, type Bot, type CodingProject, type Message } from "@mrog/shared";
import { Button, cn, IconButton } from "@mrog/ui-kit";

import {
  useApproveCoding,
  useCodingProject,
  useResumeCoding,
  useReviseCoding,
  useStopCoding,
  useUpdateCodingSettings,
} from "../../hooks/coding";
import {
  canApprove,
  canResume,
  canRevise,
  canStop,
  CODING_TABS,
  DEFAULT_PANEL_WIDTH,
  fitPanel,
  MIN_CHAT_WIDTH,
  MIN_PANEL_WIDTH,
  nextTab,
  parseRounds,
  resumePlan,
  roundText,
  sidebarWidth,
  statusLabel,
  statusTone,
  TAB_LABEL,
  type CodingTab,
  type StatusTone,
} from "../../lib/coding";
import { buildChecklist } from "../../lib/codingChecklist";
import { roleWaiting } from "../../lib/codingWork";
import { useCardActivity } from "../../codingActivity";
import { messagesKey, useThreads } from "../../hooks/threads";
import { useNow } from "../../hooks/useNow";
import { useUi } from "../../state";
import { CodingBoard } from "./CodingBoard";
import { CodingChecklist } from "./CodingChecklist";
import { CodingDiagram } from "./CodingDiagram";
import { ActivityLog, Progress, StatusBanner, WorkingStrip } from "./Feedback";
import { PlanTools } from "./PlanTools";
import { Switch } from "./Switch";

const WIDTH_KEY = "mrog.codingPanelWidth";
const readWidth = () => {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return stored > 0 ? stored : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
};

const TONE: Record<StatusTone, string> = {
  busy: "bg-selected text-accent",
  wait: "bg-hover text-warning",
  ok: "bg-hover text-success",
  bad: "bg-hover text-danger",
  idle: "bg-hover text-ink-2",
};

/**
 * The Coding Bot's right-hand panel: where the project stands (status, round, approval), and the plan as a diagram,
 * a board and a checklist. What you type to the bot stays in the chat beside it.
 */
export function CodingPanel({ bot }: { bot: Bot }) {
  const { data: project, error } = useCodingProject(bot.id, true);
  const tab = useUi((state) => state.codingTab);
  const setTab = useUi((state) => state.setCodingTab);
  const toggleCoding = useUi((state) => state.toggleCoding);
  // The file or connector picked in the diagram, the board or the checklist; they all show the same one.
  const [picked, setPick] = useState<string | null>(null);
  const activity = useCardActivity((store) => store.byBot[bot.id]);
  const acknowledge = useCardActivity((store) => store.acknowledge);
  const unseen = Object.keys(activity?.unseenQa ?? {}).length;
  // Looking at a card counts as having seen its new QA comment.
  const setPicked = (ref: string | null) => {
    setPick(ref);
    const card = project?.cards.find((candidate) => candidate.ref === ref);
    if (card) acknowledge(bot.id, card.id);
  };
  const compact = useUi((state) => state.compactSidebar);
  const sidebar = sidebarWidth(compact);
  // The width the user chose; what is shown is that, fitted to the window and the sidebar beside it.
  const [chosen, setChosen] = useState(readWidth);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const fit = fitPanel(chosen, viewport, sidebar);
  const width = fit.width;
  const [dragging, setDragging] = useState(false);
  // One clock for the whole panel: it ticks only while a turn is running, and the cards read the time from it.
  const now = useNow(Boolean(project?.active?.since));
  const checklist = useMemo(() => (project ? buildChecklist(project) : null), [project]);

  // The window may shrink below the width chosen earlier, or the sidebar widen (Ctrl+B).
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // While the edge is dragged, the pointer would select the chat's text as it passes over it.
  useEffect(() => {
    if (!dragging) return;
    const before = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = before;
    };
  }, [dragging]);

  const resizeTo = (next: number, remember: boolean) => {
    const clamped = fitPanel(next, window.innerWidth, sidebar).width;
    setChosen(clamped);
    if (!remember) return;
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {
      // per-viewer convenience only
    }
  };
  const onDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1) return;
    resizeTo(window.innerWidth - event.clientX, false);
  };
  const onDragKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // The panel is on the right, so moving the edge left makes it wider.
    resizeTo(width + (event.key === "ArrowLeft" ? 24 : -24), true);
  };

  const showOnBoard = (ref: string) => {
    setPicked(ref);
    setTab("board");
  };

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-l border-border bg-surface",
        // Too narrow a window for the panel beside the chat: it lies over the chat, opened and closed with the
        // Coding panel button, instead of squeezing the chat away.
        fit.overlay ? "absolute inset-y-0 right-0 z-30 shadow-pop" : "relative",
      )}
      style={{ width }}
      aria-label="Coding"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the Coding panel"
        aria-valuenow={width}
        aria-valuemin={Math.min(MIN_PANEL_WIDTH, width)}
        aria-valuemax={Math.max(width, viewport - sidebar - (fit.overlay ? 0 : MIN_CHAT_WIDTH))}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={onDrag}
        onPointerUp={() => {
          setDragging(false);
          resizeTo(width, true);
        }}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={onDragKey}
        className="absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize outline-none hover:bg-selected focus-visible:bg-selected"
      />

      {project ? (
        <>
          <Header bot={bot} project={project} now={now} onClose={toggleCoding} />
          <Tabs
            tab={tab}
            onTab={setTab}
            progress={project.cards.length > 0 && checklist ? `${checklist.done}/${checklist.total}` : null}
            unseen={unseen}
          />
          <div
            role="tabpanel"
            id={`coding-panel-${tab}`}
            aria-labelledby={`coding-tab-${tab}`}
            className="min-h-0 flex-1"
          >
            {tab === "diagram" && (
              <CodingDiagram
                project={project}
                now={now}
                selectedRef={picked}
                onSelect={setPicked}
                onShowOnBoard={showOnBoard}
              />
            )}
            {tab === "board" && (
              <CodingBoard
                project={project}
                now={now}
                selectedRef={picked}
                onSelect={setPicked}
                activity={activity}
                onAcknowledge={(cardId) => acknowledge(bot.id, cardId)}
              />
            )}
            {tab === "checklist" && <CodingChecklist project={project} onPick={showOnBoard} />}
          </div>
          <ActivityLog project={project} />
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <CodeXml size={15} className="text-ink-2" />
            <h2 className="flex-1 text-[14px] font-semibold">Coding</h2>
            <IconButton label="Close" onClick={toggleCoding}>
              <X size={14} />
            </IconButton>
          </div>
          <p className="p-6 text-center text-[13px] text-ink-3" role={error ? "alert" : "status"}>
            {error ? `Couldn't load the project: ${error.message}` : "Loading the project…"}
          </p>
        </>
      )}
    </aside>
  );
}

function Tabs({
  tab,
  onTab,
  progress,
  unseen,
}: {
  tab: CodingTab;
  onTab(tab: CodingTab): void;
  progress: string | null;
  /** Cards with a new QA comment nobody has looked at. */
  unseen: number;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextTab(tab, event.key);
    if (!next) return;
    event.preventDefault();
    onTab(next);
    document.getElementById(`coding-tab-${next}`)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Project views"
      onKeyDown={onKeyDown}
      className="flex gap-1 border-b border-border px-3 py-1.5"
    >
      {CODING_TABS.map((value) => (
        <button
          key={value}
          id={`coding-tab-${value}`}
          type="button"
          role="tab"
          aria-selected={tab === value}
          aria-controls={`coding-panel-${value}`}
          tabIndex={tab === value ? 0 : -1}
          onClick={() => onTab(value)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent",
            tab === value ? "bg-selected font-medium text-ink" : "text-ink-3 hover:text-ink",
          )}
        >
          {TAB_LABEL[value]}
          {value === "checklist" && progress && <span className="text-[11px] text-ink-3">{progress}</span>}
          {value === "board" && unseen > 0 && (
            <span className="rounded-full bg-warning px-1.5 text-[10.5px] font-semibold text-accent-ink">
              {unseen} new
              <span className="sr-only"> QA {unseen === 1 ? "comment" : "comments"}</span>
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function Header({
  bot,
  project,
  now,
  onClose,
}: {
  bot: Bot;
  project: CodingProject;
  now: number;
  onClose(): void;
}) {
  const stop = useStopCoding(bot.id);
  const resume = useResumeCoding(bot.id);
  const settings = useUpdateCodingSettings(bot.id);
  const { status } = project;
  const failure = stop.error ?? resume.error ?? settings.error;
  // A role that waits for the user's approval isn't slow: the banner says what it waits for instead.
  const activity = useUi((state) => state.activity);
  const { data: threads } = useThreads();
  const client = useQueryClient();
  const teamChats = useMemo(
    () =>
      new Set([
        bot.threadId,
        ...(threads ?? [])
          .filter((thread) => thread.pair && thread.memberIds.includes(bot.id))
          .map((thread) => thread.id),
      ]),
    [threads, bot.id, bot.threadId],
  );
  // The Coding Bot's own chat is open beside the panel, so its messages (with the roles' approval cards) are cached.
  const waiting = roleWaiting(
    project,
    activity,
    teamChats,
    client.getQueryData<Message[]>(messagesKey(bot.threadId)) ?? [],
  );

  return (
    <div className="flex max-h-[55%] shrink-0 flex-col gap-2.5 overflow-y-auto border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <CodeXml size={15} className="shrink-0 text-ink-2" />
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold">Coding</h2>
        <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-medium", TONE[statusTone(status)])}>
          {statusTone(status) === "busy" && (
            <Loader2 size={11} className="mr-1 inline animate-spin align-[-1px]" aria-hidden />
          )}
          {statusLabel(status)}
        </span>
        {canStop(status) && (
          <Button size="sm" variant="subtle" onClick={() => stop.mutate()} disabled={stop.isPending}>
            <Square size={12} /> Stop
          </Button>
        )}
        {canResume(status) && status !== "needs_you" && (
          <Button size="sm" variant="subtle" onClick={() => resume.mutate()} disabled={resume.isPending}>
            <Play size={12} /> Resume
          </Button>
        )}
        <IconButton label="Close the Coding panel" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>

      <StatusBanner project={project} now={now} waiting={waiting} />
      <WorkingStrip project={project} now={now} />
      <Progress project={project} now={now} />
      {failure && (
        <p role="alert" className="text-xs text-danger">
          {failure.message}
        </p>
      )}

      {status === "needs_you" ? (
        <RaiseLimit bot={bot} project={project} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-ink-2">
          <RoundLimit project={project} settings={settings} />
          <AutoApprove project={project} settings={settings} />
        </div>
      )}

      <PlanTools bot={bot} project={project} />

      {canApprove(status) && <ApprovalBar bot={bot} status={status} />}
    </div>
  );
}

type Settings = ReturnType<typeof useUpdateCodingSettings>;

/** The round limit, changeable any time: it is saved when you leave the field or press Enter. */
function RoundLimit({ project, settings }: { project: CodingProject; settings: Settings }) {
  const [draft, setDraft] = useState(String(project.maxRounds));
  // Follow the project when the limit changes from elsewhere.
  const [seen, setSeen] = useState(project.maxRounds);
  if (seen !== project.maxRounds) {
    setSeen(project.maxRounds);
    setDraft(String(project.maxRounds));
  }
  const valid = parseRounds(draft) !== null;

  const save = () => {
    const value = parseRounds(draft);
    if (value === null) return setDraft(String(project.maxRounds));
    if (value !== project.maxRounds) settings.mutate({ maxRounds: value });
  };

  return (
    <label className="flex items-center gap-1.5 text-[12.5px]">
      QA round limit
      <input
        type="number"
        min={1}
        max={MAX_ROUNDS_LIMIT}
        value={draft}
        aria-label="QA round limit"
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
        className={cn(
          "h-6 w-14 rounded-md border bg-bg px-1.5 text-xs text-ink outline-none focus:border-accent",
          valid ? "border-border" : "border-danger",
        )}
      />
    </label>
  );
}

function AutoApprove({ project, settings }: { project: CodingProject; settings: Settings }) {
  return (
    <label className="flex items-center gap-2">
      <Switch
        on={project.autoApprove}
        onChange={(autoApprove) => settings.mutate({ autoApprove })}
        label="Auto-approve the plan"
        disabled={settings.isPending}
      />
      Auto-approve
    </label>
  );
}

/** The plan is waiting: approve it, or send the Planner what to change. */
function ApprovalBar({ bot, status }: { bot: Bot; status: CodingProject["status"] }) {
  const approve = useApproveCoding(bot.id);
  const revise = useReviseCoding(bot.id);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");

  const send = () => {
    if (!note.trim() || revise.isPending) return;
    revise.mutate(
      { note: note.trim() },
      {
        onSuccess: () => {
          setNote("");
          setAsking(false);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-bg p-2.5">
      <p className="text-[12.5px] text-ink-2">
        The plan is ready. Look it over in the diagram, board and checklist, then approve it to start writing
        code.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => approve.mutate()} disabled={approve.isPending}>
          {approve.isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Approve
        </Button>
        {canRevise(status) && (
          <Button
            size="sm"
            variant="subtle"
            onClick={() => setAsking((open) => !open)}
            aria-expanded={asking}
          >
            <MessageSquarePlus size={12} /> Ask for changes
          </Button>
        )}
      </div>
      {asking && (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                send();
              }
            }}
            rows={3}
            aria-label="What the Planner should change"
            placeholder="For example: split the API into two files and add a settings page."
            className="resize-none rounded-lg border border-border bg-surface px-2.5 py-2 text-[13px] outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={send} disabled={!note.trim() || revise.isPending}>
              {revise.isPending && <Loader2 size={12} className="animate-spin" />} Send to the Planner
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {(approve.error ?? revise.error) && (
        <p role="alert" className="text-xs text-danger">
          {(approve.error ?? revise.error)?.message}
        </p>
      )}
    </div>
  );
}

/** At the round limit: raise it and carry on. */
function RaiseLimit({ bot, project }: { bot: Bot; project: CodingProject }) {
  const settings = useUpdateCodingSettings(bot.id);
  const resume = useResumeCoding(bot.id);
  const [draft, setDraft] = useState(() => String(Math.min(MAX_ROUNDS_LIMIT, project.maxRounds + 3)));
  const [problem, setProblem] = useState<string | null>(null);
  const busy = settings.isPending || resume.isPending;
  // Set at once, before the pending flags re-render: a second Enter in the same moment must not send it again.
  const going = useRef(false);

  const go = async () => {
    if (going.current || busy) return;
    const plan = resumePlan(project, draft);
    setProblem(plan.problem);
    if (plan.problem) return;
    going.current = true;
    try {
      if (plan.raiseTo !== null) await settings.mutateAsync({ maxRounds: plan.raiseTo });
      await resume.mutateAsync();
    } catch {
      // shown below from the mutation that failed
    } finally {
      going.current = false;
    }
  };

  const failure = settings.error ?? resume.error;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-bg p-2.5">
      <p className="text-[12.5px] font-medium text-warning">{roundText(project)}</p>
      <p className="text-[12.5px] text-ink-2">
        {project.round > 0
          ? `It used ${project.round} QA ${project.round === 1 ? "round" : "rounds"} and some cards still fail. `
          : ""}
        Allow more rounds to keep going, or tell the bot in the chat what to change.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[12.5px]">
          Allow
          <input
            type="number"
            min={1}
            max={MAX_ROUNDS_LIMIT}
            value={draft}
            aria-label="New QA round limit"
            aria-invalid={problem !== null}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
            }}
            onKeyDown={(event) => event.key === "Enter" && void go()}
            className="h-7 w-16 rounded-md border border-border bg-surface px-1.5 text-[13px] outline-none focus:border-accent"
          />
          rounds
        </label>
        <Button size="sm" variant="primary" onClick={() => void go()} disabled={busy}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Raise the limit and
          resume
        </Button>
      </div>
      {(problem ?? failure) && (
        <p role="alert" className="text-xs text-danger">
          {problem ?? failure?.message}
        </p>
      )}
      <div className="text-[12.5px] text-ink-2">
        <AutoApprove project={project} settings={settings} />
      </div>
    </div>
  );
}

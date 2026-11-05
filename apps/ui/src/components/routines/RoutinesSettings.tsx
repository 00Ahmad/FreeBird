import { CheckCircle2, Copy, GraduationCap, Pause, Pencil, Play, Plus, Trash2, XCircle } from "lucide-react";
import { useCallback, useMemo, useState, type MouseEvent } from "react";

import { describeTrigger, type Bot, type Routine } from "@mrog/shared";
import { BotAvatar, Button, cn } from "@mrog/ui-kit";

import { useBots } from "../../hooks/bots";
import { useRoutineActions, useRoutines } from "../../hooks/phase5";
import { harnessInfo } from "../../lib/harness";
import { ContextMenu, type MenuEntry } from "../ContextMenu";
import { Section } from "../settings/parts";
import { RoutineEditor } from "./RoutineEditor";

const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Right-click actions shared by the calendar and lists. */
export function useRoutineMenu() {
  const { save, remove, run } = useRoutineActions();
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [editing, setEditing] = useState<Routine | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const open = (event: MouseEvent, routine: Routine) => {
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        routine.enabled
          ? {
              label: "Pause",
              icon: <Pause size={14} />,
              onSelect: () => save.mutate({ id: routine.id, input: { enabled: false } }),
            }
          : {
              label: "Resume",
              icon: <Play size={14} />,
              onSelect: () => save.mutate({ id: routine.id, input: { enabled: true } }),
            },
        { label: "Test", icon: <Play size={14} />, onSelect: () => run.mutate(routine.id) },
        { label: "Edit", icon: <Pencil size={14} />, onSelect: () => setEditing(routine) },
        "separator",
        {
          label: "Delete",
          icon: <Trash2 size={14} />,
          danger: true,
          onSelect: () => window.confirm(`Delete “${routine.name}”?`) && remove.mutate(routine.id),
        },
      ],
    });
  };
  const elements = (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={close} />}
      {editing && <RoutineEditor routine={editing} onClose={() => setEditing(null)} />}
    </>
  );
  return { open, elements, run };
}

export function RoutineRow({
  routine,
  bot,
  onMenu,
}: {
  routine: Routine;
  bot?: Bot;
  onMenu(event: MouseEvent): void;
}) {
  const [copied, setCopied] = useState(false);
  const harness = harnessInfo();
  const webhook =
    routine.webhookSecret && harness
      ? `${harness.url}/hooks/${routine.id}?key=${routine.webhookSecret}`
      : null;
  return (
    <li
      onContextMenu={onMenu}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border border-border px-3 py-2 text-[13px]",
        !routine.enabled && "opacity-60",
      )}
    >
      {bot && <BotAvatar avatar={bot.avatar} size={20} className="mt-0.5" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{routine.name}</span>
          {!routine.enabled && <span className="text-[11px] text-ink-3">paused</span>}
          {routine.lastStatus === "done" && (
            <CheckCircle2 size={12} className="text-success" aria-label="Last run worked" />
          )}
          {routine.lastStatus === "error" && (
            <XCircle size={12} className="text-danger" aria-label="Last run failed" />
          )}
        </div>
        <div className="text-[12px] text-ink-3">
          {describeTrigger(routine.trigger)}
          {routine.nextRunAt && ` · next ${new Date(routine.nextRunAt).toLocaleString()}`}
        </div>
        {webhook && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(webhook);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="mt-1 flex max-w-full items-center gap-1 font-mono text-[11px] text-accent"
            title="Copy webhook address (works from this computer)"
          >
            <Copy size={11} className="shrink-0" />
            <span className="truncate">{copied ? "Copied" : webhook}</span>
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onMenu}
        className="rounded-md px-1.5 text-ink-3 hover:bg-hover"
        aria-label={`Actions for ${routine.name}`}
      >
        ⋯
      </button>
    </li>
  );
}

/** Settings → Routines: the week at a glance, then every routine. */
export function RoutinesSettings() {
  const { data: routines } = useRoutines();
  const { data: bots } = useBots();
  const menu = useRoutineMenu();
  const [editor, setEditor] = useState<"new" | "teach" | null>(null);
  const botMap = useMemo(() => new Map((bots ?? []).map((bot) => [bot.id, bot])), [bots]);
  const [today] = useState(() => new Date().getDay());

  const slots = useMemo(() => {
    const byDay = new Map<number, { time: string; routine: Routine }[]>();
    for (const routine of routines ?? []) {
      if (routine.trigger.type !== "weekly") continue;
      for (const day of routine.trigger.days) {
        for (const time of routine.trigger.times)
          byDay.set(day, [...(byDay.get(day) ?? []), { time, routine }]);
      }
    }
    for (const list of byDay.values()) list.sort((a, b) => a.time.localeCompare(b.time));
    return byDay;
  }, [routines]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => setEditor("new")} disabled={!bots?.length}>
          <Plus size={14} /> New routine
        </Button>
        <Button onClick={() => setEditor("teach")} disabled={!bots?.length}>
          <GraduationCap size={14} /> Teach a task
        </Button>
      </div>

      <Section
        title="This week"
        description="Routines run while the app is open, and catch up when it starts again."
      >
        <div className="grid grid-cols-7 gap-1.5" role="table" aria-label="Weekly calendar">
          {WEEK.map((day) => (
            <div key={day} className="min-h-28 rounded-xl border border-border p-1.5" role="cell">
              <div
                className={cn(
                  "mb-1 px-1 text-[11.5px] font-semibold",
                  day === today ? "text-accent" : "text-ink-3",
                )}
              >
                {DAY_NAMES[day]}
              </div>
              {(slots.get(day) ?? []).map(({ time, routine }) => (
                <button
                  key={`${routine.id}-${time}`}
                  type="button"
                  onContextMenu={(event) => menu.open(event, routine)}
                  onClick={(event) => menu.open(event, routine)}
                  title={routine.name}
                  className={cn(
                    "mb-1 block w-full truncate rounded-md bg-selected px-1.5 py-0.5 text-left text-[11.5px]",
                    !routine.enabled && "opacity-50",
                  )}
                >
                  <span className="tabular-nums text-ink-2">{time}</span> {routine.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      </Section>

      <Section title="All routines">
        {routines?.length === 0 && <p className="text-[13px] text-ink-3">No routines yet.</p>}
        <ul className="flex flex-col gap-1.5">
          {routines?.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              bot={botMap.get(routine.botId)}
              onMenu={(event) => menu.open(event, routine)}
            />
          ))}
        </ul>
      </Section>
      {menu.elements}
      {editor && <RoutineEditor teach={editor === "teach"} onClose={() => setEditor(null)} />}
    </div>
  );
}

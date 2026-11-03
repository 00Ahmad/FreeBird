import { useState } from "react";

import type { Routine, RoutineTrigger } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { useBots } from "../../hooks/bots";
import { useRoutineActions } from "../../hooks/phase5";
import { Modal } from "../Modal";
import { Field, TextInput } from "../settings/parts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
type Kind = RoutineTrigger["type"];

const toLocalInput = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** Create or edit a routine; "teach" mode is "Teach a task": numbered steps you run on demand. */
export function RoutineEditor(props: {
  routine?: Routine;
  botId?: string;
  teach?: boolean;
  onClose(): void;
}) {
  const { data: bots } = useBots();
  const { save } = useRoutineActions();
  const initial = props.routine;
  const [botId, setBotId] = useState(initial?.botId ?? props.botId ?? bots?.[0]?.id ?? "");
  const [name, setName] = useState(initial?.name ?? (props.teach ? "" : ""));
  const [prompt, setPrompt] = useState(initial?.prompt ?? (props.teach ? "1. \n2. \n3. " : ""));
  const [kind, setKind] = useState<Kind>(initial?.trigger.type ?? (props.teach ? "manual" : "weekly"));
  const weekly = initial?.trigger.type === "weekly" ? initial.trigger : null;
  const [days, setDays] = useState<number[]>(weekly?.days ?? [1, 2, 3, 4, 5]);
  const [times, setTimes] = useState(weekly?.times.join(", ") ?? "08:00");
  const [minutes, setMinutes] = useState(initial?.trigger.type === "interval" ? initial.trigger.minutes : 60);
  const [at, setAt] = useState(initial?.trigger.type === "once" ? toLocalInput(initial.trigger.at) : "");

  const trigger = (): RoutineTrigger => {
    switch (kind) {
      case "weekly":
        return {
          type: "weekly",
          days,
          times: times
            .split(/[,\s]+/)
            .map((time) => time.trim())
            .filter(Boolean)
            .map((time) => (time.length === 4 ? `0${time}` : time)),
        };
      case "interval":
        return { type: "interval", minutes };
      case "once":
        return { type: "once", at: new Date(at).toISOString() };
      default:
        return { type: kind };
    }
  };

  return (
    <Modal
      title={props.teach ? "Teach a task" : initial ? "Edit routine" : "New routine"}
      onClose={props.onClose}
      className="max-w-xl"
    >
      <form
        className="flex flex-col gap-3 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(
            {
              id: initial?.id,
              input: { botId, name: name.trim(), prompt: prompt.trim(), trigger: trigger() },
            },
            { onSuccess: props.onClose },
          );
        }}
      >
        {props.teach && (
          <p className="text-[12.5px] text-ink-3">
            Write the steps the way you'd do them. The bot follows them each time you run this task, and you
            can correct it in the chat.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Weekday inbox triage"
              required
            />
          </Field>
          <Field label="Bot">
            <select className="select" value={botId} onChange={(event) => setBotId(event.target.value)}>
              {bots
                ?.filter((bot) => !bot.clusterId)
                .map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <Field label={props.teach ? "Steps" : "What to do each time"}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={props.teach ? 7 : 4}
            required
            className="rounded-lg border border-border bg-bg px-2.5 py-2 text-[13px] outline-none focus:border-accent"
          />
        </Field>
        <Field label="When">
          <select className="select" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
            <option value="weekly">On days and times</option>
            <option value="interval">Every few minutes or hours</option>
            <option value="once">Once</option>
            <option value="webhook">When a webhook is called</option>
            <option value="manual">Only when I run it</option>
          </select>
        </Field>
        {kind === "weekly" && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-1" role="group" aria-label="Days">
              {DAYS.map((day, index) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={days.includes(index)}
                  onClick={() =>
                    setDays((current) =>
                      current.includes(index) ? current.filter((d) => d !== index) : [...current, index],
                    )
                  }
                  className={cn(
                    "flex-1 rounded-lg border py-1 text-[12.5px]",
                    days.includes(index)
                      ? "border-accent bg-selected font-medium"
                      : "border-border text-ink-2 hover:bg-hover",
                  )}
                >
                  {day}
                </button>
              ))}
            </div>
            <TextInput
              value={times}
              onChange={(event) => setTimes(event.target.value)}
              placeholder="08:00, 14:00"
              aria-label="Times"
            />
          </div>
        )}
        {kind === "interval" && (
          <select
            className="select"
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
            aria-label="Interval"
          >
            {[5, 15, 30, 60, 120, 240, 480, 1440].map((value) => (
              <option key={value} value={value}>
                Every {value < 60 ? `${value} minutes` : `${value / 60} hour${value > 60 ? "s" : ""}`}
              </option>
            ))}
          </select>
        )}
        {kind === "once" && (
          <TextInput
            type="datetime-local"
            value={at}
            onChange={(event) => setAt(event.target.value)}
            required
            aria-label="Date and time"
          />
        )}
        {kind === "webhook" && (
          <p className="text-[12.5px] text-ink-3">
            After saving, copy the webhook address from the routine list.
          </p>
        )}
        {save.error && <p className="text-xs text-danger">{save.error.message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={save.isPending || !botId || (kind === "weekly" && days.length === 0)}
          >
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

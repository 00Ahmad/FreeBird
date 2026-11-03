import { Flag, Loader2, Plus, Scale, X } from "lucide-react";
import { useState } from "react";

import { AVATAR_COLORS, MAX_RACERS, MIN_RACERS, type RaceEntrant } from "@mrog/shared";
import { BotAvatar, Button, cn } from "@mrog/ui-kit";

import { useStartRace } from "../hooks/race";
import { useUi } from "../state";
import { Modal } from "./Modal";
import { ModelSelect } from "./ModelSelect";

/** Default racer names: small birds, for a FreeBird race. */
const NAMES = ["Wren", "Kestrel", "Robin", "Swift", "Finch"];

const field = "rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent";

/** What's wrong with the line-up, or null when the race can start. */
function lineupProblem(task: string, racers: RaceEntrant[]): string | null {
  if (task.trim().length < 3) return "Give the racers a task.";
  if (racers.some((racer) => !racer.name.trim())) return "Give every racer a name.";
  const names = racers.map((racer) => racer.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "Give each racer a different name.";
  if (names.includes("judge")) return "“Judge” is taken by the judge.";
  return null;
}

/**
 * New race: one task, 3–5 racers that each work alone on their own model, and a judge that scores them and
 * compiles the best result.
 */
export function NewRaceDialog() {
  const setOverlay = useUi((state) => state.setOverlay);
  const select = useUi((state) => state.select);
  const start = useStartRace();
  const [task, setTask] = useState("");
  const [racers, setRacers] = useState<RaceEntrant[]>(
    NAMES.slice(0, 3).map((name) => ({ name, model: null })),
  );
  const [judgeModel, setJudgeModel] = useState<string | null>(null);
  const close = () => setOverlay(null);
  const problem = lineupProblem(task, racers);

  const change = (index: number, patch: Partial<RaceEntrant>) =>
    setRacers((current) => current.map((racer, i) => (i === index ? { ...racer, ...patch } : racer)));

  return (
    <Modal title="New race" onClose={close} className="max-w-2xl">
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem || start.isPending) return;
          start.mutate(
            {
              task: task.trim(),
              racers: racers.map((racer) => ({ name: racer.name.trim(), model: racer.model ?? null })),
              judge: { model: judgeModel },
            },
            {
              onSuccess: ({ thread }) => {
                select(thread.id);
                close();
              },
            },
          );
        }}
      >
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
          <p className="text-[13px] text-ink-2">
            Every racer does the whole task on its own, with its own strategy, and none of them sees the
            others. Then the judge picks criteria for the task, scores them, names a winner and combines the
            best parts into one result.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Task</span>
            <textarea
              value={task}
              onChange={(event) => setTask(event.target.value)}
              rows={3}
              placeholder="Anything, for example: Write a one-page launch plan for a budgeting app for students."
              className={cn(field, "resize-none py-2")}
            />
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">
              Racers <span className="font-normal text-ink-3">· pick a model for each</span>
            </span>
            {racers.map((racer, index) => (
              <div key={index} className="flex items-center gap-2.5">
                <BotAvatar
                  avatar={{ shape: "circle", color: AVATAR_COLORS[index % AVATAR_COLORS.length]! }}
                  size={26}
                />
                <input
                  value={racer.name}
                  onChange={(event) => change(index, { name: event.target.value })}
                  aria-label="Racer name"
                  maxLength={40}
                  className={cn(field, "h-8 w-32 shrink-0 font-medium")}
                />
                <ModelSelect
                  value={racer.model ?? null}
                  onChange={(model) => change(index, { model })}
                  label={`${racer.name || "Racer"}'s model`}
                  className="h-8 flex-1"
                />
                <button
                  type="button"
                  onClick={() => setRacers(racers.filter((_, i) => i !== index))}
                  disabled={racers.length <= MIN_RACERS}
                  aria-label={`Remove ${racer.name || "this racer"}`}
                  title={
                    racers.length <= MIN_RACERS ? `A race needs at least ${MIN_RACERS} racers` : "Remove"
                  }
                  className="rounded-md p-1 text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-30"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {racers.length < MAX_RACERS && (
              <button
                type="button"
                onClick={() =>
                  setRacers([
                    ...racers,
                    {
                      name: NAMES.find((name) => !racers.some((racer) => racer.name === name)) ?? "",
                      model: null,
                    },
                  ])
                }
                className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-[13px] text-ink-2 hover:border-accent hover:text-accent"
              >
                <Plus size={14} /> Add a racer ({racers.length} of {MAX_RACERS})
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5 rounded-xl border border-border p-3">
            <span className="flex size-[26px] items-center justify-center rounded-full bg-hover text-ink-2">
              <Scale size={14} />
            </span>
            <span className="w-32 shrink-0 text-[13px] font-medium">Judge</span>
            <ModelSelect
              value={judgeModel}
              onChange={setJudgeModel}
              label="The judge's model"
              className="h-8 flex-1"
            />
          </div>
          <p className="text-xs text-ink-3">
            Tip: give racers different models for really different results. Cloud models (Claude, GPT…) can be
            added in Settings → Providers. On one local GPU, Ollama runs one racer at a time unless “Bots at
            once” is raised in Settings → Local model.
          </p>
        </div>

        <div className="flex items-center gap-3 border-t border-border px-5 py-3">
          <span className="min-w-0 flex-1 text-xs text-ink-3">
            {problem ?? `${racers.length} racers and a judge.`}
          </span>
          {start.error && <span className="text-xs text-danger">{start.error.message}</span>}
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={Boolean(problem) || start.isPending}>
            {start.isPending ? <Loader2 size={14} className="animate-spin" /> : <Flag size={14} />}
            Start race
          </Button>
        </div>
      </form>
    </Modal>
  );
}

import { Check, X } from "lucide-react";
import { useState } from "react";

import { Workplace, type Bot, type JobProfile, type JobProject } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { useAnswerSuggestion, useApproveJobProfile, useUpdateJobProfile } from "../../hooks/jobs";
import { linesOf, LIST_FIELDS, listFrom, profileChange } from "../../lib/jobs";

const field = "rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent";

/** Your profile: every field editable, Approve before the first scan, and the changes your reactions suggest. */
export function ProfileCard({ bot, project }: { bot: Bot; project: JobProject }) {
  const update = useUpdateJobProfile(bot.id);
  const approve = useApproveJobProfile(bot.id);
  const answer = useAnswerSuggestion(bot.id);
  // Your edits, or null while you aren't editing: then the card shows the saved profile, so a change made elsewhere
  // (the interview, an accepted suggestion) shows at once.
  const [edits, setEdits] = useState<JobProfile | null>(null);
  const draft = edits ?? project.profile;
  const dirty = edits !== null && profileChange(project.profile, edits) !== null;
  const set = (patch: Partial<JobProfile>) => setEdits({ ...draft, ...patch });
  const save = () => {
    const change = edits && profileChange(project.profile, edits);
    if (change) update.mutate({ body: change }, { onSuccess: () => setEdits(null) });
    else setEdits(null);
  };
  const needsApproval = project.status === "interview" || project.status === "awaiting_profile";

  return (
    <div className="flex flex-col gap-3 p-4 text-[13px]">
      {project.suggestions.length > 0 && (
        <section className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent/5 p-3">
          <h4 className="text-[12.5px] font-medium">Suggested from your reactions</h4>
          {project.suggestions.map((suggestion) => (
            <div key={suggestion.id} className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                Add <span className="font-medium">{suggestion.value}</span> to{" "}
                {LIST_FIELDS.find(([key]) => key === suggestion.field)?.[1].toLowerCase()}
                <span className="block text-[12px] text-ink-3">{suggestion.because}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => answer.mutate({ id: suggestion.id, body: { accept: true } })}
              >
                <Check size={13} /> Add
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => answer.mutate({ id: suggestion.id, body: { accept: false } })}
              >
                <X size={13} />
              </Button>
            </div>
          ))}
        </section>
      )}

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-[12.5px] font-medium">Workplace</legend>
        <div className="flex gap-3">
          {Workplace.options.map((kind) => (
            <label key={kind} className="flex items-center gap-1.5 capitalize">
              <input
                type="checkbox"
                checked={draft.workplace.includes(kind)}
                onChange={(event) =>
                  set({
                    workplace: event.target.checked
                      ? [...draft.workplace, kind]
                      : draft.workplace.filter((w) => w !== kind),
                  })
                }
              />
              {kind}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">Seniority</span>
        <input
          value={draft.seniority}
          maxLength={80}
          onChange={(e) => set({ seniority: e.target.value })}
          className={cn(field, "h-8")}
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">Lowest salary</span>
        <div className="flex gap-2">
          <input
            type="number"
            min={0}
            aria-label="Amount"
            value={draft.minSalary?.amount ?? ""}
            onChange={(e) =>
              set({
                minSalary: e.target.value
                  ? {
                      amount: Number(e.target.value),
                      currency: draft.minSalary?.currency ?? "USD",
                      period: draft.minSalary?.period ?? "year",
                    }
                  : null,
              })
            }
            className={cn(field, "h-8 w-28")}
          />
          <input
            aria-label="Currency"
            value={draft.minSalary?.currency ?? ""}
            maxLength={8}
            disabled={!draft.minSalary}
            onChange={(e) =>
              draft.minSalary && set({ minSalary: { ...draft.minSalary, currency: e.target.value } })
            }
            className={cn(field, "h-8 w-20")}
          />
          <select
            aria-label="Per"
            value={draft.minSalary?.period ?? "year"}
            disabled={!draft.minSalary}
            onChange={(e) =>
              draft.minSalary &&
              set({ minSalary: { ...draft.minSalary, period: e.target.value as "year" | "month" | "hour" } })
            }
            className={cn(field, "h-8")}
          >
            <option value="year">a year</option>
            <option value="month">a month</option>
            <option value="hour">an hour</option>
          </select>
        </div>
      </div>

      {LIST_FIELDS.map(([key, label]) => (
        <label key={key} className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium">
            {label} <span className="font-normal text-ink-3">· one per line</span>
          </span>
          <textarea
            rows={Math.min(5, Math.max(2, draft[key].length + 1))}
            value={linesOf(draft[key])}
            onChange={(e) => set({ [key]: listFrom(e.target.value) } as Partial<JobProfile>)}
            className={cn(field, "py-1.5")}
          />
        </label>
      ))}

      {(["travel", "rightToWork", "experience"] as const).map((key) => (
        <label key={key} className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium">
            {key === "travel" ? "Travel" : key === "rightToWork" ? "Right to work" : "Skills and experience"}
          </span>
          <textarea
            rows={key === "experience" ? 4 : 2}
            maxLength={key === "experience" ? 2000 : 300}
            value={draft[key]}
            onChange={(e) => set({ [key]: e.target.value } as Partial<JobProfile>)}
            className={cn(field, "py-1.5")}
          />
        </label>
      ))}

      <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-surface py-3">
        <span className="min-w-0 flex-1 text-[12px] text-ink-3" aria-live="polite">
          {update.error?.message ??
            approve.error?.message ??
            (dirty ? "Unsaved changes." : "Stays on this computer.")}
        </span>
        <Button size="sm" onClick={save} disabled={!dirty || update.isPending}>
          Save
        </Button>
        {needsApproval && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => approve.mutate(undefined)}
            disabled={dirty || approve.isPending}
          >
            Approve profile
          </Button>
        )}
      </div>
    </div>
  );
}

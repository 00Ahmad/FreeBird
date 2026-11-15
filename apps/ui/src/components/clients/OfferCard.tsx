import { Check, X } from "lucide-react";
import { useState } from "react";

import {
  CLUE_IDS,
  PLAYBOOK_IDS,
  SIGNAL_KINDS,
  TRAIT_IDS,
  type Bot,
  type ClientProject,
  type OfferProfile,
  type PlaybookId,
} from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { useAnswerOfferSuggestion, useApproveOffer, useUpdateOffer } from "../../hooks/clients";
import {
  CLUE_LABELS,
  OFFER_LISTS,
  offerChange,
  SIGNAL_LABELS,
  sizeFrom,
  TRAIT_LABELS,
} from "../../lib/clients";
import { linesOf, listFrom } from "../../lib/jobs";

const field = "rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent";

const PLAYBOOK_LABELS: Record<PlaybookId, string> = {
  payroll: "Payroll",
  accounting: "Accounting and bookkeeping",
  marketing: "Marketing",
  software: "Software development",
  it_support: "IT support",
  recruitment: "Recruitment",
  generic: "Other service",
};

/** A group of ticks for a profile list of ids (signs, traits, clues). */
function Ticks<T extends string>({
  title,
  ids,
  labels,
  value,
  onChange,
}: {
  title: string;
  ids: readonly T[];
  labels: Record<T, string>;
  value: T[];
  onChange(next: T[]): void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-0.5 text-[12.5px] font-medium">{title}</legend>
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id) => {
          const on = value.includes(id);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((v) => v !== id) : [...value, id])}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[12px]",
                on ? "border-accent bg-accent/15 text-ink" : "border-border text-ink-3 hover:text-ink",
              )}
            >
              {labels[id]}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** What you sell and your ideal client: every field editable, Approve before the first scan, suggested changes. */
export function OfferCard({ bot, project }: { bot: Bot; project: ClientProject }) {
  const update = useUpdateOffer(bot.id);
  const approve = useApproveOffer(bot.id);
  const answer = useAnswerOfferSuggestion(bot.id);
  const [edits, setEdits] = useState<OfferProfile | null>(null);
  const [sizes, setSizes] = useState<{ min: string; max: string } | null>(null);
  const draft = edits ?? project.profile;
  const sizeText = sizes ?? { min: draft.sizeMin?.toString() ?? "", max: draft.sizeMax?.toString() ?? "" };
  const min = sizeFrom(sizeText.min);
  const max = sizeFrom(sizeText.max);
  const badSize = min === "bad" || max === "bad";
  const withSizes = (profile: OfferProfile): OfferProfile =>
    badSize ? profile : { ...profile, sizeMin: min as number | null, sizeMax: max as number | null };
  const dirty = (edits !== null || sizes !== null) && offerChange(project.profile, withSizes(draft)) !== null;
  const set = (patch: Partial<OfferProfile>) => setEdits({ ...draft, ...patch });
  const save = () => {
    const change = offerChange(project.profile, withSizes(draft));
    const done = () => {
      setEdits(null);
      setSizes(null);
    };
    if (change && !badSize) update.mutate({ body: change }, { onSuccess: done });
    else if (!change) done();
  };
  const needsApproval = project.status === "interview" || project.status === "awaiting_profile";

  return (
    <div className="flex flex-col gap-3 p-4">
      {project.suggestions.length > 0 && (
        <section className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent/5 p-3 text-[12.5px]">
          <h4 className="font-medium">Suggested from your reactions</h4>
          {project.suggestions.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                {s.field === "sizeMax"
                  ? `Largest size: ${s.value} staff`
                  : s.field === "sizeMin"
                    ? `Smallest size: ${s.value} staff`
                    : `Leave out: ${s.value}`}
                <span className="block text-ink-3">{s.because}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => answer.mutate({ id: s.id, body: { accept: true } })}
                aria-label="Accept"
              >
                <Check size={13} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => answer.mutate({ id: s.id, body: { accept: false } })}
                aria-label="Skip"
              >
                <X size={13} />
              </Button>
            </div>
          ))}
        </section>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">What you sell</span>
        <textarea
          rows={2}
          maxLength={300}
          value={draft.offer}
          onChange={(e) => set({ offer: e.target.value })}
          className={cn(field, "py-1.5")}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">Kind of service</span>
        <select
          value={draft.playbook ?? ""}
          onChange={(e) => set({ playbook: (e.target.value || null) as PlaybookId | null })}
          className={cn(field, "h-8")}
        >
          <option value="">Picked from what you sell</option>
          {PLAYBOOK_IDS.map((id) => (
            <option key={id} value={id}>
              {PLAYBOOK_LABELS[id]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">Your price</span>
        <input
          maxLength={200}
          value={draft.price}
          onChange={(e) => set({ price: e.target.value })}
          className={cn(field, "h-8")}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {(["min", "max"] as const).map((end) => (
          <label key={end} className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium">{end === "min" ? "Fewest staff" : "Most staff"}</span>
            <input
              inputMode="numeric"
              value={sizeText[end]}
              placeholder="No limit"
              onChange={(e) => setSizes({ ...sizeText, [end]: e.target.value })}
              className={cn(field, "h-8")}
            />
          </label>
        ))}
      </div>
      {OFFER_LISTS.map(([key, label]) => (
        <label key={key} className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium">{label}</span>
          <textarea
            rows={2}
            value={linesOf(draft[key])}
            onChange={(e) => set({ [key]: listFrom(e.target.value) } as Partial<OfferProfile>)}
            placeholder="One per line"
            className={cn(field, "py-1.5")}
          />
        </label>
      ))}
      <Ticks
        title="Signs to look for"
        ids={SIGNAL_KINDS}
        labels={SIGNAL_LABELS}
        value={draft.signals}
        onChange={(signals) => set({ signals })}
      />
      <Ticks
        title="Traits (need from facts, not events)"
        ids={TRAIT_IDS}
        labels={TRAIT_LABELS}
        value={draft.traits}
        onChange={(traits) => set({ traits })}
      />
      <Ticks
        title="Website clues"
        ids={CLUE_IDS}
        labels={CLUE_LABELS}
        value={draft.clues}
        onChange={(clues) => set({ clues })}
      />

      <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-surface py-3">
        <span className="min-w-0 flex-1 text-[12px] text-ink-3" aria-live="polite">
          {badSize
            ? "Staff numbers are whole numbers."
            : (update.error?.message ??
              approve.error?.message ??
              (dirty ? "Unsaved changes." : "Stays on this computer."))}
        </span>
        <Button size="sm" onClick={save} disabled={!dirty || badSize || update.isPending}>
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

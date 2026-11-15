import { Search } from "lucide-react";
import { useState } from "react";

import { MAX_CLIENT_TARGET, type Bot, type ClientProject, type LeadKind } from "@mrog/shared";
import { Button } from "@mrog/ui-kit";

import { useStartClientScan } from "../../hooks/clients";
import { kindsFrom, KIND_LABELS, scanTarget, suggestedTarget } from "../../lib/clients";
import { Modal } from "../Modal";

const KIND_HINTS: Record<LeadKind, string> = {
  asking: "tenders and “looking for a provider” posts",
  signs: "a good fit showing a sign, like hiring or opening a new site",
  quiet: "a good fit that has never posted anything, from official registers",
};

/** Starting a scan always asks how many new, unique leads to find, and which kinds. */
export function ClientScanDialog({
  bot,
  project,
  onClose,
}: {
  bot: Bot;
  project: ClientProject;
  onClose(): void;
}) {
  const start = useStartClientScan(bot.id);
  const [raw, setRaw] = useState(String(suggestedTarget(project)));
  const [ticks, setTicks] = useState<Record<LeadKind, boolean>>({
    asking: project.lastKinds.includes("asking"),
    signs: project.lastKinds.includes("signs"),
    quiet: project.lastKinds.includes("quiet"),
  });
  const parsed = scanTarget(raw);
  const kinds = kindsFrom(ticks);
  const problem =
    "problem" in parsed ? parsed.problem : kinds.length === 0 ? "Tick at least one kind of lead." : null;
  return (
    <Modal title="Find clients" onClose={onClose} className="max-w-sm">
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if ("target" in parsed && kinds.length > 0)
            start.mutate({ body: { target: parsed.target, kinds } }, { onSuccess: onClose });
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">How many new leads should I find?</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_CLIENT_TARGET}
            value={raw}
            autoFocus
            onChange={(event) => setRaw(event.target.value)}
            className="h-8 w-24 rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent"
          />
          <span className="text-xs text-ink-3">
            Only businesses you haven't been shown before count. Each one is read and checked, so more take
            longer.
          </span>
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px] font-medium">Look for</legend>
          {(["asking", "signs", "quiet"] as const).map((kind) => (
            <label key={kind} className="flex items-start gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={ticks[kind]}
                onChange={(event) => setTicks((current) => ({ ...current, [kind]: event.target.checked }))}
                className="mt-0.5"
              />
              <span>
                {KIND_LABELS[kind]} <span className="text-ink-3">: {KIND_HINTS[kind]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 text-xs text-danger" aria-live="polite">
            {start.error?.message ?? problem}
          </span>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={Boolean(problem) || start.isPending}>
            <Search size={13} /> Start scan
          </Button>
        </div>
      </form>
    </Modal>
  );
}

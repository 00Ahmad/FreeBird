import { Search } from "lucide-react";
import { useState } from "react";

import { MAX_JOB_TARGET, type Bot, type JobProject } from "@mrog/shared";
import { Button } from "@mrog/ui-kit";

import { useStartJobScan } from "../../hooks/jobs";
import { scanTarget, suggestedTarget } from "../../lib/jobs";
import { Modal } from "../Modal";

/** Starting a scan always asks how many new, unique jobs to find this time (suggesting the last number). */
export function ScanDialog({ bot, project, onClose }: { bot: Bot; project: JobProject; onClose(): void }) {
  const start = useStartJobScan(bot.id);
  const [raw, setRaw] = useState(String(suggestedTarget(project)));
  const parsed = scanTarget(raw);
  const problem = "problem" in parsed ? parsed.problem : null;
  return (
    <Modal title="Scan for jobs" onClose={onClose} className="max-w-sm">
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if ("target" in parsed) start.mutate({ body: { target: parsed.target } }, { onSuccess: onClose });
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">How many new jobs should I find?</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_JOB_TARGET}
            value={raw}
            autoFocus
            onChange={(event) => setRaw(event.target.value)}
            className="h-8 w-24 rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent"
          />
          <span className="text-xs text-ink-3">
            Only jobs you haven't been shown before count. Each one is read and checked, so more jobs take
            longer.
          </span>
        </label>
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

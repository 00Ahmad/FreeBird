import { Loader2, Search, Square, X } from "lucide-react";
import { useState } from "react";

import type { Bot } from "@mrog/shared";
import { Button, cn, IconButton } from "@mrog/ui-kit";

import { useAnswerHandoff, useJobProject, useStopJob } from "../../hooks/jobs";
import { canScan, isScanning, statusLine } from "../../lib/jobs";
import { useUi } from "../../state";
import { JobActivity } from "./JobActivity";
import { JobBoard } from "./JobBoard";
import { ProfileCard } from "./ProfileCard";
import { ScanDialog } from "./ScanDialog";

type Tab = "board" | "profile" | "activity";
const TABS: [Tab, string][] = [
  ["board", "Board"],
  ["profile", "Profile"],
  ["activity", "Activity"],
];

/** The Job Bot's panel beside its chat: what it is doing, Scan / Stop, and the board, profile and activity. */
export function JobPanel({ bot }: { bot: Bot }) {
  const { data: project } = useJobProject(bot.id, true);
  const toggleJob = useUi((state) => state.toggleJob);
  const stop = useStopJob(bot.id);
  const handoff = useAnswerHandoff(bot.id);
  const [scanOpen, setScanOpen] = useState(false);
  // The profile comes first until it is approved; then the board.
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab: Tab =
    chosen ??
    (project && (project.status === "interview" || project.status === "awaiting_profile")
      ? "profile"
      : "board");

  return (
    <aside
      className="flex h-full w-[420px] shrink-0 flex-col border-l border-border bg-surface"
      aria-label="Job search"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="flex-1 text-[14px] font-semibold">Job search</h2>
        {project && isScanning(project) ? (
          <Button size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}>
            <Square size={12} /> Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => setScanOpen(true)}
            disabled={!project || !canScan(project)}
            title={project && !canScan(project) ? "Approve your profile first" : undefined}
          >
            <Search size={12} /> Scan
          </Button>
        )}
        <IconButton label="Close the Job panel" onClick={toggleJob}>
          <X size={15} />
        </IconButton>
      </div>

      {project && (
        <p
          className="flex items-center gap-2 border-b border-border px-4 py-2 text-[12.5px] text-ink-2"
          aria-live="polite"
        >
          {isScanning(project) && <Loader2 size={12} className="shrink-0 animate-spin text-accent" />}
          <span className="min-w-0 flex-1">{statusLine(project)}</span>
        </p>
      )}

      {project?.handoff && (
        <div
          role="alert"
          className="flex flex-col gap-2 border-b border-border bg-selected px-4 py-3 text-[12.5px]"
        >
          <p>
            {project.handoff.reason} Open the <span className="font-medium">Browser</span> panel (or the
            browser window) and deal with it, then press Continue.
          </p>
          <p className="truncate text-ink-3">{project.handoff.url}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => handoff.mutate({ body: { action: "continue" } })}
            >
              Continue
            </Button>
            <Button size="sm" variant="ghost" onClick={() => handoff.mutate({ body: { action: "skip" } })}>
              Skip this page
            </Button>
          </div>
        </div>
      )}

      <div role="tablist" aria-label="Job views" className="flex gap-1 border-b border-border px-3 py-1.5">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setChosen(value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12.5px]",
              tab === value ? "bg-selected font-medium text-ink" : "text-ink-3 hover:text-ink",
            )}
          >
            {label}
            {value === "profile" && project && project.suggestions.length > 0 && (
              <span className="ml-1 rounded-full bg-accent px-1.5 text-[10.5px] text-white">
                {project.suggestions.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!project ? (
          <p className="p-4 text-[13px] text-ink-3">Loading…</p>
        ) : tab === "board" ? (
          <JobBoard bot={bot} project={project} />
        ) : tab === "profile" ? (
          <ProfileCard bot={bot} project={project} />
        ) : (
          <JobActivity project={project} />
        )}
      </div>
      {scanOpen && project && <ScanDialog bot={bot} project={project} onClose={() => setScanOpen(false)} />}
    </aside>
  );
}

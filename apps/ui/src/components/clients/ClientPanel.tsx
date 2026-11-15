import { Loader2, Search, Square, X } from "lucide-react";
import { useState } from "react";

import type { Bot } from "@mrog/shared";
import { Button, cn, IconButton } from "@mrog/ui-kit";

import { useAnswerClientHandoff, useClientProject, useStopClient } from "../../hooks/clients";
import { canScan, isScanning, statusLine } from "../../lib/clients";
import { useUi } from "../../state";
import { ClientActivity } from "./ClientActivity";
import { ClientScanDialog } from "./ClientScanDialog";
import { LeadBoard } from "./LeadBoard";
import { ListsCard } from "./ListsCard";
import { OfferCard } from "./OfferCard";

type Tab = "board" | "profile" | "lists" | "activity";
const TABS: [Tab, string][] = [
  ["board", "Board"],
  ["profile", "Profile"],
  ["lists", "Lists"],
  ["activity", "Activity"],
];

/** The Client Bot's panel beside its chat: what it is doing, Scan / Stop, the board, profile, lists and activity. */
export function ClientPanel({ bot }: { bot: Bot }) {
  const { data: project } = useClientProject(bot.id, true);
  const toggleClient = useUi((state) => state.toggleClient);
  const stop = useStopClient(bot.id);
  const handoff = useAnswerClientHandoff(bot.id);
  const [scanOpen, setScanOpen] = useState(false);
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab: Tab =
    chosen ??
    (project && (project.status === "interview" || project.status === "awaiting_profile")
      ? "profile"
      : "board");

  return (
    <aside
      className="flex h-full w-[420px] shrink-0 flex-col border-l border-border bg-surface"
      aria-label="Finding clients"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="flex-1 text-[14px] font-semibold">Finding clients</h2>
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
        <IconButton label="Close the Client panel" onClick={toggleClient}>
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

      <div role="tablist" aria-label="Client views" className="flex gap-1 border-b border-border px-3 py-1.5">
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
          <LeadBoard bot={bot} project={project} />
        ) : tab === "profile" ? (
          <OfferCard bot={bot} project={project} />
        ) : tab === "lists" ? (
          <ListsCard bot={bot} project={project} />
        ) : (
          <ClientActivity project={project} />
        )}
      </div>
      {scanOpen && project && (
        <ClientScanDialog bot={bot} project={project} onClose={() => setScanOpen(false)} />
      )}
    </aside>
  );
}

import { AlertTriangle, ChevronDown, ChevronRight, Download, TrendingUp } from "lucide-react";
import { useState } from "react";

import type { Bot, ClientProject, Lead } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { exportLeads } from "../../hooks/clients";
import { boardColumns, COLUMN_LABELS, KIND_LABELS, leadLine, scoreTone } from "../../lib/clients";
import { useUi } from "../../state";
import { LeadDetails } from "./LeadDetails";

const TONE = {
  strong: "bg-success/15 text-success",
  good: "bg-accent/15 text-accent",
  weak: "bg-ink-3/15 text-ink-3",
} as const;

/** The leads as a list of columns; a column with nothing in it stays folded away. */
export function LeadBoard({ bot, project }: { bot: Bot; project: ClientProject }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({ not_a_fit: true });
  // The time the panel opened: ages on the card ("12 days ago") don't need to tick.
  const [now] = useState(() => new Date());
  const open = project.leads.find((lead) => lead.id === openId);
  if (open) return <LeadDetails bot={bot} lead={open} onBack={() => setOpenId(null)} />;
  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="rounded-xl bg-selected px-3 py-2 text-[12px] text-ink-2">
        Each lead shows signs a business may need you, not certainty. Rules on contacting businesses differ by
        country, and this isn't legal advice. Nothing is ever sent for you.
      </p>
      {project.leads.length === 0 ? (
        <p className="px-1 text-[13px] text-ink-3">
          No leads yet.{" "}
          {project.status === "ready"
            ? "Press Scan to look for some."
            : "Once your profile is approved, start a scan."}
        </p>
      ) : (
        <>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void exportLeads(bot.id, bot.name).catch((error: Error) =>
                  useUi.getState().notify(error.message),
                )
              }
            >
              <Download size={12} /> Export CSV
            </Button>
          </div>
          {boardColumns(project.leads)
            .filter((column) => column.leads.length > 0)
            .map(({ column, leads }) => {
              const shut = folded[column] ?? false;
              return (
                <section key={column} aria-label={COLUMN_LABELS[column]}>
                  <button
                    type="button"
                    onClick={() => setFolded((current) => ({ ...current, [column]: !shut }))}
                    className="flex w-full items-center gap-1 px-1 pb-1 text-[12px] font-medium text-ink-2"
                    aria-expanded={!shut}
                  >
                    {shut ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    {COLUMN_LABELS[column]} <span className="text-ink-3">· {leads.length}</span>
                  </button>
                  {!shut && (
                    <ul className="flex flex-col gap-1.5">
                      {leads.map((lead) => (
                        <li key={lead.id}>
                          <LeadRow lead={lead} now={now} onOpen={() => setOpenId(lead.id)} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
        </>
      )}
    </div>
  );
}

function LeadRow({ lead, now, onOpen }: { lead: Lead; now: Date; onOpen(): void }) {
  const tone = scoreTone(lead.score);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2.5 rounded-xl border border-border bg-bg px-3 py-2 text-left hover:border-accent"
    >
      <span
        className={cn("mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold", TONE[tone])}
      >
        {lead.score}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{lead.company}</span>
          <span className="shrink-0 rounded bg-ink-3/10 px-1 text-[10.5px] text-ink-3">
            {KIND_LABELS[lead.kind]}
          </span>
          {lead.movedUp && (
            <span className="flex shrink-0 items-center gap-0.5 rounded bg-success/15 px-1 text-[10.5px] text-success">
              <TrendingUp size={10} /> Moved up
            </span>
          )}
        </span>
        <span className="block truncate text-[12px] text-ink-3">{leadLine(lead, now)}</span>
      </span>
      {lead.warnings.length > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5 text-[11.5px] text-warning"
          title={lead.warnings.map((w) => w.text).join("\n")}
        >
          <AlertTriangle size={12} /> {lead.warnings.length}
        </span>
      )}
    </button>
  );
}

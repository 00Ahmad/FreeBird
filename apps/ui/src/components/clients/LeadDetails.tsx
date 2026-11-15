import { ArrowLeft, Eye, EyeOff, ExternalLink, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { useState } from "react";

import { LEAD_COLUMNS, type Bot, type Lead, type LeadColumn, type MatchVerdict } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { useForgetLead, useLeadNote, useMoveLead, useReactToLead, useWatchLead } from "../../hooks/clients";
import {
  ageText,
  COLUMN_LABELS,
  CONTACT_LABELS,
  evidenceLabel,
  KIND_LABELS,
  SIGNAL_LABELS,
} from "../../lib/clients";

const VERDICT: Record<MatchVerdict, [string, string]> = {
  meets: ["✅", "Meets"],
  partly: ["⚠️", "Partly"],
  misses: ["❌", "Misses"],
  unknown: ["❔", "Not stated"],
};

const linkClass = "inline-flex items-center gap-1 text-accent";

/** One lead in full: why now, why you, how to reach them, warnings, your note and your reaction. */
export function LeadDetails({ bot, lead, onBack }: { bot: Bot; lead: Lead; onBack(): void }) {
  const react = useReactToLead(bot.id);
  const move = useMoveLead(bot.id);
  const note = useLeadNote(bot.id);
  const watch = useWatchLead(bot.id);
  const forget = useForgetLead(bot.id);
  const [reason, setReason] = useState(lead.reason ?? "");
  const [text, setText] = useState(lead.note);
  // The time the panel opened: ages on the card ("12 days ago") don't need to tick.
  const [now] = useState(() => new Date());
  const send = (reaction: "up" | "down" | null) =>
    react.mutate({
      leadId: lead.id,
      body: { reaction, ...(reaction && reason.trim() ? { reason: reason.trim() } : {}) },
    });

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink"
      >
        <ArrowLeft size={13} /> Back to the board
      </button>
      <div>
        <h3 className="text-[15px] font-semibold">{lead.company}</h3>
        <p className="text-ink-2">
          {KIND_LABELS[lead.kind]} · score {lead.score}
          {lead.domain && (
            <>
              {" · "}
              <a
                href={`https://${lead.domain}/`}
                target="_blank"
                rel="noreferrer noopener"
                className={linkClass}
              >
                {lead.domain} <ExternalLink size={11} />
              </a>
            </>
          )}
        </p>
        {lead.summary && <p className="mt-1 text-ink-3">{lead.summary}</p>}
        {lead.movedUp && <p className="mt-1 text-success">Moved up: {lead.movedUp}</p>}
        {lead.kind === "quiet" && (
          <p className="mt-1 text-ink-3">Fits your ideal client; no recent signs yet.</p>
        )}
      </div>

      {lead.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-xl border border-warning/40 bg-warning/10 p-3 text-[12.5px]">
          {lead.warnings.map((warning) => (
            <li key={`${warning.id}-${warning.text}`}>⚠️ {warning.text}</li>
          ))}
        </ul>
      )}

      {lead.signals.length > 0 && (
        <section>
          <h4 className="mb-1 text-[12.5px] font-medium text-ink-2">Why now: signs they may need you</h4>
          <ul className="flex flex-col gap-2">
            {lead.signals.map((sign) => (
              <li key={`${sign.kind}-${sign.quote}`}>
                <span className="font-medium">{SIGNAL_LABELS[sign.kind]}</span>
                <span className="text-ink-3">
                  {sign.date ? ` · ${sign.date} (${ageText(sign.date, now)})` : " · undated"}
                </span>
                <q className="block text-[12px] text-ink-2">{sign.quote}</q>
                <a
                  href={sign.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={cn(linkClass, "text-[12px]")}
                >
                  Where it says so <ExternalLink size={11} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4 className="mb-1 text-[12.5px] font-medium text-ink-2">Why you: how it fits your ideal client</h4>
        <ul className="flex flex-col gap-1.5">
          {lead.fit.map((line) => (
            <li key={line.requirement} className="flex gap-2">
              <span aria-label={VERDICT[line.verdict][1]}>{VERDICT[line.verdict][0]}</span>
              <span className="min-w-0">
                {line.requirement}
                {line.reason && <span className="block text-[12px] text-ink-3">{line.reason}</span>}
              </span>
            </li>
          ))}
          {lead.evidence.map((item) => (
            <li key={`${item.kind}-${item.id}`} className="flex gap-2">
              <span aria-hidden>🔎</span>
              <span className="min-w-0">
                {evidenceLabel(item.id)}
                <span className="block text-[12px] text-ink-3">{item.quote}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="mb-1 text-[12.5px] font-medium text-ink-2">How to reach them</h4>
        {lead.contacts.length === 0 ? (
          <p className="text-ink-3">No contact route was found.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {lead.contacts.map((route) => (
              <li key={`${route.kind}-${route.value}`} className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-ink-3">{CONTACT_LABELS[route.kind]}</span>
                {route.kind === "contact_page" || route.kind === "respond" ? (
                  <a
                    href={route.value}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={cn(linkClass, "truncate")}
                  >
                    {route.value} <ExternalLink size={11} />
                  </a>
                ) : (
                  <span className="min-w-0 truncate select-all">{route.value}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {lead.records.map((record) => (
          <a
            key={`${record.register}-${record.id}`}
            href={record.url}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(linkClass, "mt-1 text-[12px]")}
          >
            Official record: {record.label} <ExternalLink size={11} />
          </a>
        ))}
      </section>

      <section>
        <h4 className="mb-1 text-[12.5px] font-medium text-ink-2">Facts (each from a page or record)</h4>
        <dl className="flex flex-col gap-1.5">
          {lead.facts.map((fact) => (
            <div key={fact.name} className="grid grid-cols-[88px_1fr] gap-2">
              <dt className="text-ink-3 capitalize">{fact.name}</dt>
              <dd className="min-w-0">
                {fact.value ?? <span className="text-ink-3">Not stated</span>}
                {fact.quote && (
                  <q className="block truncate text-[11.5px] text-ink-3" title={fact.quote}>
                    {fact.quote}
                  </q>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-border p-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium">Your note</span>
          <textarea
            rows={2}
            maxLength={2000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => text !== lead.note && note.mutate({ leadId: lead.id, body: { note: text } })}
            className="rounded-lg border border-border bg-bg px-2.5 py-1.5 outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium">Why? (optional, helps the next scan)</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
            placeholder="e.g. too big for us, not our industry, too far"
            className="h-8 rounded-lg border border-border bg-bg px-2.5 outline-none focus:border-accent"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={lead.reaction === "up" ? "primary" : "ghost"}
            onClick={() => send(lead.reaction === "up" ? null : "up")}
          >
            <ThumbsUp size={13} /> Good lead
          </Button>
          <Button
            size="sm"
            variant={lead.reaction === "down" ? "primary" : "ghost"}
            onClick={() => send(lead.reaction === "down" ? null : "down")}
          >
            <ThumbsDown size={13} /> Not a fit
          </Button>
          <select
            aria-label="Column"
            value={lead.column}
            onChange={(event) =>
              move.mutate({ leadId: lead.id, body: { column: event.target.value as LeadColumn } })
            }
            className="ml-auto h-8 rounded-lg border border-border bg-bg px-2 text-[12.5px]"
          >
            {LEAD_COLUMNS.map((column) => (
              <option key={column} value={column}>
                {COLUMN_LABELS[column]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          {lead.kind === "quiet" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => watch.mutate({ leadId: lead.id, body: { watch: !lead.watch } })}
            >
              {lead.watch ? <EyeOff size={13} /> : <Eye size={13} />}{" "}
              {lead.watch ? "Stop watching" : "Watch for signs"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              window.confirm(
                `Forget ${lead.company} and never show it again? It goes on your do-not-contact list.`,
              ) && forget.mutate({ leadId: lead.id, body: { block: true } }, { onSuccess: onBack })
            }
          >
            <Trash2 size={13} /> Don't contact again
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              window.confirm(
                `Forget ${lead.company}? Its card and quotes are deleted; a later scan may find it again.`,
              ) && forget.mutate({ leadId: lead.id, body: { block: false } }, { onSuccess: onBack })
            }
          >
            Forget
          </Button>
        </div>
        {(forget.error ?? react.error) && (
          <p className="text-[12px] text-danger">{(forget.error ?? react.error)?.message}</p>
        )}
      </section>
    </div>
  );
}

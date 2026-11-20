import { ArrowLeft, ExternalLink, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

import { JOB_COLUMNS, type Bot, type JobCard, type JobColumn, type MatchVerdict } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { useMoveJob, useReactToJob } from "../../hooks/jobs";
import { cardCompany, cardTitle, COLUMN_LABELS, foundOn, uncheckedLine } from "../../lib/jobs";

const VERDICT: Record<MatchVerdict, [string, string]> = {
  meets: ["✅", "Meets"],
  partly: ["⚠️", "Partly"],
  misses: ["❌", "Misses"],
  unknown: ["❔", "Not stated"],
};

const READ_BY = {
  api: "the job system's list",
  text: "the page's text",
  browser: "the browser",
  visual: "the Visual helper",
  you: "you",
};

/** One job in full: every fact with the words it came from, the match line by line, warnings, and your reaction. */
export function JobDetails({ bot, card, onBack }: { bot: Bot; card: JobCard; onBack(): void }) {
  const react = useReactToJob(bot.id);
  const move = useMoveJob(bot.id);
  const [reason, setReason] = useState(card.reason ?? "");
  const send = (reaction: "up" | "down" | null) =>
    react.mutate({
      cardId: card.id,
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
        <h3 className="text-[15px] font-semibold">{cardTitle(card)}</h3>
        <p className="text-ink-2">{cardCompany(card)}</p>
        {card.summary && (
          <p className="mt-1 text-ink-3">
            <span className="text-[11.5px] font-medium">The Checker's summary: </span>
            {card.summary}
          </p>
        )}
        <a
          href={card.url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 inline-flex items-center gap-1 text-accent"
        >
          Open the posting <ExternalLink size={12} />
        </a>
        <p className="mt-1 text-[11.5px] text-ink-3">
          Read by {READ_BY[card.readBy]} · found {foundOn(card)} in scan {card.scan} · score {card.score}
        </p>
      </div>

      {uncheckedLine(card) && (
        <p className="rounded-xl border border-border bg-selected p-3 text-[12.5px]">{uncheckedLine(card)}</p>
      )}

      {card.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-xl border border-warning/40 bg-warning/10 p-3 text-[12.5px]">
          {card.warnings.map((warning) => (
            <li key={`${warning.id}-${warning.text}`}>⚠️ {warning.text}</li>
          ))}
        </ul>
      )}

      <section>
        <h4 className="mb-1 text-[12.5px] font-medium text-ink-2">Facts (each from the page)</h4>
        <dl className="flex flex-col gap-1.5">
          {card.facts.map((fact) => (
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

      <section>
        <h4 className="mb-1 text-[12.5px] font-medium text-ink-2">How it matches you</h4>
        <p className="mb-1.5 text-[11.5px] text-ink-3">
          Reasons are the Checker's own words, except those marked "checked by the app".
        </p>
        <ul className="flex flex-col gap-1.5">
          {card.match.map((line) => (
            <li key={line.requirement} className="flex gap-2">
              <span aria-label={VERDICT[line.verdict][1]}>{VERDICT[line.verdict][0]}</span>
              <span className="min-w-0">
                {line.requirement}
                {line.reason && (
                  <span className="block text-[12px] text-ink-3">
                    {line.reason}
                    {line.byCode && <span className="ml-1 text-[11px] italic">(checked by the app)</span>}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {card.company.length > 0 && (
        <section>
          <h4 className="mb-1 text-[12.5px] font-medium text-ink-2">About the company (from the posting)</h4>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {card.company.map((note) => (
              <li key={note.text} title={note.quote}>
                {note.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2 rounded-xl border border-border p-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium">Why? (optional, helps the next scan)</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
            placeholder="e.g. too junior, no on-call, love the 4-day week"
            className="h-8 rounded-lg border border-border bg-bg px-2.5 outline-none focus:border-accent"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={card.reaction === "up" ? "primary" : "ghost"}
            onClick={() => send(card.reaction === "up" ? null : "up")}
          >
            <ThumbsUp size={13} /> Good fit
          </Button>
          <Button
            size="sm"
            variant={card.reaction === "down" ? "primary" : "ghost"}
            onClick={() => send(card.reaction === "down" ? null : "down")}
          >
            <ThumbsDown size={13} /> Not for me
          </Button>
          <select
            aria-label="Column"
            value={card.column}
            onChange={(event) =>
              move.mutate({ cardId: card.id, body: { column: event.target.value as JobColumn } })
            }
            className={cn("ml-auto h-8 rounded-lg border border-border bg-bg px-2 text-[12.5px]")}
          >
            {JOB_COLUMNS.map((column) => (
              <option key={column} value={column}>
                {COLUMN_LABELS[column]}
              </option>
            ))}
          </select>
        </div>
      </section>
    </div>
  );
}

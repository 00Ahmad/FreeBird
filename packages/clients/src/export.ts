import type { Lead } from "@mrog/shared";

import { clientFact } from "./facts";
import { signalKind } from "./signals";

/** The board as CSV, for a spreadsheet or a CRM. Only what the bot found and checked, with its sources. */

const COLUMNS = [
  "Company",
  "Website",
  "Kind",
  "Score",
  "Column",
  "Place",
  "Size",
  "Industry",
  "Why now",
  "Sign date",
  "Contacts",
  "Ask for",
  "Source",
  "Warnings",
  "Your note",
] as const;

const KIND: Record<Lead["kind"], string> = { asking: "Asking now", signs: "With signs", quiet: "Quiet fit" };

/** A cell for CSV: quoted when it holds a comma, a quote or a line break; a leading = + - @ is made inert. */
export function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The board as CSV. `askFor`: the job titles of the people who buy what you sell (from your profile), the same on
 * every lead: who to ask for there, never a person looked up (6.1).
 */
export function leadsCsv(leads: readonly Lead[], askFor: readonly string[] = []): string {
  const rows = leads.map((lead) => {
    const top = lead.signals[0];
    return [
      lead.company,
      lead.domain,
      KIND[lead.kind],
      lead.score,
      lead.column,
      clientFact(lead.facts, "place"),
      clientFact(lead.facts, "size"),
      clientFact(lead.facts, "industry"),
      top ? `${signalKind(top.kind).label}: ${top.quote}` : null,
      top?.date ?? null,
      lead.contacts.map((c) => c.value).join(" | ") || null,
      askFor.join(" or ") || null,
      lead.url,
      lead.warnings.map((w) => w.text).join(" | ") || null,
      lead.note || null,
    ]
      .map(csvCell)
      .join(",");
  });
  return [COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

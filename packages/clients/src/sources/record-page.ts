import type { PageRead } from "@mrog/jobs";
import type { ClientFact, LeadRecord, LeadSignal } from "@mrog/shared";

import { daysSince } from "../dates";
import type { RegisterRecord } from "./types";

/**
 * A register record as a page, so the same checks run on it as on a web page: every fact a lead takes from a record
 * is quoted from this text, and the Checker reading a tender reads exactly this.
 */

const line = (label: string, value: string | null | undefined) => (value ? `${label}: ${value}` : null);

export function recordText(r: RegisterRecord): string {
  return [
    line(r.kind === "tender" ? "Buyer" : "Company", r.name),
    line("Tender", r.title),
    line("Address", r.place),
    line("Industry", r.industry),
    line("Industry codes", r.sicCodes.join(", ") || null),
    line("Incorporated", r.incorporated),
    line("Status", r.status),
    line("Published", r.published),
    line("Deadline", r.deadline),
    line("Value", r.value),
    r.description ? `\n${r.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function recordPage(r: RegisterRecord): PageRead {
  const text = recordText(r);
  return { url: r.url, title: r.title ?? r.name, text, links: [], reader: "api", humanCheck: false };
}

/** The lead's facts from a record, each quoted from the record's text. */
export function recordFacts(r: RegisterRecord): ClientFact[] {
  const text = recordText(r);
  const quoted = (label: string) => text.split("\n").find((l) => l.startsWith(`${label}: `)) ?? null;
  const name = quoted(r.kind === "tender" ? "Buyer" : "Company");
  return [
    { name: "company", value: r.name, quote: name },
    { name: "website", value: null, quote: null },
    { name: "place", value: r.place, quote: r.place ? quoted("Address") : null },
    { name: "size", value: null, quote: null },
    { name: "industry", value: r.industry, quote: r.industry ? quoted("Industry") : null },
    { name: "what", value: null, quote: null },
  ];
}

export function leadRecord(r: RegisterRecord, label: string): LeadRecord {
  return {
    register: r.register,
    id: r.id,
    url: r.url,
    label,
    deadline: r.deadline,
    status: r.status,
    incorporated: r.incorporated,
  };
}

/** Signs a record itself shows: a tender is asking now; a company incorporated in the last year is new. */
export function recordSignals(r: RegisterRecord, now: Date, foundAt: string): LeadSignal[] {
  if (r.kind === "tender" && r.title)
    return [{ kind: "asking", quote: `Tender: ${r.title}`, url: r.url, date: r.published, foundAt }];
  if (r.incorporated && daysSince(r.incorporated, now) <= 365)
    return [
      {
        kind: "new_company",
        quote: `Incorporated: ${r.incorporated}`,
        url: r.url,
        date: r.incorporated,
        foundAt,
      },
    ];
  return [];
}

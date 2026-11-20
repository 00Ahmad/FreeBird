import {
  DEFAULT_CLIENT_TARGET,
  LEAD_COLUMNS,
  type ClientFactName,
  type ClientProject,
  type ClientStatus,
  type ClueId,
  type ContactRoute,
  type Lead,
  type LeadColumn,
  type LeadKind,
  type ListName,
  type OfferProfile,
  type SignalKindId,
  type TraitId,
  type UpdateOfferInput,
} from "@mrog/shared";

export { scanTarget, scoreTone } from "./jobs";

/** Plain helpers for the Client Bot's screen; components only render what these work out. */

export const COLUMN_LABELS: Record<LeadColumn, string> = {
  new: "New",
  shortlisted: "Shortlisted",
  contacted: "Contacted",
  replied: "Replied",
  won: "Won",
  not_a_fit: "Not a fit",
};

export const KIND_LABELS: Record<LeadKind, string> = {
  asking: "Asking now",
  signs: "With signs",
  quiet: "Quiet fit",
};

export const SIGNAL_LABELS: Record<SignalKindId, string> = {
  asking: "Asking now",
  hiring: "Hiring for your work",
  first_hire: "Hiring a first role",
  funding: "Just raised money",
  new_company: "New company",
  expanding: "Expanding",
  growing: "Growing fast",
  unhappy: "Unhappy with their provider",
};

export const TRAIT_LABELS: Record<TraitId | "lookalike", string> = {
  has_staff: "Has staff",
  multi_site: "More than one site",
  regulated: "Regulated industry",
  seasonal: "Seasonal staff",
  international: "Staff in more than one country",
  lookalike: "Like your best clients",
};

export const CLUE_LABELS: Record<ClueId, string> = {
  old_copyright: "Old website",
  no_https: "No secure connection",
  free_email: "Email on a free provider",
  no_blog: "No blog or news",
  no_booking: "No online booking or ordering",
  orders_by_phone: "Orders by phone or email",
};

export const LIST_LABELS: Record<ListName, string> = {
  clients: "Your clients",
  competitors: "Competitors",
  doNotContact: "Do not contact",
};

export const CONTACT_LABELS: Record<ContactRoute["kind"], string> = {
  contact_page: "Contact page",
  email: "Business inbox",
  phone: "Phone",
  respond: "Respond here",
};

const BAND: Record<LeadKind, number> = { asking: 0, signs: 1, quiet: 2 };

/** The board's columns in order; in each, asking now first, then with signs, then quiet fits, best score first. */
export function boardColumns(leads: readonly Lead[]): { column: LeadColumn; leads: Lead[] }[] {
  return LEAD_COLUMNS.map((column) => ({
    column,
    leads: leads
      .filter((lead) => lead.column === column)
      .toSorted((a, b) => BAND[a.kind] - BAND[b.kind] || b.score - a.score),
  }));
}

/** Found by the latest scan. */
export const isNewLead = (lead: Lead, project: ClientProject) =>
  !!project.scan && lead.scan === project.scan.number;

/** Moved up (a watched quiet fit showed a sign) in the latest scan. */
export const movedUpNow = (lead: Lead, project: ClientProject) =>
  !!lead.movedUp && !!project.scan && lead.updatedAt >= project.scan.startedAt;

/** Its signs have faded: a lead you haven't acted on whose reason to call now has gone. */
export const goneStale = (lead: Lead) =>
  (lead.column === "new" || lead.column === "shortlisted") && lead.warnings.some((w) => w.id === "stale");

/** What changed with the latest scan, in a line ("Since the last scan: 3 new, 1 moved up, 2 gone stale"), or null. */
export function changesLine(project: ClientProject): string | null {
  const fresh = project.leads.filter((lead) => isNewLead(lead, project)).length;
  const up = project.leads.filter((lead) => movedUpNow(lead, project)).length;
  const stale = project.leads.filter(goneStale).length;
  const parts = [
    fresh > 0 && `${fresh} new`,
    up > 0 && `${up} moved up`,
    stale > 0 && `${stale} gone stale`,
  ].filter(Boolean);
  return parts.length > 0 ? `With the latest scan: ${parts.join(", ")}.` : null;
}

/** "Ask for the Finance Director or the Head of HR": who buys what you sell, from your profile (6.1). */
export function askForLine(profile: OfferProfile): string | null {
  const titles = profile.buyerTitles;
  if (titles.length === 0) return null;
  const named = titles.map((title) => `the ${title}`);
  return `Ask for ${named.length > 1 ? `${named.slice(0, -1).join(", ")} or ${named.at(-1)}` : named[0]}.`;
}

export const leadFact = (lead: Lead, name: ClientFactName) =>
  lead.facts.find((fact) => fact.name === name)?.value ?? null;

/** "today", "12 days ago", "in 5 days". */
export function ageText(date: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return "today";
  if (days < 0) return `in ${-days} day${days === -1 ? "" : "s"}`;
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const evidenceLabel = (id: string) =>
  TRAIT_LABELS[id as TraitId] ?? CLUE_LABELS[id as ClueId] ?? id.replace(/_/g, " ");

/** The one line under a lead's name: its strongest sign with its age, or for a quiet fit its strongest trait. */
export function leadLine(lead: Lead, now: Date): string {
  const sign = lead.signals[0];
  if (sign) return `${SIGNAL_LABELS[sign.kind]}${sign.date ? ` · ${ageText(sign.date, now)}` : ""}`;
  const parts = [
    leadFact(lead, "size") && `${leadFact(lead, "size")}`,
    lead.evidence[0] && evidenceLabel(lead.evidence[0].id),
  ];
  return parts.filter(Boolean).join(" · ") || leadFact(lead, "place") || lead.site;
}

export { evidenceLabel };

const STATUS_LINES: Record<ClientStatus, string> = {
  interview: "Tell me what you sell and who you sell it to",
  awaiting_profile: "Your profile is ready: approve it to start finding clients",
  ready: "Ready to scan",
  scanning: "Scanning",
  waiting_for_you: "Waiting for you",
  error: "The last scan failed",
};

export function statusLine(project: ClientProject): string {
  const scan = project.scan;
  if (project.status === "scanning" && scan)
    return `Scan ${scan.number}: ${scan.found} of ${scan.target} new leads (${scan.pagesRead} pages and records read)`;
  if (project.status === "waiting_for_you" && project.handoff) return project.handoff.reason;
  if (project.status === "ready" && scan?.stopReason) return `Last scan: ${scan.stopReason}`;
  return project.note ?? STATUS_LINES[project.status];
}

export const canScan = (project: ClientProject) => project.status === "ready" || project.status === "error";
export const isScanning = (project: ClientProject) =>
  project.status === "scanning" || project.status === "waiting_for_you";

export function clientComposer(
  project: ClientProject | undefined,
  name: string,
): { placeholder: string; hint: string } {
  if (!project) return { placeholder: `Message ${name}`, hint: "" };
  if (isScanning(project)) return { placeholder: `Say "stop" to end the scan`, hint: statusLine(project) };
  if (project.status === "ready" || project.status === "error")
    return {
      placeholder: `Ask ${name} to find clients, or tell it what to change in your profile`,
      hint: "",
    };
  return { placeholder: `Tell ${name} what you sell and who your ideal client is`, hint: "" };
}

export const suggestedTarget = (project: ClientProject | undefined) =>
  project?.lastTarget ?? DEFAULT_CLIENT_TARGET;

/** The profile's list fields, as the profile card edits them (one item per line). */
export const OFFER_LISTS = [
  ["areas", "Where you serve clients"],
  ["industries", "Your ideal client's industries (or “any”)"],
  ["buyerTitles", "Who buys it (job titles)"],
  ["mustHaves", "Must have"],
  ["excludeIndustries", "Industries to leave out"],
  ["excludePlaces", "Places to leave out"],
] as const satisfies readonly (readonly [keyof OfferProfile, string])[];

/** The change between the saved profile and what the card shows, or null when nothing changed. */
export function offerChange(saved: OfferProfile, edited: OfferProfile): UpdateOfferInput | null {
  const change: Record<string, unknown> = {};
  for (const key of Object.keys(edited) as (keyof OfferProfile)[])
    if (JSON.stringify(saved[key]) !== JSON.stringify(edited[key])) change[key] = edited[key];
  return Object.keys(change).length > 0 ? (change as UpdateOfferInput) : null;
}

/** A number box's text as a size limit: empty is no limit. */
export function sizeFrom(raw: string): number | null | "bad" {
  if (!raw.trim()) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : "bad";
}

/** The kinds of lead to look for, in order, from the three ticks; never none. */
export function kindsFrom(ticks: Record<LeadKind, boolean>): LeadKind[] {
  return (["asking", "signs", "quiet"] as const).filter((kind) => ticks[kind]);
}

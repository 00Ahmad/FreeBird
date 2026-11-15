import { MAX_WATCH_PER_SCAN, type Lead, type LeadSignal } from "@mrog/shared";

import { signalKind } from "./signals";

/** The watch list: quiet fits re-checked for new signs at the start of each scan you run, never on a timer. */

/** The watched quiet fits to re-check this scan: the longest unchecked first, at most MAX_WATCH_PER_SCAN. */
export function pickWatched(leads: readonly Lead[], max = MAX_WATCH_PER_SCAN): Lead[] {
  return leads
    .filter((lead) => lead.kind === "quiet" && lead.watch && lead.column !== "not_a_fit")
    .toSorted((a, b) => a.checkedAt.localeCompare(b.checkedAt))
    .slice(0, max);
}

/** Signs the lead didn't have yet (by kind and quote). */
export function newSignals(lead: Lead, found: LeadSignal[]): LeadSignal[] {
  const known = new Set(lead.signals.map((s) => `${s.kind}|${s.quote.toLowerCase()}`));
  return found.filter((s) => !known.has(`${s.kind}|${s.quote.toLowerCase()}`));
}

/** What changed, for the card: "Started hiring (2026-11-03)". */
export function movedUpText(signals: LeadSignal[]): string {
  const first = signals[0]!;
  const label = signalKind(first.kind).label;
  return first.date ? `${label} (${first.date})` : label;
}

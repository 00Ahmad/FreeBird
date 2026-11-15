import type { LeadKind, OfferProfile, SignalKindId } from "@mrog/shared";

import { playbookOf, serviceNamesOf } from "./playbooks";
import { anyIndustry } from "./profile";
import { placeOf } from "./region";
import { signalKind } from "./signals";

/**
 * Web searches built from the signs, by code: never just the name of what you sell, which finds your competitors.
 * Each round takes the next search of each sign, so later rounds look somewhere new.
 */

export interface PlannedSearch {
  query: string;
  /** The sign it looks for. */
  signal: SignalKindId;
}

export const MAX_CODE_SEARCHES = 8;

export function signalSearches(
  profile: OfferProfile,
  kinds: readonly LeadKind[],
  round: number,
  now: Date,
): PlannedSearch[] {
  const playbook = playbookOf(profile);
  const context = {
    playbook,
    serviceNames: serviceNamesOf(profile),
    place: placeOf(profile.areas),
    industry: anyIndustry(profile) ? "" : (profile.industries[0] ?? ""),
    year: now.getUTCFullYear(),
  };
  const wanted = profile.signals.filter((id) =>
    id === "asking" ? kinds.includes("asking") : kinds.includes("signs"),
  );
  const planned: PlannedSearch[] = [];
  for (const id of wanted) {
    const query = signalKind(id).searches(context)[round];
    if (query) planned.push({ query: query.replace(/\s+/g, " ").trim(), signal: id });
  }
  return planned.slice(0, MAX_CODE_SEARCHES);
}

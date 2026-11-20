import type { LeadKind, OfferProfile, SignalKindId } from "@mrog/shared";

import { playbookOf, serviceNamesOf } from "./playbooks";
import { anyIndustry } from "./profile";
import { placeOf, placesIn } from "./region";
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

/** The most searches code makes for a profile, in all. */
export const MAX_ALL_SEARCHES = 80;

/**
 * Every search code can make for the profile, in the order to run them (2.3): each sign's first search for each place
 * you serve and each industry of your clients, then each sign's second search, and so on. Before, only the first place
 * and the first industry were ever searched. The scan takes the next few not run lately, each round and each scan.
 */
export function allSignalSearches(
  profile: OfferProfile,
  kinds: readonly LeadKind[],
  now: Date,
): PlannedSearch[] {
  const playbook = playbookOf(profile);
  const serviceNames = serviceNamesOf(profile);
  const places = placesIn(profile.areas);
  const industries = anyIndustry(profile) ? [""] : profile.industries;
  const wanted = profile.signals.filter((id) =>
    id === "asking" ? kinds.includes("asking") : kinds.includes("signs"),
  );
  const planned: PlannedSearch[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < 4; round++)
    for (const place of places.length > 0 ? places : [""])
      for (const industry of industries)
        for (const id of wanted) {
          const query = signalKind(id).searches({
            playbook,
            serviceNames,
            place,
            industry,
            year: now.getUTCFullYear(),
          })[round];
          const tidy = query?.replace(/\s+/g, " ").trim();
          if (!tidy || seen.has(tidy.toLowerCase())) continue;
          seen.add(tidy.toLowerCase());
          planned.push({ query: tidy, signal: id });
        }
  return planned.slice(0, MAX_ALL_SEARCHES);
}

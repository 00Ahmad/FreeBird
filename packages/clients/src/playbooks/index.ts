import { fold, words } from "@mrog/jobs";
import type { OfferProfile, PlaybookId } from "@mrog/shared";

import { accounting } from "./accounting";
import { generic } from "./generic";
import { itSupport } from "./it-support";
import { marketing } from "./marketing";
import { payroll } from "./payroll";
import { recruitment } from "./recruitment";
import { software } from "./software";
import type { Playbook } from "./types";

export type { Playbook } from "./types";

/** Every playbook, the specific ones first; the generic one is the fallback. */
export const PLAYBOOKS: readonly Playbook[] = [
  payroll,
  accounting,
  marketing,
  software,
  itSupport,
  recruitment,
  generic,
];

export const playbookById = (id: PlaybookId): Playbook => PLAYBOOKS.find((p) => p.id === id) ?? generic;

/** Where the name of a service ends and who it's for, or how it's sold, begins. */
const SERVICE_ENDS = /\b(?:for|to|in|across|with)\b|[,.;:(]/;

/** The words that name the service itself: "IT support for accountants" → "it support". */
const serviceHead = (offer: string) => fold(offer).replace(LEAD_IN, "").split(SERVICE_ENDS)[0]!.trim();

const matching = (text: string) => PLAYBOOKS.find((p) => p !== generic && p.matches.test(text));

/**
 * The playbook for what you sell, picked by code from the words naming the service, not who it's for or how it's
 * sold: "IT support for accountants" is IT support, not accounting; "Office cleaning, book through our website" is
 * not software (1.7). Else the generic one.
 */
export function pickPlaybook(offer: string): Playbook {
  if (!fold(offer)) return generic;
  return matching(serviceHead(offer)) ?? generic;
}

/** The playbook a profile uses: the one you chose, else the one picked from what you sell. */
export const playbookOf = (profile: OfferProfile): Playbook =>
  profile.playbook ? playbookById(profile.playbook) : pickPlaybook(profile.offer);

/** How a sentence about what you sell starts, before the service's name ("We help restaurants with …"). */
const LEAD_IN =
  /^(we |i )?(sell|offer|provide|do|run|deliver|help with|help (\S+ ){1,3}with|specialise in|specialize in)\s+(their |your |the )?/;

/**
 * What a company asking for you would call your service: the playbook's names, or for any other service the first
 * few words of what you sell ("Commercial cleaning for offices" → "commercial cleaning").
 */
export function serviceNamesOf(profile: OfferProfile): string[] {
  const playbook = playbookOf(profile);
  if (playbook.serviceNames.length > 0) return playbook.serviceNames;
  const kept = words(serviceHead(profile.offer)).slice(0, 4).join(" ");
  return kept ? [kept] : [];
}

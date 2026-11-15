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

/** The playbook for what you sell, picked by code: the first whose words it names, else the generic one. */
export function pickPlaybook(offer: string): Playbook {
  const text = fold(offer);
  if (!text) return generic;
  return PLAYBOOKS.find((p) => p !== generic && p.matches.test(text)) ?? generic;
}

/** The playbook a profile uses: the one you chose, else the one picked from what you sell. */
export const playbookOf = (profile: OfferProfile): Playbook =>
  profile.playbook ? playbookById(profile.playbook) : pickPlaybook(profile.offer);

const LEAD_IN = /^(we )?(sell|offer|provide|do|run|deliver|help with|specialise in|specialize in)\s+/;

/**
 * What a company asking for you would call your service: the playbook's names, or for any other service the first
 * few words of what you sell ("Commercial cleaning for offices" → "commercial cleaning").
 */
export function serviceNamesOf(profile: OfferProfile): string[] {
  const playbook = playbookOf(profile);
  if (playbook.serviceNames.length > 0) return playbook.serviceNames;
  const offer = fold(profile.offer)
    .replace(LEAD_IN, "")
    .split(/\b(?:for|to|in|across|with)\b|[,.;:(]/)[0]!
    .trim();
  const kept = words(offer).slice(0, 4).join(" ");
  return kept ? [kept] : [];
}

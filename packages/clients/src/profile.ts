import { clip, unique } from "@mrog/jobs";
import { OfferProfile, type FitKind, type UpdateOfferInput } from "@mrog/shared";

import { playbookOf } from "./playbooks";

/** The offer profile's rules: merging edits, what a scan still needs, and the fit requirements it makes. */

export const emptyOffer = (): OfferProfile => OfferProfile.parse({});

const LIST_FIELDS = [
  "areas",
  "industries",
  "buyerTitles",
  "mustHaves",
  "excludeIndustries",
  "excludePlaces",
] as const;

/**
 * The profile with the edits applied. Lists are replaced whole, tidied (no repeats). When what you sell is first
 * given, or the playbook changes, the playbook's signals, traits, clues and buyers fill the lists you left empty.
 */
export function mergeOffer(base: OfferProfile, input: UpdateOfferInput): OfferProfile {
  const merged = OfferProfile.parse({ ...base, ...input });
  for (const field of LIST_FIELDS) merged[field] = unique(merged[field]);
  const before = playbookOf(base).id;
  const fresh = (!base.offer && !!merged.offer) || playbookOf(merged).id !== before;
  if (fresh) {
    const playbook = playbookOf(merged);
    if (input.signals === undefined) merged.signals = [...playbook.signals];
    if (input.traits === undefined) merged.traits = [...playbook.traits];
    if (input.clues === undefined) merged.clues = [...playbook.clues];
    if (input.buyerTitles === undefined && merged.buyerTitles.length === 0)
      merged.buyerTitles = [...playbook.buyerTitles];
  }
  if (merged.sizeMin !== null && merged.sizeMax !== null && merged.sizeMin > merged.sizeMax)
    throw new Error("the smallest size is bigger than the largest");
  return OfferProfile.parse(merged);
}

/** What a scan still needs, in plain words; empty when the profile is ready. */
export function missingForScan(profile: OfferProfile): string[] {
  const missing: string[] = [];
  if (!profile.offer) missing.push("what you sell");
  if (profile.areas.length === 0) missing.push("where you can serve clients");
  if (profile.industries.length === 0) missing.push("your ideal client's industry (or “any”)");
  if (profile.signals.length + profile.traits.length + profile.clues.length === 0)
    missing.push("at least one sign, trait or clue to look for");
  return missing;
}

export const anyIndustry = (profile: OfferProfile) =>
  profile.industries.length === 0 ||
  profile.industries.some((i) => /^(any|all|anything|any industry)$/i.test(i));

/** One part of your ideal client, as the Checker answers it. */
export interface FitRequirement {
  id: string;
  kind: FitKind;
  text: string;
}

export const MAX_FIT_REQUIREMENTS = 15;

/** The parts of your ideal client a company is checked against, numbered for the Checker. */
export function requirementsOf(profile: OfferProfile): FitRequirement[] {
  const parts: Omit<FitRequirement, "id">[] = [];
  if (!anyIndustry(profile))
    parts.push({ kind: "industry", text: `Works in one of: ${profile.industries.join(", ")}` });
  if (profile.areas.length > 0)
    parts.push({ kind: "place", text: `Based in, or can be served in: ${profile.areas.join(", ")}` });
  if (profile.sizeMin !== null || profile.sizeMax !== null)
    parts.push({ kind: "size", text: `Has ${sizeText(profile.sizeMin, profile.sizeMax)} staff` });
  if (profile.stages.length > 0)
    parts.push({ kind: "stage", text: `Is a ${profile.stages.join(" or ")} business` });
  for (const must of profile.mustHaves) parts.push({ kind: "must", text: must });
  return parts.slice(0, MAX_FIT_REQUIREMENTS).map((part, index) => ({ id: `r${index + 1}`, ...part }));
}

export function sizeText(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `${min} to ${max}`;
  if (min !== null) return `at least ${min}`;
  return `at most ${max}`;
}

/** The profile in plain lines, for the roles' tasks and the card. */
export function offerText(profile: OfferProfile): string {
  const lines: string[] = [];
  const playbook = playbookOf(profile);
  if (profile.offer) lines.push(`Sells: ${clip(profile.offer, 300)} (${playbook.label})`);
  if (profile.price) lines.push(`Price: ${profile.price}`);
  if (profile.areas.length > 0) lines.push(`Serves: ${profile.areas.join(", ")}`);
  if (profile.industries.length > 0) lines.push(`Ideal client's industry: ${profile.industries.join(", ")}`);
  if (profile.sizeMin !== null || profile.sizeMax !== null)
    lines.push(`Ideal client's size: ${sizeText(profile.sizeMin, profile.sizeMax)} staff`);
  if (profile.stages.length > 0) lines.push(`Ideal client's stage: ${profile.stages.join(", ")}`);
  if (profile.buyerTitles.length > 0) lines.push(`Buyers: ${profile.buyerTitles.join(", ")}`);
  if (profile.mustHaves.length > 0) lines.push(`Must have: ${profile.mustHaves.join("; ")}`);
  if (profile.excludeIndustries.length > 0) lines.push(`Not in: ${profile.excludeIndustries.join(", ")}`);
  if (profile.excludePlaces.length > 0) lines.push(`Not at: ${profile.excludePlaces.join(", ")}`);
  if (profile.signals.length > 0) lines.push(`Signs to look for: ${profile.signals.join(", ")}`);
  return lines.join("\n");
}

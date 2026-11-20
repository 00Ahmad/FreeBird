import { fold, words } from "@mrog/jobs";
import { MatchVerdict, type ClientFact, type FitKind, type FitLine, type OfferProfile } from "@mrog/shared";

import { clientFact } from "./facts";
import type { FitRequirement } from "./profile";
import { placesIn, servesAnywhere } from "./region";
import { stageVerdict, type StageEvidence } from "./stage";
import { staffOf, staffText } from "./staff";

/** How a company fits your ideal client, line by line. The Checker answers; code checks what it can. */

export interface ClaimedVerdict {
  id: string;
  verdict?: string;
  reason?: string;
}

const WEIGHTS: Record<FitKind, number> = { industry: 3, place: 3, size: 2, stage: 1, must: 2 };
const POINTS: Record<MatchVerdict, number> = { meets: 1, partly: 0.5, unknown: 0.3, misses: 0 };

const stem = (w: string) => (w.length > 3 ? w.replace(/(es|s)$/, "") : w);
/** Whether any of the phrases has all its words in the text. */
const names = (text: string, phrases: readonly string[]) => {
  const have = new Set(words(text).map(stem));
  return phrases.some((p) => {
    const want = words(p).map(stem);
    return want.length > 0 && want.every((w) => have.has(w));
  });
};

/** The size line, by code: the company's staff numbers against your range. */
function sizeVerdict(profile: OfferProfile, facts: ClientFact[]): Pick<FitLine, "verdict" | "reason"> | null {
  const stated = clientFact(facts, "size");
  const range = stated ? staffOf(stated) : null;
  if (!range) return null;
  const tooBig = profile.sizeMax !== null && range.min > profile.sizeMax;
  const tooSmall = profile.sizeMin !== null && range.max !== null && range.max < profile.sizeMin;
  if (tooBig)
    return { verdict: "misses", reason: `${staffText(range)} staff: more than your ${profile.sizeMax}.` };
  if (tooSmall)
    return { verdict: "misses", reason: `${staffText(range)} staff: fewer than your ${profile.sizeMin}.` };
  return { verdict: "meets", reason: `${staffText(range)} staff.` };
}

/** A line code can settle to "meets" from the facts (a place or industry the page names), or null. */
function codeMeets(kind: FitKind, profile: OfferProfile, facts: ClientFact[]): string | null {
  if (kind === "place") {
    if (servesAnywhere(profile.areas)) return "You serve clients anywhere.";
    const place = clientFact(facts, "place");
    return place && names(place, placesIn(profile.areas)) ? `Based in ${place}.` : null;
  }
  if (kind === "industry") {
    const about = [clientFact(facts, "industry"), clientFact(facts, "what")].filter(Boolean).join(" ");
    return about && names(about, profile.industries)
      ? `Works in ${clientFact(facts, "industry") ?? "your industry"}.`
      : null;
  }
  return null;
}

/**
 * One line per requirement. A verdict that isn't one is "unknown"; a "misses" without a reason is "unknown" (a small
 * model says misses when it means it couldn't tell); size is always worked out by code when the page states it.
 */
export function buildFit(
  requirements: FitRequirement[],
  claimed: ClaimedVerdict[],
  facts: ClientFact[],
  profile: OfferProfile,
  /** What settles the stage line by code, when known (6.2). */
  stage?: StageEvidence,
): FitLine[] {
  return requirements.map((requirement): FitLine => {
    const base = { kind: requirement.kind, requirement: requirement.text };
    // A line the app wrote is marked, so the Checker's own words can be told apart on the card (6.5).
    const app = { ...base, byCode: true };
    if (requirement.kind === "stage" && stage) {
      const byCode = stageVerdict(profile.stages, stage);
      if (byCode) return { ...app, ...byCode };
    }
    if (requirement.kind === "size") {
      const byCode = sizeVerdict(profile, facts);
      return {
        ...app,
        ...(byCode ?? { verdict: "unknown", reason: "The page doesn't say how many staff." }),
      };
    }
    const meets = codeMeets(requirement.kind, profile, facts);
    if (meets) return { ...app, verdict: "meets", reason: meets };
    const said = claimed.find((v) => v.id === requirement.id);
    const parsed = MatchVerdict.safeParse(said?.verdict?.trim().toLowerCase());
    const reason = said?.reason?.trim() ?? "";
    if (!said || !parsed.success) return { ...app, verdict: "unknown", reason: "Not checked." };
    if (parsed.data === "misses" && !reason)
      return { ...app, verdict: "unknown", reason: "Not shown on the page." };
    return reason
      ? { ...base, verdict: parsed.data, reason }
      : { ...app, verdict: parsed.data, reason: "Said so." };
  });
}

/** The fit score, 0 to 100, from the lines by weight; a company checked against nothing scores 60. */
export function scoreFit(lines: FitLine[]): number {
  const total = lines.reduce((sum, line) => sum + WEIGHTS[line.kind], 0);
  if (total === 0) return 60;
  const got = lines.reduce((sum, line) => sum + WEIGHTS[line.kind] * POINTS[line.verdict], 0);
  return Math.round((got / total) * 100);
}

/** An exclusion of yours the company falls under, by code ("Not in: gambling"), or null. */
export function excludedBy(facts: ClientFact[], profile: OfferProfile): string | null {
  const about = [clientFact(facts, "industry"), clientFact(facts, "what")].filter(Boolean).join(" ");
  const industry = profile.excludeIndustries.find((x) => about && names(about, [x]));
  if (industry) return `It is in ${industry}, which you excluded.`;
  const place = clientFact(facts, "place");
  const where = profile.excludePlaces.find((x) => place && names(place, [x]));
  if (where) return `It is in ${where}, which you excluded.`;
  return null;
}

/** Whether a page offers what you sell: the company is a competitor (words, by code). */
export const sellsIt = (text: string, sells: RegExp) => sells.test(fold(text));

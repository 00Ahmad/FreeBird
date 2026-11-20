import { fold } from "@mrog/jobs";
import { SUGGESTIBLE_OFFER_FIELDS, type Lead, type OfferProfile } from "@mrog/shared";

import { clientFact } from "./facts";
import { staffOf, staffRange } from "./staff";

/** Profile changes your reactions suggest. Only ever suggested: you accept or skip each one on the profile card. */

export interface Suggested {
  field: (typeof SUGGESTIBLE_OFFER_FIELDS)[number];
  value: string;
  because: string;
}

/** Turned down this many leads that share a size, and the bot suggests a size limit. */
export const SIZE_PATTERN = 3;

const TOO_BIG = /too (big|large)|too many (staff|people|employees)|enterprise|corporate/;
const TOO_SMALL = /too (small|tiny)|not enough (staff|people)|one[- ]person|sole trader/;
const WRONG_INDUSTRY =
  /industry|sector|don'?t work with|not our (market|type)|wrong (kind|type) of (business|company)/;
const WRONG_PLACE = /too far|wrong (place|area|city|region|country)|not our area|outside (our|my) area/;

/** A suggestion from one reaction with a reason, or from a pattern of 👎 on the board. */
export function suggestFrom(
  reaction: "up" | "down",
  reason: string,
  lead: Lead,
  profile: OfferProfile,
  board: readonly Lead[],
): Suggested | null {
  if (reaction !== "down") return null;
  const why = fold(reason);
  const size = staffOf(clientFact(lead.facts, "size") ?? "");
  const industry = clientFact(lead.facts, "industry");
  const place = clientFact(lead.facts, "place");
  if (TOO_BIG.test(why) && size && (profile.sizeMax === null || profile.sizeMax >= size.min))
    return {
      field: "sizeMax",
      value: String(Math.max(1, size.min - 1)),
      because: `You said ${lead.company} is too big.`,
    };
  if (
    TOO_SMALL.test(why) &&
    size &&
    size.max !== null &&
    (profile.sizeMin === null || profile.sizeMin <= size.max)
  )
    return {
      field: "sizeMin",
      value: String(size.max + 1),
      because: `You said ${lead.company} is too small.`,
    };
  if (
    WRONG_INDUSTRY.test(why) &&
    industry &&
    !profile.excludeIndustries.some((x) => fold(x) === fold(industry))
  )
    return {
      field: "excludeIndustries",
      value: industry,
      because: `You turned down ${lead.company} for its industry.`,
    };
  if (WRONG_PLACE.test(why) && place && !profile.excludePlaces.some((x) => fold(x) === fold(place)))
    return {
      field: "excludePlaces",
      value: place,
      because: `You turned down ${lead.company} for where it is.`,
    };
  return sizePattern(board, profile);
}

/**
 * A client size your price states (3.3): "£300 a month for up to 50 staff", "from 10 employees". Only when the price
 * says it in so many words, and only for a size your profile leaves open: a suggestion you accept or skip, never
 * applied by itself. A price that names no size suggests nothing.
 */
export function sizeFromPrice(profile: OfferProfile): Suggested[] {
  if (!profile.price) return [];
  const range = staffRange(profile.price);
  if (!range) return [];
  const because = `Your price says “${profile.price}”.`;
  const out: Suggested[] = [];
  if (profile.sizeMin === null && range.min > 1)
    out.push({ field: "sizeMin", value: String(range.min), because });
  if (profile.sizeMax === null && range.max !== null && range.max > 0)
    out.push({ field: "sizeMax", value: String(range.max), because });
  return out;
}

/** "You turned down 4 companies with over 200 staff": a size limit, once enough 👎 leads share a size. */
export function sizePattern(board: readonly Lead[], profile: OfferProfile): Suggested | null {
  const sizes = board
    .filter((lead) => lead.reaction === "down")
    .flatMap((lead) => {
      const range = staffOf(clientFact(lead.facts, "size") ?? "");
      return range ? [range.min] : [];
    });
  if (sizes.length < SIZE_PATTERN) return null;
  const smallest = Math.min(...sizes);
  const kept = board.some(
    (lead) => lead.reaction === "up" && (staffOf(clientFact(lead.facts, "size") ?? "")?.min ?? 0) >= smallest,
  );
  if (kept || smallest <= 1 || (profile.sizeMax !== null && profile.sizeMax < smallest)) return null;
  return {
    field: "sizeMax",
    value: String(smallest - 1),
    because: `You turned down ${sizes.length} companies with ${smallest} or more staff.`,
  };
}

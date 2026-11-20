import { addToLists, amounts, describeLists, itemSaid, keepItemsSaid, type TopicWords } from "@mrog/jobs";
import type { OfferProfile, UpdateOfferInput } from "@mrog/shared";

import { playbookOf } from "./playbooks";
import { sizeText } from "./profile";

/**
 * The Interviewer's change to the offer profile, made safe by code (4.4): list items are added, not a whole new list
 * ("also add law firms" sent as industries ["law firms"] wiped the others), items to take out are named apart, and
 * anything the user didn't say isn't saved. What changed is said back plainly, with the kind of service picked (1.7).
 */

export const OFFER_LISTS = [
  "areas",
  "industries",
  "buyerTitles",
  "mustHaves",
  "excludeIndustries",
  "excludePlaces",
] as const;
export type OfferList = (typeof OFFER_LISTS)[number];
export type OfferRemovals = Partial<Record<OfferList, string[]>>;

const LABELS: Record<OfferList, string> = {
  areas: "area",
  industries: "industry",
  buyerTitles: "buyer",
  mustHaves: "must-have",
  excludeIndustries: "industry to leave out",
  excludePlaces: "place to leave out",
};

/** The change with its list items added to the profile's (and `remove`'s taken out); other fields as sent. */
export const addToOffer = (
  base: OfferProfile,
  change: UpdateOfferInput,
  remove: OfferRemovals = {},
): UpdateOfferInput => addToLists(base, change, OFFER_LISTS, remove) as UpdateOfferInput;

/**
 * The change without what the user didn't say: list items sharing no word with their message, a staff number not in
 * it, and a price none of whose words or numbers are in it. `dropped` says what was left out.
 */
export function keepOfferSaid(
  change: UpdateOfferInput,
  heard: string,
): { change: UpdateOfferInput; dropped: string[] } {
  if (!heard.trim()) return { change, dropped: [] };
  const lists = keepItemsSaid(change, heard, OFFER_LISTS);
  const out = lists.change as UpdateOfferInput;
  const dropped = [...lists.dropped];
  const numbers = new Set(amounts(heard));
  for (const field of ["sizeMin", "sizeMax"] as const) {
    const value = change[field];
    if (value === undefined || value === null || numbers.has(value)) continue;
    dropped.push(`${field === "sizeMin" ? "at least" : "at most"} ${value} staff`);
    delete out[field];
  }
  if (change.price && !itemSaid(change.price, heard) && !amounts(change.price).some((n) => numbers.has(n))) {
    dropped.push(`the price "${change.price}"`);
    delete out.price;
  }
  // What you sell: in your words, and never the tool's own arguments (a 9B model wrote JSON into it).
  if (change.offer && (/^\s*[{[]/.test(change.offer) || !itemSaid(change.offer, heard))) {
    dropped.push(`what you sell: "${change.offer}"`);
    delete out.offer;
  }
  return { change: out, dropped };
}

/** What changed, in a few words each ("Added industry: law firms"), so a wrong save is seen at once. */
export function describeOfferChange(before: OfferProfile, after: OfferProfile): string[] {
  const lines = [];
  if (before.offer !== after.offer) lines.push(`Sells: ${after.offer || "nothing yet"}`);
  // The kind of service picks the signs, searches and competitor words: said, so a wrong pick is corrected at once.
  const kind = playbookOf(after);
  if (playbookOf(before).id !== kind.id && after.offer) lines.push(`Kind of service: ${kind.label}`);
  // Buyers filled in from the kind of service, not from what you said: one line, saying where they came from.
  const usualBuyers =
    before.buyerTitles.length === 0 &&
    after.buyerTitles.length > 0 &&
    after.buyerTitles.join() === kind.buyerTitles.join();
  const { buyerTitles: _buyers, ...rest } = LABELS;
  lines.push(...describeLists(before, after, usualBuyers ? (rest as typeof LABELS) : LABELS));
  if (usualBuyers) lines.push(`Buyers to ask for (usual for ${kind.label}): ${after.buyerTitles.join(", ")}`);
  if (before.price !== after.price) lines.push(`Price: ${after.price || "none"}`);
  if (before.sizeMin !== after.sizeMin || before.sizeMax !== after.sizeMax)
    lines.push(
      after.sizeMin === null && after.sizeMax === null
        ? "Size: any"
        : `Size: ${sizeText(after.sizeMin, after.sizeMax)} staff`,
    );
  if (JSON.stringify(before.stages) !== JSON.stringify(after.stages))
    lines.push(`Stage: ${after.stages.join(" or ") || "any"}`);
  return lines;
}

/** The Client Bot's interview topics, found by their words in the Interviewer's question (4.2, 4.3). */
export const OFFER_TOPICS: TopicWords<
  "offer" | "price" | "areas" | "industries" | "size" | "buyers" | "mustHaves" | "exclusions"
> = {
  offer: /\bwhat (do |would )?you (sell|offer|do)\b|\byour (service|offer|product)s?\b/,
  price: /\b(price|prices|pricing|charge|cost|fees?|rates?)\b/,
  areas: /\b(where|areas?|regions?|towns?|cit(y|ies)|countr(y|ies)|serve|locations?)\b/,
  industries: /\b(industr(y|ies)|sectors?|kinds? of (business|compan)|types? of (business|compan))/,
  size: /\b(size|how (big|large|many staff|many employees)|staff|employees|headcount)\b/,
  buyers: /\b(who buys|buyers?|decision[- ]makers?|job titles?|who (would|do) you (speak|talk))\b/,
  mustHaves: /\bmust[- ]haves?\b|\bmust have\b/,
  exclusions: /\b(leave out|exclude|avoid|rule out|not work with)\b/,
};

export const OFFER_TOPIC_NAMES: Record<keyof typeof OFFER_TOPICS, string> = {
  offer: "what they sell",
  price: "their price",
  areas: "where they serve",
  industries: "industries",
  size: "client size",
  buyers: "who buys",
  mustHaves: "must-haves",
  exclusions: "what to leave out",
};

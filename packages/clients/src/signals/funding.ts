import { fold } from "@mrog/jobs";

import type { SignalKind } from "./types";
import { largestSum } from "./words";

/** A funding round, named. */
const ROUND =
  /\bpre-?seed\b|\bseed (round|funding|investment|stage)\b|\bseries [a-e]\b|\bangel (round|investment|investors?)\b|\b(funding|investment) round\b|\bventure (capital|funding)\b|\bbacked by\b/;
const GOT =
  /\b(rais(e|ed|es|ing)|secur(e|ed|es|ing)|clos(e|ed|es|ing)|land(s|ed)?|receiv(e|ed|es)|won|award(ed)?)\b/;
/** Money raised for someone else. */
const CHARITY = /charit|hospice|donat|fundrais|sponsor|appeal|good cause|food ?bank|in aid of/;
/** The least a sum must be to count as money raised for the business. */
export const MIN_FUNDING = 10_000;

/**
 * Just raised money: new money is usually spent on growth, and growth needs help. A round named, or a sum of money
 * of some size with a word for getting it; never money raised for a charity ("We raised £500 for the hospice") or a
 * firm's name ("Grant Thornton").
 */
export const funding: SignalKind = {
  id: "funding",
  label: "Just raised money",
  strength: 0.6,
  freshForDays: 180,
  indicates: (quote) => {
    const t = fold(quote);
    if (CHARITY.test(t)) return false;
    return ROUND.test(t) || (GOT.test(t) && largestSum(t) >= MIN_FUNDING);
  },
  searches: ({ industry, place, year }) => [
    `${industry} ${place} "raised" seed OR "series a" ${year}`.replace(/\s+/g, " ").trim(),
  ],
};

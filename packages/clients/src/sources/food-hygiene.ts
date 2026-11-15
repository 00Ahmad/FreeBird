import { fold } from "@mrog/jobs";
import type { LeadEvidence } from "@mrog/shared";

import { anyIndustry } from "../profile";
import { isUkArea, placeOf } from "../region";
import { record, type Register, type RegisterRecord, type RegisterRequest } from "./types";

/**
 * The UK Food Standards Agency's food hygiene ratings: every inspected restaurant, café, pub, takeaway and hotel kitchen,
 * with its address. Open data, no key, Open Government Licence. It needs the header x-api-version: 2.
 */
const API = "https://api.ratings.food.gov.uk/Establishments";
const FOOD =
  /restaurant|cafe|café|takeaway|take-away|pubs?\b|bars?\b|hotel|food|hospitality|catering|caterer|bakery|bakeries/;
/** Restaurant/Cafe/Canteen: the one business type id checked against the live service. */
const RESTAURANTS = "1";

interface Establishment {
  FHRSID?: number;
  BusinessName?: string;
  BusinessType?: string;
  AddressLine1?: string;
  AddressLine2?: string;
  AddressLine3?: string;
  AddressLine4?: string;
  PostCode?: string;
  RatingDate?: string;
}

export const foodHygiene: Register = {
  id: "food-hygiene",
  label: "UK food hygiene ratings",
  country: "UK",
  finds: "quiet",
  needsKey: null,
  fits: (profile) =>
    isUkArea(profile.areas) &&
    placeOf(profile.areas) !== "" &&
    !anyIndustry(profile) &&
    profile.industries.some((i) => FOOD.test(fold(i))),
  queries: (profile) => [
    {
      words: profile.industries,
      place: placeOf(profile.areas),
      sicCodes: [],
      incorporatedFrom: null,
      incorporatedTo: null,
    },
  ],
  request(query) {
    const params = new URLSearchParams({ address: query.place, pageSize: "50", pageNumber: "1" });
    // Only restaurants and cafés by type; other food businesses are picked from the answer by their type's name.
    if (query.words.every((w) => /restaurant|cafe|café/.test(fold(w))))
      params.set("businessTypeId", RESTAURANTS);
    return {
      url: `${API}?${params}`,
      method: "GET",
      headers: { accept: "application/json", "x-api-version": "2" },
    };
  },
  parse(json) {
    const list = (json as { establishments?: unknown })?.establishments;
    if (!Array.isArray(list)) return [];
    return (list as Establishment[]).flatMap((e): RegisterRecord[] => {
      const name = e.BusinessName?.trim();
      if (!name || !e.FHRSID) return [];
      const place = [e.AddressLine1, e.AddressLine2, e.AddressLine3, e.AddressLine4, e.PostCode]
        .filter(Boolean)
        .join(", ");
      return [
        record({
          register: "food-hygiene",
          id: String(e.FHRSID),
          url: `https://ratings.food.gov.uk/business/${e.FHRSID}`,
          name,
          kind: "premises",
          place: place || null,
          industry: e.BusinessType?.trim() || null,
        }),
      ];
    });
  },
};

/** One food business looked up by name (and place), for its official record. */
export function premisesByName(name: string, place: string): RegisterRequest {
  const params = new URLSearchParams({ name, pageSize: "5", pageNumber: "1" });
  if (place) params.set("address", place);
  return {
    url: `${API}?${params}`,
    method: "GET",
    headers: { accept: "application/json", "x-api-version": "2" },
  };
}

/** Premises whose type is one of the industries you named (the answer may hold other food businesses). */
export function premisesFit(records: RegisterRecord[], industries: readonly string[]): RegisterRecord[] {
  const wanted = industries.map((i) => fold(i));
  return records.filter((r) => {
    const type = fold(r.industry ?? "");
    return wanted.some(
      (w) =>
        type.includes(w.replace(/s$/, "")) ||
        (/restaurant|cafe|café/.test(w) && /restaurant|cafe/.test(type)) ||
        (/pub|bar/.test(w) && /pub|bar|nightclub/.test(type)) ||
        (/takeaway|take-away/.test(w) && /takeaway/.test(type)) ||
        (/hotel/.test(w) && /hotel|guest house|bed/.test(type)),
    );
  });
}

/** Premises types that employ people: a restaurant, café, canteen, pub, bar, nightclub, hotel or takeaway. */
const STAFFED = /restaurant|cafe|café|canteen|pub|bar|nightclub|hotel|guest house|takeaway/;

/**
 * Your choice: a food business whose premises are on the food hygiene register, of a type that employs people, counts
 * as "has staff" when your profile looks for that trait. The card says why. Mobile caterers and "other" premises don't
 * count: they are often one person.
 */
export function staffFromPremises(premises: RegisterRecord, traits: readonly string[]): LeadEvidence | null {
  if (premises.register !== "food-hygiene" || !traits.includes("has_staff")) return null;
  const type = premises.industry ?? "";
  if (!STAFFED.test(fold(type)) || /mobile/i.test(type)) return null;
  return {
    kind: "trait",
    id: "has_staff",
    quote: `A ${type.toLowerCase()} on the food hygiene register`,
    url: premises.url,
  };
}

/** How many premises each business has in the answer: two or more is the multi-site trait, seen by code. */
export function premisesCount(records: RegisterRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(fold(r.name), (counts.get(fold(r.name)) ?? 0) + 1);
  return counts;
}

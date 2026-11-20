import { fold, words } from "@mrog/jobs";

import { isPlaceWord } from "./region";

/**
 * Whether two names are one company's, by code. Used everywhere a name is matched: a company's own site, its register
 * record, a lookalike client. Sharing one word isn't enough ("Brightside Kitchens" is not "Brightside Cleaning"), and a
 * place or a trade word means nothing on its own ("Leeds Kitchen Co" is not "Leeds Live").
 */

/** Words of a company's legal form, and filler. */
const LEGAL = new Set([
  "ltd",
  "limited",
  "llp",
  "plc",
  "inc",
  "co",
  "company",
  "group",
  "holdings",
  "the",
  "and",
  "of",
  "uk",
]);

/** Words that say what a business does or where: never enough to tell one company from another. */
const TRADE = new Set([
  "kitchen",
  "restaurant",
  "cafe",
  "café",
  "coffee",
  "bistro",
  "bar",
  "pub",
  "grill",
  "diner",
  "bakery",
  "catering",
  "caterer",
  "food",
  "cleaning",
  "cleaner",
  "care",
  "home",
  "clinic",
  "dental",
  "dentist",
  "salon",
  "hair",
  "beauty",
  "barber",
  "studio",
  "design",
  "digital",
  "media",
  "marketing",
  "agency",
  "consulting",
  "consultant",
  "consultancy",
  "accountant",
  "accounting",
  "law",
  "legal",
  "solicitor",
  "payroll",
  "recruitment",
  "it",
  "tech",
  "technology",
  "software",
  "system",
  "property",
  "propertie",
  "estate",
  "construction",
  "builder",
  "building",
  "plumbing",
  "electrical",
  "garage",
  "motor",
  "car",
  "auto",
  "hotel",
  "inn",
  "nursery",
  "school",
  "academy",
  "fitness",
  "gym",
  "printing",
  "logistic",
  "transport",
  "haulage",
  "security",
  "service",
  "solution",
  "partner",
  "associate",
  "news",
  "live",
  "online",
  "international",
  "global",
  "local",
  "north",
  "south",
  "east",
  "west",
  "city",
  "central",
]);

const stem = (word: string) => (word.length > 3 ? word.replace(/s$/, "") : word);

/** A name's words without its legal form ("The Cut & Craft Ltd" → cut, craft). */
const coreWords = (name: string | null | undefined): string[] =>
  words(name ?? "").filter((w) => !LEGAL.has(w));

const isTelling = (word: string) => !TRADE.has(stem(word)) && !isPlaceWord(word);

/** The words of a name that tell the company apart: not its legal form, a place or what it does. */
export const tellingWords = (name: string | null | undefined): string[] =>
  coreWords(name).filter(isTelling).map(stem);

/**
 * One company's two names: every word of the shorter name is in the longer one, and one of those words tells
 * companies apart (or the two names have the same words).
 */
export function sameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = new Set(coreWords(a).map(stem));
  const y = new Set(coreWords(b).map(stem));
  if (x.size === 0 || y.size === 0) return false;
  const [short, long] = x.size <= y.size ? [x, y] : [y, x];
  if (![...short].every((w) => long.has(w))) return false;
  return [...short].some(isTelling) || short.size === long.size;
}

/** Whether two places agree: they share a word, or one isn't known. */
export function placesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = words(a ?? "").filter((w) => w.length >= 3 && !/\d/.test(w));
  const y = new Set(words(b ?? "").filter((w) => w.length >= 3 && !/\d/.test(w)));
  if (x.length === 0 || y.size === 0) return true;
  return x.some((w) => y.has(w));
}

/** A register record is this company's: the same name, and the same place when both are known. */
export const sameRecord = (
  record: { name: string; place: string | null },
  name: string,
  place: string | null,
): boolean => sameCompany(record.name, name) && placesAgree(record.place, place);

/**
 * Whether a host's own name (its label, letters only) is built from this company's name: the whole name, or some of
 * its words including one that tells it apart, with at most a few letters left over ("thebrightside" for "Brightside
 * Kitchens", not "brightsidecleaning" or "leedslive").
 */
export function labelFitsName(label: string, name: string): boolean {
  const parts = coreWords(name).map((w) => fold(w).replace(/[^\p{L}\p{N}]/gu, ""));
  if (parts.length === 0 || label.length < 3) return false;
  if (label.includes(parts.join(""))) return true;
  const telling = parts.filter(isTelling);
  let rest = label;
  let removed = 0;
  let tellingRemoved = false;
  for (const part of parts.toSorted((p, q) => q.length - p.length)) {
    const found = [part, stem(part)].find((v) => v.length >= 2 && rest.includes(v));
    if (!found) continue;
    rest = rest.replace(found, "");
    removed += 1;
    if (isTelling(part)) tellingRemoved = true;
  }
  const enough = telling.length > 0 ? tellingRemoved : removed === parts.length;
  return enough && rest.length <= 3;
}

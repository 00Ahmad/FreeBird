import { amounts, fold, onPage, words, MAX_VALUE_CHARS } from "@mrog/jobs";
import { CLIENT_FACTS, type ClientFact, type ClientFactName } from "@mrog/shared";

import { staffOf } from "./staff";

/**
 * The check against made-up companies, as for jobs: no fact the Checker gives is kept unless its quote is really on
 * the page that was read, and the quote really says the value. A company whose name doesn't pass is not a lead.
 */

export interface ClaimedFact {
  name: string;
  value?: string | null;
  quote?: string | null;
}

export interface CheckedCompany {
  facts: ClientFact[];
  /** The company's name passed: only then can it be a lead. */
  confirmed: boolean;
  dropped: string[];
}

const stem = (word: string) => (word.length > 3 ? word.replace(/(es|s)$/, "") : word);

/** Most of the value's words are in the quote (all of them when it has one or two). */
export function quoteSays(value: string, quote: string): boolean {
  const wanted = words(value).map(stem);
  if (wanted.length === 0) return false;
  const have = new Set(words(quote).map(stem));
  const present = wanted.filter((w) => have.has(w)).length;
  return wanted.length <= 2 ? present === wanted.length : present / wanted.length >= 0.75;
}

/** The host a web address names ("https://www.brightside.co.uk/about" → brightside.co.uk), or null. */
export function hostIn(value: string): string | null {
  const raw = value.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function says(
  name: ClientFactName,
  value: string,
  quote: string,
  page: { url: string; text: string },
): boolean {
  switch (name) {
    case "size": {
      const range = staffOf(value);
      if (!range) return false;
      const quoted = new Set(amounts(quote));
      return quoted.has(range.min) || (range.max !== null && quoted.has(range.max));
    }
    case "website": {
      const host = hostIn(value);
      if (!host) return false;
      // The page's own address, or an address written on the page.
      return host === hostIn(page.url) || fold(page.text).includes(host);
    }
    default:
      return quoteSays(value, quote);
  }
}

/** A quote this short can stand as the value it says. */
export const SHORT_QUOTE = 80;

/**
 * The Checker's facts as a small model really writes them, made regular before any check: a fact with a quote and no
 * value takes a short quote as its value ("company": quote "Mumtaz Leeds"), and a company's name used as the fact's
 * label ("Cinnamon Kitchen Leeds") is the company, when that name is on the page. Every result is still checked.
 */
export function tidyClaims(page: string, claimed: ClaimedFact[]): ClaimedFact[] {
  const known = new Set<string>(CLIENT_FACTS);
  const tidy = claimed.map((fact): ClaimedFact => {
    const name = fact.name.trim().toLowerCase();
    const quote = fact.quote?.trim() ?? "";
    const value = fact.value?.trim() || (quote.length <= SHORT_QUOTE ? quote : "");
    return { name, value, quote };
  });
  const hasCompany = tidy.some((f) => f.name === "company" && f.value);
  const label = claimed.find(
    (f) => !known.has(f.name.trim().toLowerCase()) && f.name.length <= SHORT_QUOTE && onPage(page, f.name),
  );
  return hasCompany || !label
    ? tidy.filter((f) => known.has(f.name))
    : [
        { name: "company", value: label.name.trim(), quote: label.name.trim() },
        ...tidy.filter((f) => known.has(f.name) && f.name !== "company"),
      ];
}

/** Checks the Checker's facts against the page. A website needs no quote when it is the page's own address. */
export function checkCompanyFacts(
  page: { url: string; text: string },
  claimed: ClaimedFact[],
): CheckedCompany {
  const byName = new Map<string, ClaimedFact>();
  for (const fact of tidyClaims(page.text, claimed)) if (!byName.has(fact.name)) byName.set(fact.name, fact);
  const dropped: string[] = [];
  const facts = CLIENT_FACTS.map((name): ClientFact => {
    const fact = byName.get(name);
    const value = fact?.value?.trim() ?? "";
    const quote = fact?.quote?.trim() ?? "";
    if (!value) return { name, value: null, quote: null };
    const websiteHere = name === "website" && hostIn(value) !== null && says(name, value, quote, page);
    const problem =
      value.length > MAX_VALUE_CHARS
        ? "the value is too long"
        : websiteHere
          ? null
          : !quote
            ? "no quote"
            : !onPage(page.text, quote)
              ? "the quote isn't on the page"
              : !says(name, value, quote, page)
                ? "the quote doesn't say it"
                : null;
    if (problem) {
      dropped.push(`${name}: ${problem}`);
      return { name, value: null, quote: null };
    }
    return { name, value: name === "website" ? hostIn(value)! : value, quote: quote || null };
  });
  return { facts, confirmed: facts.some((f) => f.name === "company" && f.value !== null), dropped };
}

export const clientFact = (facts: ClientFact[], name: ClientFactName): string | null =>
  facts.find((fact) => fact.name === name)?.value ?? null;

/** Facts from two pages: each fact from the first page that states it. */
export function mergeFacts(first: ClientFact[], second: ClientFact[]): ClientFact[] {
  return CLIENT_FACTS.map(
    (name) =>
      first.find((f) => f.name === name && f.value !== null) ??
      second.find((f) => f.name === name && f.value !== null) ?? { name, value: null, quote: null },
  );
}

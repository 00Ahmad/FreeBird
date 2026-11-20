import { JOB_FACTS, type JobFact, type JobFactName } from "@mrog/shared";

import { fold, words } from "./text";

/**
 * The check against made-up jobs. A small model invents details, so no fact the Checker gives is kept unless the words
 * it quotes are really on the page that was read, and the quote really says the value: a real line with an invented
 * value attached ("£90,000" next to a quote that says £50,000) is refused. A fact that doesn't pass is "not stated".
 */

export const MIN_QUOTE_CHARS = 5;
export const MAX_QUOTE_CHARS = 400;
export const MAX_VALUE_CHARS = 200;

export interface ClaimedFact {
  name: string;
  value?: string | null;
  quote?: string | null;
}

export interface CheckedFacts {
  /** Every fact, in order; one that didn't pass has a null value and quote. */
  facts: JobFact[];
  /** The title and the company both passed: only then is it shown as a job. */
  confirmed: boolean;
  /** Why facts were dropped, for the activity log. */
  dropped: string[];
}

/** Amounts as numbers, reading "55k", "55,000", "55 000" and "55.000" all as 55000. */
export function amounts(text: string): number[] {
  const found: number[] = [];
  for (const match of fold(text).matchAll(/(\d[\d,. ]*\d|\d)\s*(k|m)?(?![\p{L}])/gu)) {
    const raw = match[1]!.replace(/[ ,]/g, "");
    // "55.000" is a thousands separator, "55.5" a decimal.
    const value = /\.\d{3}$/.test(raw) ? Number(raw.replace(/\./g, "")) : Number(raw);
    if (!Number.isFinite(value)) continue;
    const scale = match[2] === "k" ? 1000 : match[2] === "m" ? 1_000_000 : 1;
    found.push(Math.round(value * scale));
  }
  return found;
}

const WORKPLACE_WORDS: Record<string, RegExp> = {
  remote: /remote|work from home|working from home|wfh|home[- ]based|anywhere/,
  hybrid: /hybrid/,
  office: /on[- ]?site|in[- ]office|office[- ]based|in the office|in person/,
};

/** The workplace a value names, or null. */
export function workplaceOf(value: string): string | null {
  const folded = fold(value);
  if (/hybrid/.test(folded)) return "hybrid";
  if (/remote|home/.test(folded)) return "remote";
  if (/office|site|person/.test(folded)) return "office";
  return null;
}

const stem = (word: string) => (word.length > 3 ? word.replace(/(es|s)$/, "") : word);

/** Most of the value's words are in the quote: all of them when it has one or two. */
function wordsSupported(value: string, quote: string): boolean {
  const wanted = words(value).map(stem);
  if (wanted.length === 0) return false;
  const have = new Set(words(quote).map(stem));
  const present = wanted.filter((word) => have.has(word)).length;
  return wanted.length <= 2 ? present === wanted.length : present / wanted.length >= 0.75;
}

/** Whether the quote says the value. */
export function supports(name: JobFactName, value: string, quote: string): boolean {
  switch (name) {
    case "salary": {
      const said = amounts(value);
      const quoted = new Set(amounts(quote));
      return said.length > 0 && said.every((amount) => quoted.has(amount));
    }
    case "workplace": {
      const kind = workplaceOf(value);
      return kind !== null && WORKPLACE_WORDS[kind]!.test(fold(quote));
    }
    case "posted": {
      const said = amounts(value);
      if (said.length > 0) {
        const quoted = new Set(amounts(quote));
        return said.every((amount) => quoted.has(amount));
      }
      return wordsSupported(value, quote);
    }
    default:
      return wordsSupported(value, quote);
  }
}

/** Whether the quote is long enough and appears on the page, compared the way a person reads it. */
export function onPage(page: string, quote: string): boolean {
  const folded = fold(quote);
  return folded.length >= MIN_QUOTE_CHARS && folded.length <= MAX_QUOTE_CHARS && fold(page).includes(folded);
}

/** Checks the Checker's facts against the page text. Unknown fact names and repeats are ignored. */
export function checkFacts(page: string, claimed: ClaimedFact[]): CheckedFacts {
  const byName = new Map<string, ClaimedFact>();
  for (const fact of claimed) if (!byName.has(fact.name)) byName.set(fact.name, fact);
  const dropped: string[] = [];
  const facts = JOB_FACTS.map((name): JobFact => {
    const fact = byName.get(name);
    const value = fact?.value?.trim() ?? "";
    const quote = fact?.quote?.trim() ?? "";
    if (!value) return { name, value: null, quote: null };
    const problem =
      value.length > MAX_VALUE_CHARS
        ? "the value is too long"
        : !quote
          ? "no quote"
          : !onPage(page, quote)
            ? "the quote isn't on the page"
            : !supports(name, value, quote)
              ? "the quote doesn't say it"
              : null;
    if (problem) {
      dropped.push(`${name}: ${problem}`);
      return { name, value: null, quote: null };
    }
    return { name, value, quote };
  });
  const passed = (name: JobFactName) => facts.some((fact) => fact.name === name && fact.value !== null);
  return { facts, confirmed: passed("title") && passed("company"), dropped };
}

export interface QuotedNote {
  text: string;
  quote: string;
}

/** Notes (about the company) whose quote is on the page and shares a word with the note; the rest are dropped. */
export function checkNotes(page: string, notes: { text?: string; quote?: string }[], max = 5): QuotedNote[] {
  const kept: QuotedNote[] = [];
  for (const note of notes) {
    const text = note.text?.trim() ?? "";
    const quote = note.quote?.trim() ?? "";
    if (!text || text.length > MAX_VALUE_CHARS || !onPage(page, quote)) continue;
    const quoteWords = new Set(words(quote).map(stem));
    if (!words(text).some((word) => quoteWords.has(stem(word)))) continue;
    kept.push({ text, quote });
    if (kept.length === max) break;
  }
  return kept;
}

/** A fact's value, or null when it is not stated. */
export const factValue = (facts: JobFact[], name: JobFactName): string | null =>
  facts.find((fact) => fact.name === name)?.value ?? null;

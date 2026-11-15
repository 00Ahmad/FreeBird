import { fold } from "@mrog/jobs";

/** Reading the date of an event the way a page writes it, so a signal's age is worked out by code. */

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH = `(${MONTHS.map((m) => (m === "september" ? "september|sept|sep" : `${m}|${m.slice(0, 3)}`)).join("|")})\\.?`;
const monthOf = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.slice(0, 3)));

const DAY_MS = 86_400_000;
const iso = (date: Date) => date.toISOString().slice(0, 10);

function make(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day)
    return null;
  return iso(date);
}

/**
 * The date a piece of text names (yyyy-mm-dd), or null. Reads ISO dates, UK-style 12/03/2026, "12 March 2026",
 * "March 12, 2026", "March 2026" (the 1st), and "3 days ago", "2 weeks ago", "yesterday", "today". A date after `now`
 * is kept (a tender's deadline); one before 1990 is not a date of anything recent.
 */
export function parseDate(text: string, now: Date): string | null {
  const t = fold(text);
  let found: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})/.exec(t))) found = make(+m[1]!, +m[2]! - 1, +m[3]!);
  else if ((m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(t))) found = make(+m[3]!, +m[2]! - 1, +m[1]!);
  else if ((m = new RegExp(`\\b(\\d{1,2})(st|nd|rd|th)? (of )?${MONTH},? (\\d{4})\\b`).exec(t)))
    found = make(+m[5]!, monthOf(m[4]!), +m[1]!);
  else if ((m = new RegExp(`\\b${MONTH} (\\d{1,2})(st|nd|rd|th)?,? (\\d{4})\\b`).exec(t)))
    found = make(+m[4]!, monthOf(m[1]!), +m[2]!);
  else if ((m = new RegExp(`\\b${MONTH},? (\\d{4})\\b`).exec(t))) found = make(+m[2]!, monthOf(m[1]!), 1);
  else if ((m = /\b(\d{1,3}|an?|one) (day|week|month|year)s? ago\b/.exec(t))) {
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : 1;
    const days = { day: 1, week: 7, month: 30, year: 365 }[m[2] as "day"] * n;
    found = iso(new Date(now.getTime() - days * DAY_MS));
  } else if (/\byesterday\b/.test(t)) found = iso(new Date(now.getTime() - DAY_MS));
  else if (/\btoday\b|\bjust now\b|\bhours? ago\b/.test(t)) found = iso(now);
  if (!found || found < "1990-01-01") return null;
  return found;
}

/** Whole days from `date` (yyyy-mm-dd) to `now`; negative for a date still to come. */
export function daysSince(date: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);
}

/** Years from `date` to `now`, rounded down. */
export const yearsSince = (date: string, now: Date) => Math.floor(daysSince(date, now) / 365.25);

/** `days` before `now`, as yyyy-mm-dd. */
export const daysBefore = (now: Date, days: number) => iso(new Date(now.getTime() - days * DAY_MS));

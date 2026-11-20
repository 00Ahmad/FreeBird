import { factValue } from "../source-check";
import { fold } from "../text";
import type { WarningRule } from "./types";

/** Older than this, a posting may be filled already, or a "ghost job" that stays up without anyone hiring. */
export const OLD_POSTING_DAYS = 45;

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DAY_MS = 86_400_000;

const daysTo = (now: Date, year: number, month: number, day: number): number | null => {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return Math.floor((now.getTime() - date.getTime()) / DAY_MS);
};

/** A day and month with no year: this year, or last year when this year's would still be to come. */
function withoutYear(now: Date, month: number, day: number): number | null {
  const days = daysTo(now, now.getUTCFullYear(), month, day);
  if (days === null) return null;
  return days >= 0 ? days : daysTo(now, now.getUTCFullYear() - 1, month, day);
}

/**
 * How many days ago the posting went up, from what it says ("30+ days ago", "2 months ago", "1 September 2026",
 * "Posted May 5"). A date without a year is this year's (or last year's if this year's is still to come), never
 * 2001's; a date like 03/04/2026 that reads two ways counts as the newer of the two, so it warns only when both are
 * old. Null when it can't tell.
 */
export function daysSincePosted(posted: string, now: Date): number | null {
  const text = fold(posted);
  const ago = /(\d+)\+?\s*(day|week|month|year)s?\s+ago/.exec(text);
  if (ago) return Number(ago[1]) * UNIT_DAYS[ago[2]!]!;
  if (/\b(today|just posted|yesterday|hours? ago)\b/.test(text)) return 0;
  const clamp = (days: number | null) => (days === null ? null : Math.max(0, days));
  let m: RegExpExecArray | null;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text))) return clamp(daysTo(now, +m[1]!, +m[2]! - 1, +m[3]!));
  if ((m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(text))) {
    const year = +m[3]!;
    const readings = [daysTo(now, year, +m[2]! - 1, +m[1]!), daysTo(now, year, +m[1]! - 1, +m[2]!)].filter(
      (days): days is number => days !== null,
    );
    return readings.length > 0 ? clamp(Math.min(...readings)) : null;
  }
  const named =
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`).exec(text) ??
    null;
  const namedFirst = named
    ? null
    : new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`).exec(text);
  if (named) {
    const [, day, month, year] = named;
    const index = MONTHS.indexOf(month!);
    return clamp(year ? daysTo(now, +year, index, +day!) : withoutYear(now, index, +day!));
  }
  if (namedFirst) {
    const [, month, day, year] = namedFirst;
    const index = MONTHS.indexOf(month!);
    return clamp(year ? daysTo(now, +year, index, +day!) : withoutYear(now, index, +day!));
  }
  return null;
}

export const oldPosting: WarningRule = {
  id: "old-posting",
  check({ facts, now }) {
    const posted = factValue(facts, "posted");
    const days = posted ? daysSincePosted(posted, now) : null;
    return days !== null && days > OLD_POSTING_DAYS
      ? `Posted about ${days} days ago: it may be filled already, or a job that stays up without anyone hiring.`
      : null;
  },
};

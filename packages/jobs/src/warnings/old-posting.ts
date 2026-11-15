import { factValue } from "../source-check";
import { fold } from "../text";
import type { WarningRule } from "./types";

/** Older than this, a posting may be filled already, or a "ghost job" that stays up without anyone hiring. */
export const OLD_POSTING_DAYS = 45;

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

/** How many days ago the posting went up, from what it says ("30+ days ago", "2 months ago", "1 September 2026"). */
export function daysSincePosted(posted: string, now: Date): number | null {
  const text = fold(posted);
  const ago = /(\d+)\+?\s*(day|week|month|year)s?\s+ago/.exec(text);
  if (ago) return Number(ago[1]) * UNIT_DAYS[ago[2]!]!;
  if (/\b(today|just posted|yesterday|hours? ago)\b/.test(text)) return 0;
  const date = Date.parse(posted.replace(/^\s*(posted|published|date posted)\s*:?\s*/i, ""));
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.floor((now.getTime() - date) / 86_400_000));
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

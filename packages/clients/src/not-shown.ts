import type { NotShown } from "@mrog/shared";

import { daysSince } from "./dates";
import { companyPrints } from "./identity";

/**
 * Companies looked at and not shown: a quiet fit that didn't clear the bar, with why and when. Kept apart from the
 * companies shown to you, so one turned down once ("its own website wasn't found") isn't ignored for good: a later
 * scan judges it again when it shows a real sign, or once NOT_SHOWN_DAYS have passed (1.8).
 */

export const NOT_SHOWN_DAYS = 30;

const shares = (entry: NotShown, prints: readonly string[]) => entry.prints.some((p) => prints.includes(p));

/** The fresh entry for this company, or null: it was turned down lately, so a quiet look at it can wait. */
export function notShownFor(
  list: readonly NotShown[],
  company: { name: string | null; domain: string | null },
  now: Date,
): NotShown | null {
  const prints = companyPrints(company);
  if (prints.length === 0) return null;
  return (
    list.find((entry) => shares(entry, prints) && daysSince(entry.at.slice(0, 10), now) < NOT_SHOWN_DAYS) ??
    null
  );
}

/** The list with this company remembered as not shown (replacing an older entry for it), keeping the last `max`. */
export function rememberNotShown(
  list: readonly NotShown[],
  company: { name: string; domain: string | null },
  reason: string,
  now: Date,
  max: number,
): NotShown[] {
  const prints = companyPrints(company);
  if (prints.length === 0) return [...list];
  const others = list.filter((entry) => !shares(entry, prints));
  return [...others, { prints, name: company.name, reason, at: now.toISOString() }].slice(-max);
}

/** The list without this company: it was shown after all. */
export function clearNotShown(
  list: readonly NotShown[],
  company: { name: string | null; domain: string | null },
): NotShown[] {
  const prints = companyPrints(company);
  return list.filter((entry) => !shares(entry, prints));
}

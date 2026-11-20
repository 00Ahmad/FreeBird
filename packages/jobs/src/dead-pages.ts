import type { DeadPage } from "@mrog/shared";

import { canonicalUrl } from "./dedupe";

/**
 * Pages that led nowhere, remembered across scans: searches return much the same pages each time, and reading one
 * again costs a Checker turn for nothing. A page that may change (not a job today) is skipped for a month; one that
 * won't come back (a missing page, a closed job) for a year. A list of jobs is never remembered here: new jobs appear
 * on it.
 */

export const DEAD_DAYS = 30;
export const LASTING_DEAD_DAYS = 365;
const DAY_MS = 86_400_000;

/** The keys of the pages still to skip, as `pickLeads` reads its skip set (`u:` and the tidied address). */
export function deadKeys(pages: readonly DeadPage[], now: Date): string[] {
  return pages
    .filter(
      (page) => now.getTime() - Date.parse(page.at) < (page.lasting ? LASTING_DEAD_DAYS : DEAD_DAYS) * DAY_MS,
    )
    .map((page) => `u:${page.key}`);
}

/** The list with this page added (replacing an older entry for it), keeping the newest `max`. */
export function rememberDead(
  pages: readonly DeadPage[],
  url: string,
  reason: string,
  lasting: boolean,
  now: Date,
  max: number,
): DeadPage[] {
  const key = canonicalUrl(url);
  if (!key) return [...pages];
  return [...pages.filter((page) => page.key !== key), { key, reason, at: now.toISOString(), lasting }].slice(
    -max,
  );
}

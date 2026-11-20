import type { JobProfile } from "@mrog/shared";

import { titleFits } from "./match";
import type { PageLink } from "./page";
import { fold } from "./text";

/**
 * Picking the jobs worth reading from a list, by code: a job system's list holds every job a company has (GitLab's
 * had 246), and a model reading it as text sees only the first part of it and names at most ten. Code checks every
 * title, so none is missed and no model turn is spent.
 */

/** Jobs queued from one list in one scan: enough for the number asked for, never the whole page budget. */
export const listPickLimit = (target: number) => Math.min(15, Math.max(5, target * 2));

/** Whether a job's place suits the profile: a place you named, or remote work when you want it. */
function placeFits(place: string | undefined, profile: JobProfile): boolean {
  if (!place) return false;
  const where = fold(place);
  if (profile.workplace.includes("remote") && /\b(remote|anywhere|worldwide)\b/.test(where)) return true;
  return profile.places.some((wanted) => where.includes(fold(wanted)));
}

/**
 * The links of a list whose job title is one you want (or a related one), those in a place that suits you first, at
 * most `limit`. Empty when none fits: then nothing on the list is your kind of job.
 */
export function pickFromList(links: readonly PageLink[], profile: JobProfile, limit: number): string[] {
  const titles = [...profile.titles, ...profile.relatedTitles];
  return links
    .map((link, index) => ({ link, index }))
    .filter(({ link }) => titles.some((title) => titleFits(link.text, title)))
    .toSorted(
      (a, b) =>
        Number(placeFits(b.link.place, profile)) - Number(placeFits(a.link.place, profile)) ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map(({ link }) => link.url);
}

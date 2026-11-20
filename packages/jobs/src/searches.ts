import type { JobProfile } from "@mrog/shared";

/**
 * Searches aimed at companies' own job systems. Job boards mostly block automated reading (in live runs whole scans
 * were spent on them), while postings on these systems read cleanly, and two of them have a public job list. These
 * come from the profile by code, so they don't depend on a small model choosing them.
 */
export const CAREER_SITES = [
  "greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "myworkdayjobs.com",
] as const;

/** Where to look, in search words: "remote", the first place, or both. */
function whereWords(profile: JobProfile): string {
  const remote = profile.workplace.includes("remote") ? "remote" : "";
  return [remote, profile.places[0] ?? ""].filter(Boolean).join(" ");
}

/**
 * The first must-have when it is a short keyword (a language or tool, like "Python"): without it, searches return
 * jobs with the right title in any language, and a scan spends its pages on them.
 */
function keyword(profile: JobProfile): string {
  const first = profile.mustHaves[0]?.replace(/"/g, "").trim() ?? "";
  return first && first.length <= 20 && first.split(/\s+/).length <= 2 ? first : "";
}

/**
 * One search per career site for the first job title, with the first short must-have and where, e.g.
 * `"Backend Engineer" Python remote UK site:jobs.lever.co`.
 */
export function careerSearches(profile: JobProfile, sites: readonly string[] = CAREER_SITES): string[] {
  const title = profile.titles[0];
  if (!title) return [];
  const words = [keyword(profile), whereWords(profile)].filter(Boolean).join(" ");
  return sites.map((site) =>
    [`"${title.replace(/"/g, "")}"`, words, `site:${site}`].filter(Boolean).join(" "),
  );
}

/** How long a search run in one scan isn't run again by a later one: the results would mostly be the same pages. */
export const SEARCH_REPEAT_DAYS = 14;
/** Code-made searches one round runs: the four job systems' worth. */
export const CODE_SEARCHES_PER_ROUND = 4;

/**
 * Every search code can make from the profile, in the order to run them: each wanted or related title, each where
 * ("remote", then each place), each job system, so later rounds and later scans look somewhere new instead of running
 * the first title in the first place again. At most 60.
 */
export function codeSearches(profile: JobProfile, sites: readonly string[] = CAREER_SITES): string[] {
  const titles = [...profile.titles, ...profile.relatedTitles];
  const wheres = [...(profile.workplace.includes("remote") ? ["remote"] : []), ...profile.places];
  const kw = keyword(profile);
  const out: string[] = [];
  for (const title of titles)
    for (const where of wheres.length > 0 ? wheres : [""])
      for (const site of sites) {
        const words = [kw, where].filter(Boolean).join(" ");
        out.push([`"${title.replace(/"/g, "")}"`, words, `site:${site}`].filter(Boolean).join(" "));
      }
  return [...new Set(out)].slice(0, 60);
}

/** The searches run within SEARCH_REPEAT_DAYS, lower-cased, so a later scan doesn't run them again. */
export function recentSearches(runs: readonly { query: string; at: string }[], now: Date): string[] {
  return runs
    .filter((run) => now.getTime() - Date.parse(run.at) < SEARCH_REPEAT_DAYS * 86_400_000)
    .map((run) => run.query.toLowerCase());
}

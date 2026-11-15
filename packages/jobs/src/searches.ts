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

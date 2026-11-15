import type { JobProfile, ProfileSuggestion } from "@mrog/shared";

import { fold } from "./text";

export type Suggestion = Omit<ProfileSuggestion, "id">;

/**
 * A change to the profile that a reaction suggests. It is only ever offered: you accept it on the profile card or not.
 * 👎 "not at Acme" (the job's company) → avoid the company; 👎 "no fintech" / "too junior" → a deal-breaker;
 * 👍 with a reason → a nice-to-have. Null when there is nothing to learn or the profile already has it.
 */
export function suggestFrom(
  reaction: "up" | "down",
  reason: string,
  job: { company: string | null },
  profile: JobProfile,
): Suggestion | null {
  const said = reason.replace(/\s+/g, " ").trim().slice(0, 120);
  if (said.length < 3) return null;
  const text = fold(said);
  const has = (list: string[], value: string) => list.some((item) => fold(item) === fold(value));

  if (reaction === "up") {
    return has(profile.niceToHaves, said)
      ? null
      : { field: "niceToHaves", value: said, because: `You liked a job because: ${said}` };
  }
  if (job.company && text.includes(fold(job.company))) {
    return has(profile.avoidCompanies, job.company)
      ? null
      : { field: "avoidCompanies", value: job.company, because: `You said: ${said}` };
  }
  const industry = /^(no|not|avoid|never)\s+(.+?)\s+(industry|sector|companies)$/.exec(text);
  if (industry) {
    const value = industry[2]!;
    return has(profile.avoidIndustries, value)
      ? null
      : { field: "avoidIndustries", value, because: `You said: ${said}` };
  }
  const value = said.replace(/^(no|not|avoid|never)\s+/i, "");
  return has(profile.dealBreakers, value)
    ? null
    : { field: "dealBreakers", value, because: `You turned down a job because: ${said}` };
}

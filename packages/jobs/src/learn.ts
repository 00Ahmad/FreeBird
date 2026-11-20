import type { JobProfile, ProfileSuggestion } from "@mrog/shared";

import { amounts } from "./source-check";
import { fold } from "./text";
import { currencyOf, periodOf } from "./verdicts";

export type Suggestion = Omit<ProfileSuggestion, "id">;

/**
 * A change to the profile that a reaction suggests. It is only ever offered: you accept it on the profile card or not.
 * 👎 "not at Acme" (the job's company) → avoid the company; 👎 "too junior" → the seniority you want; 👎 "salary too
 * low" → a lowest salary above this job's; 👎 "no fintech industry" → an industry to avoid; other 👎 → a deal-breaker;
 * 👍 with a reason → a nice-to-have. Null when there is nothing to learn or the profile already has it.
 */
export function suggestFrom(
  reaction: "up" | "down",
  reason: string,
  job: { company: string | null; salary?: string | null },
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
  // The common reasons that are about a field of their own, not a deal-breaker: seniority and pay.
  const level = /\btoo (junior|senior|entry[- ]level)\b|\b(not senior enough|too much responsibility)\b/.exec(
    text,
  );
  if (level) {
    const value = /junior|entry|not senior/.test(level[0]) ? "Senior" : "Mid-level";
    return fold(profile.seniority) === fold(value)
      ? null
      : { field: "seniority", value, because: `You said: ${said}` };
  }
  if (
    /\b(salary|pay|money)\b.{0,20}\b(too )?(low|little)\b|\bpays? (too )?(little|low)\b|\bunderpaid\b/.test(
      text,
    )
  ) {
    const top = job.salary ? Math.max(0, ...amounts(job.salary)) : 0;
    const currency = job.salary ? currencyOf(job.salary) : null;
    const floor = profile.minSalary;
    // Above what this job pays, in its currency (or yours); a job that doesn't say gives nothing to go by.
    if (top <= 0 || (floor && floor.amount > top)) return null;
    const period = (job.salary && periodOf(job.salary)) ?? floor?.period ?? "year";
    const value = `${top + 1} ${currency ?? floor?.currency ?? "GBP"} ${period}`;
    return { field: "minSalary", value, because: `You said: ${said}` };
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

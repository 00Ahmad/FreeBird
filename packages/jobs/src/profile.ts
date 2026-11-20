import { JobProfile, type RequirementKind, type UpdateJobProfileInput } from "@mrog/shared";

import { unique } from "./text";

const LIST_FIELDS = [
  "titles",
  "relatedTitles",
  "mustHaves",
  "niceToHaves",
  "dealBreakers",
  "places",
  "avoidIndustries",
  "avoidCompanies",
  "languages",
] as const;

/** An empty profile: what a new Job Bot starts with. */
export const emptyProfile = (): JobProfile => JobProfile.parse({});

/**
 * The profile with a change applied. A field in the change replaces that field (a list is sent whole, so an item
 * can be taken out); repeats in a list are dropped. Throws when the result breaks a limit (too many items, too long).
 */
export function mergeProfile(base: JobProfile, change: UpdateJobProfileInput): JobProfile {
  const next: Record<string, unknown> = { ...base, ...change };
  for (const field of LIST_FIELDS) {
    const list = next[field];
    if (Array.isArray(list)) next[field] = unique(list.map((item) => String(item).trim()).filter(Boolean));
  }
  if (Array.isArray(next.workplace)) next.workplace = [...new Set(next.workplace as string[])];
  return JobProfile.parse(next);
}

/** What the profile still needs before a scan can start, in words for the user; empty when it is ready. */
export function missingForApproval(profile: JobProfile): string[] {
  const missing: string[] = [];
  if (profile.titles.length === 0) missing.push("the job titles you want");
  if (profile.workplace.length === 0 && profile.places.length === 0)
    missing.push("where you'd work (remote, hybrid or office, and which places)");
  return missing;
}

const salaryText = (salary: NonNullable<JobProfile["minSalary"]>) =>
  `${salary.amount.toLocaleString("en-US")} ${salary.currency} a ${salary.period}`;

/** The profile as plain lines, for a role's task and for the chat. Empty fields are left out. */
export function profileText(profile: JobProfile): string {
  const lines: string[] = [];
  const add = (label: string, value: string | string[]) => {
    const text = Array.isArray(value) ? value.join("; ") : value;
    if (text) lines.push(`- ${label}: ${text}`);
  };
  add("Job titles", profile.titles);
  add("Also goes by", profile.relatedTitles);
  add("Seniority", profile.seniority);
  add("Workplace", profile.workplace);
  add("Places", profile.places);
  add("Travel", profile.travel);
  if (profile.minSalary) add("Lowest salary", salaryText(profile.minSalary));
  add("Must have", profile.mustHaves);
  add("Nice to have", profile.niceToHaves);
  add("Deal-breakers", profile.dealBreakers);
  add("Right to work", profile.rightToWork);
  add("Industries to avoid", profile.avoidIndustries);
  add("Companies to avoid", profile.avoidCompanies);
  add("Languages", profile.languages);
  add("Experience", profile.experience);
  return lines.join("\n");
}

export interface Requirement {
  id: string;
  kind: RequirementKind;
  text: string;
  /** For the title requirement: the titles you want, which code checks the job's quoted title against. */
  titles?: string[];
  /** A company to avoid: decided by code from the job's confirmed company, never sent to the Checker. */
  company?: string;
  /** For the workplace requirement: the workplaces you want, which code checks the confirmed workplace against. */
  workplaces?: JobProfile["workplace"];
  /** For the salary requirement: your lowest, which code checks the confirmed salary against. */
  floor?: NonNullable<JobProfile["minSalary"]>;
}

/** At most this many requirements go to the Checker: a small model loses track of a longer list. */
export const MAX_REQUIREMENTS = 30;

/**
 * Every requirement for the Checker, most important first, so the ones cut at MAX_REQUIREMENTS are the least
 * important: the kind of job, where and how much, then deal-breakers and industries to avoid (a job that has one is
 * never a match), then seniority, right to work and must-haves, nice-to-haves last.
 */
function forChecker(profile: JobProfile): Omit<Requirement, "id">[] {
  const list: Omit<Requirement, "id">[] = [];
  if (profile.titles.length > 0) {
    const related =
      profile.relatedTitles.length > 0 ? ` (or related: ${profile.relatedTitles.join(", ")})` : "";
    // The kind of work, not the exact words: a small model otherwise fails "Senior Software Engineer (Python)" for
    // "Senior Backend Engineer".
    list.push({
      kind: "title",
      text: `Same kind of job as: ${profile.titles.join(", ")}${related} (another title for the same work counts)`,
      titles: [...profile.titles, ...profile.relatedTitles],
    });
  }
  if (profile.workplace.length > 0)
    list.push({
      kind: "workplace",
      text: `Workplace: ${profile.workplace.join(" or ")}`,
      workplaces: profile.workplace,
    });
  if (profile.places.length > 0) {
    const travel = profile.travel ? ` (${profile.travel})` : "";
    list.push({ kind: "place", text: `In or open to: ${profile.places.join(", ")}${travel}` });
  }
  if (profile.minSalary)
    list.push({
      kind: "salary",
      text: `Pays at least ${salaryText(profile.minSalary)}`,
      floor: profile.minSalary,
    });
  for (const item of profile.dealBreakers) list.push({ kind: "dealbreaker", text: `Free of: ${item}` });
  for (const item of profile.avoidIndustries)
    list.push({ kind: "dealbreaker", text: `Not in the ${item} industry` });
  if (profile.seniority) list.push({ kind: "must", text: `Seniority: ${profile.seniority}` });
  if (profile.rightToWork)
    list.push({ kind: "must", text: `Works with your right to work: ${profile.rightToWork}` });
  for (const item of profile.mustHaves) list.push({ kind: "must", text: item });
  for (const item of profile.niceToHaves) list.push({ kind: "nice", text: item });
  if (profile.languages.length > 0)
    list.push({ kind: "nice", text: `Languages: ${profile.languages.join(", ")}` });
  return list;
}

/**
 * The profile as a numbered list of requirements, each with its kind (which sets its weight in the score). The
 * Checker answers the first MAX_REQUIREMENTS by id; companies to avoid are added after them and decided by code, so
 * they never take a place in that list. For a deal-breaker, "meets" means the job is free of it.
 */
export function requirementsOf(profile: JobProfile): Requirement[] {
  const checked = forChecker(profile)
    .slice(0, MAX_REQUIREMENTS)
    .map((item, index) => ({ id: `r${index + 1}`, ...item }));
  const companies = profile.avoidCompanies.map((company, index): Requirement => ({
    id: `c${index + 1}`,
    kind: "dealbreaker",
    text: `Not at ${company}`,
    company,
  }));
  return [...checked, ...companies];
}

/** How many of the profile's requirements don't fit in what the Checker is asked (the least important ones). */
export const requirementsLeftOut = (profile: JobProfile) =>
  Math.max(0, forChecker(profile).length - MAX_REQUIREMENTS);

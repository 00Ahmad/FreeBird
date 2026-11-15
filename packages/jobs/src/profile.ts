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
}

/** At most this many requirements go to the Checker: a small model loses track of a longer list. */
export const MAX_REQUIREMENTS = 30;

/**
 * The profile as a numbered list of requirements the Checker answers one by one, each with its kind (which sets its
 * weight in the score). For a deal-breaker, "meets" means the job is free of it.
 */
export function requirementsOf(profile: JobProfile): Requirement[] {
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
  if (profile.seniority) list.push({ kind: "must", text: `Seniority: ${profile.seniority}` });
  if (profile.workplace.length > 0)
    list.push({ kind: "workplace", text: `Workplace: ${profile.workplace.join(" or ")}` });
  if (profile.places.length > 0) {
    const travel = profile.travel ? ` (${profile.travel})` : "";
    list.push({ kind: "place", text: `In or open to: ${profile.places.join(", ")}${travel}` });
  }
  if (profile.minSalary)
    list.push({ kind: "salary", text: `Pays at least ${salaryText(profile.minSalary)}` });
  if (profile.rightToWork)
    list.push({ kind: "must", text: `Works with your right to work: ${profile.rightToWork}` });
  for (const item of profile.mustHaves) list.push({ kind: "must", text: item });
  for (const item of profile.dealBreakers) list.push({ kind: "dealbreaker", text: `Free of: ${item}` });
  for (const item of profile.avoidIndustries)
    list.push({ kind: "dealbreaker", text: `Not in the ${item} industry` });
  for (const item of profile.avoidCompanies) list.push({ kind: "dealbreaker", text: `Not at ${item}` });
  for (const item of profile.niceToHaves) list.push({ kind: "nice", text: item });
  if (profile.languages.length > 0)
    list.push({ kind: "nice", text: `Languages: ${profile.languages.join(", ")}` });
  return list.slice(0, MAX_REQUIREMENTS).map((item, index) => ({ id: `r${index + 1}`, ...item }));
}

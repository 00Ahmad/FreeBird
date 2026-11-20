import type { JobProfile, UpdateJobProfileInput } from "@mrog/shared";

import { addToLists, describeLists, keepItemsSaid } from "./list-change";
import { amounts } from "./source-check";

/**
 * The Interviewer's change to the profile, made safe by code. A small model told "also add Go" sends the must-haves as
 * just ["Go"]; read as a whole new list, that wiped the others. So list items are added, items to take out are named
 * separately, and anything the user didn't say (an invented salary, a skill never mentioned) isn't saved.
 */

export const PROFILE_LISTS = [
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
export type ProfileList = (typeof PROFILE_LISTS)[number];

export type ProfileRemovals = Partial<Record<ProfileList, string[]>>;

/** The profile with the change's list items added (and `remove`'s taken out); other fields replace what was there. */
export const addToProfile = (
  base: JobProfile,
  change: UpdateJobProfileInput,
  remove: ProfileRemovals = {},
): UpdateJobProfileInput => addToLists(base, change, PROFILE_LISTS, remove) as UpdateJobProfileInput;

/**
 * The change without what the user didn't say: list items sharing no word with their message, and a lowest salary whose
 * amount isn't in it. `dropped` says what was left out, for the Interviewer and the activity list.
 */
export function keepWhatWasSaid(
  change: UpdateJobProfileInput,
  heard: string,
): { change: UpdateJobProfileInput; dropped: string[] } {
  if (!heard.trim()) return { change, dropped: [] };
  const lists = keepItemsSaid(change, heard, PROFILE_LISTS);
  const out = lists.change;
  const dropped = lists.dropped;
  if (change.minSalary) {
    const heardAmounts = new Set(amounts(heard));
    if (!heardAmounts.has(Math.round(change.minSalary.amount))) {
      dropped.push(`a lowest salary of ${change.minSalary.amount}`);
      delete out.minSalary;
    }
  }
  return { change: out as UpdateJobProfileInput, dropped };
}

const LABELS: Record<ProfileList, string> = {
  titles: "title",
  relatedTitles: "related title",
  mustHaves: "must-have",
  niceToHaves: "nice-to-have",
  dealBreakers: "deal-breaker",
  places: "place",
  avoidIndustries: "industry to avoid",
  avoidCompanies: "company to avoid",
  languages: "language",
};

/** What changed, in a few words each ("Added must-have: Go"), so a wrong save is seen at once. */
export function describeChange(before: JobProfile, after: JobProfile): string[] {
  const lines = describeLists(before, after, LABELS);
  if (JSON.stringify(before.workplace) !== JSON.stringify(after.workplace))
    lines.push(`Workplace: ${after.workplace.join(" or ") || "none"}`);
  if (JSON.stringify(before.minSalary) !== JSON.stringify(after.minSalary))
    lines.push(
      after.minSalary
        ? `Lowest salary: ${after.minSalary.amount.toLocaleString("en-US")} ${after.minSalary.currency} a ${after.minSalary.period}`
        : "Lowest salary: none",
    );
  for (const field of ["seniority", "travel", "rightToWork", "experience"] as const)
    if (before[field] !== after[field])
      lines.push(
        `${field === "rightToWork" ? "Right to work" : field[0]!.toUpperCase() + field.slice(1)}: ${after[field] || "none"}`,
      );
  return lines;
}

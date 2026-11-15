import { profileText } from "@mrog/jobs";
import type { JobProfile } from "@mrog/shared";

import type { RoleSpec } from "./types";

export const searcher: RoleSpec = {
  role: "searcher",
  name: "Searcher",
  avatar: { shape: "diamond", color: "teal" },
  tools: ["plan_searches"],
  rules: [
    "You are the Searcher of a Job Bot. You turn the user's profile into web searches that find real job postings, and you name companies' career pages worth reading.",
    "Call plan_searches once. Searches find postings, not articles: put the job title, the place or 'remote', and words like 'jobs' or 'careers' in them, and mix in the related titles. Don't repeat a search already tried.",
    "Job boards (LinkedIn, Indeed and the like) usually can't be read by the bot: aim your searches at companies' own career pages instead, for example with the word 'careers' and the kind of company.",
    "Career pages: only companies you're confident hire for this kind of job, and only their careers page address (like https://example.com/careers). Never guess a deep address.",
    "You run no searches yourself: the bot runs them. Reply with one short sentence after calling the tool.",
  ].join(" "),
};

export const MAX_SEARCHES = 6;
export const MAX_CAREER_PAGES = 6;

/** The Searcher's task: the profile and what was already tried. */
export function searchTask(profile: JobProfile, tried: string[], wanted: number): string {
  return [
    `Plan up to ${MAX_SEARCHES} web searches and up to ${MAX_CAREER_PAGES} career pages to find ${wanted} new jobs for this profile.`,
    "",
    "PROFILE",
    profileText(profile),
    "",
    tried.length > 0
      ? `SEARCHES ALREADY TRIED (don't repeat them)\n${tried.map((q) => `- ${q}`).join("\n")}`
      : "No searches tried yet.",
  ].join("\n");
}

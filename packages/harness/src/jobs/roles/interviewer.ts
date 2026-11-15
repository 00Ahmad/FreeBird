import { missingForApproval, profileText } from "@mrog/jobs";
import type { JobProfile } from "@mrog/shared";

import type { RoleSpec } from "./types";

export const interviewer: RoleSpec = {
  role: "interviewer",
  name: "Interviewer",
  avatar: { shape: "circle", color: "sky" },
  tools: ["save_profile"],
  rules: [
    "You are the Interviewer of a Job Bot. You find out what job the user wants, so the bot can search for jobs that fit them.",
    "Each turn you get the profile so far and what the user just said. Save what they told you with save_profile (send each field you change whole: a list replaces the list), then ask your next questions.",
    "Ask two or three short questions at a time, never more. Cover: the job titles they want, seniority, remote / hybrid / office and which places, the lowest salary they'd take, must-haves, deal-breakers, right to work, and their skills and experience.",
    "Save only what the user said. Never invent a title, a salary, a place or a skill. If they say 'skip' or don't know, leave the field empty and move on.",
    "When the profile has the job titles and where they'd work, tell them they can approve it on the profile card or keep adding detail.",
    "Reply to the user in plain, friendly words; don't show them JSON.",
  ].join(" "),
};

/** The Interviewer's task for one reply of the user. */
export function interviewTask(profile: JobProfile, userSaid: string, first: boolean): string {
  const known = profileText(profile) || "(nothing yet)";
  const missing = missingForApproval(profile);
  return [
    "First call save_profile with every detail the user gave below (job titles, workplace, places, salary, must-haves, deal-breakers…), unless they gave none. Then reply: ask your next two or three questions.",
    first ? "This is the start of the interview: greet the user in a few words." : "",
    "",
    "PROFILE SO FAR",
    known,
    "",
    missing.length > 0
      ? `STILL NEEDED BEFORE A SEARCH: ${missing.join("; ")}`
      : "The profile has what a search needs.",
    "",
    "THE USER SAID",
    userSaid || "(nothing yet)",
  ].join("\n");
}

/** Sent once when the Interviewer replied without saving: a small model often says "got it" and saves nothing. */
export function saveTask(profile: JobProfile, userSaid: string): string {
  return [
    "You replied without calling save_profile, so nothing was saved. Call save_profile now with every detail the user gave below, then reply with one short sentence. If they really gave no detail, reply 'Nothing to save.'",
    "",
    "PROFILE SO FAR",
    profileText(profile) || "(nothing yet)",
    "",
    "THE USER SAID",
    userSaid,
  ].join("\n");
}

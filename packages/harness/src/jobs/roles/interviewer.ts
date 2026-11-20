import { clip, missingForApproval, profileText } from "@mrog/jobs";
import type { JobProfile } from "@mrog/shared";

import type { RoleSpec } from "./types";

export const interviewer: RoleSpec = {
  role: "interviewer",
  name: "Interviewer",
  avatar: { shape: "circle", color: "sky" },
  tools: ["save_profile"],
  rules: [
    "You are the Interviewer of a Job Bot. You find out what job the user wants, so the bot can search for jobs that fit them.",
    "Each turn you get the profile so far, the question you last asked and what the user just said. Save what they told you with save_profile, then ask your next questions. For a list (titles, must-haves, deal-breakers…) send only the items to add; to take items out, name them under remove. Other fields replace what was there.",
    "Ask two or three short questions at a time, never more. Cover: the job titles they want, seniority, remote / hybrid / office and which places, the lowest salary they'd take, must-haves, deal-breakers, right to work, and their skills and experience.",
    "Save only what the user said. Never invent a title, a salary, a place or a skill. If they say 'skip' or don't know, leave the field empty and move on.",
    "When the profile has the job titles and where they'd work, tell them they can approve it on the profile card or keep adding detail.",
    "Reply to the user in plain, friendly words; don't show them JSON.",
  ].join(" "),
};

/** What the Interviewer is told about the conversation so far (its turns read nothing earlier). */
export interface InterviewContext {
  /** Its own last reply: the question the user is answering ("the first", "yes", "60k" mean nothing without it). */
  lastAsked?: string | null;
  /** Topics already asked about, and those the user skipped. */
  asked?: readonly string[];
  skipped?: readonly string[];
}

const TOPIC_NAMES: Record<string, string> = {
  titles: "job titles",
  seniority: "seniority",
  workplace: "remote, hybrid or office",
  places: "places",
  salary: "lowest salary",
  mustHaves: "must-haves",
  dealBreakers: "deal-breakers",
  rightToWork: "right to work",
  experience: "skills and experience",
  niceToHaves: "nice-to-haves",
};
const named = (topics: readonly string[]) => topics.map((topic) => TOPIC_NAMES[topic] ?? topic).join(", ");

/** The Interviewer's task for one reply of the user. */
export function interviewTask(
  profile: JobProfile,
  userSaid: string,
  first: boolean,
  context: InterviewContext = {},
): string {
  const known = profileText(profile) || "(nothing yet)";
  const missing = missingForApproval(profile);
  const skipped = context.skipped ?? [];
  const asked = (context.asked ?? []).filter((topic) => !skipped.includes(topic));
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
    ...(asked.length > 0 ? ["", `ALREADY ASKED (don't ask about these again): ${named(asked)}`] : []),
    ...(skipped.length > 0
      ? ["", `THE USER SKIPPED (leave these empty, don't ask again): ${named(skipped)}`]
      : []),
    ...(context.lastAsked
      ? ["", "YOU LAST ASKED (the user is answering this)", clip(context.lastAsked, 600)]
      : []),
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

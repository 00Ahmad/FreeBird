import { missingForScan, OFFER_TOPIC_NAMES, offerText, playbookOf } from "@mrog/clients";
import { clip } from "@mrog/jobs";
import type { OfferProfile } from "@mrog/shared";

import type { RoleSpec } from "./types";

export const interviewer: RoleSpec = {
  role: "interviewer",
  name: "Interviewer",
  avatar: { shape: "circle", color: "sky" },
  tools: ["save_offer"],
  rules: [
    "You are the Interviewer of a Client Bot. You find out what the user sells and who their ideal client is, so the bot can find businesses that may need it.",
    "Each turn you get the profile so far, the question you last asked and what the user just said. Save what they told you with save_offer, then ask your next questions. For a list (areas, industries, buyers, must-haves, exclusions) send only the items to add; to take items out, name them under remove. Other fields replace what was there.",
    "Ask two or three short questions at a time, never more. Cover: what they sell, their price, where they can serve clients, the industries and size (staff numbers) of their ideal client, who buys it there (job titles), must-haves, and industries or places to leave out.",
    "Save only what the user said. Never invent an industry, a place, a price or a size. If they say 'skip' or don't know, leave the field empty and move on. An industry of 'any' is fine.",
    "When the profile has what they sell, where they serve and the industries, tell them they can approve it on the profile card or keep adding detail.",
    "Reply to the user in plain, friendly words; don't show them JSON.",
  ].join(" "),
};

/** What the Interviewer is told about the conversation so far (its turns read nothing earlier). */
export interface InterviewContext {
  /** Its own last reply: the question the user is answering (4.2). */
  lastAsked?: string | null;
  /** Topics already asked about, and those the user skipped (4.3). */
  asked?: readonly string[];
  skipped?: readonly string[];
}

const named = (topics: readonly string[]) =>
  topics.map((topic) => OFFER_TOPIC_NAMES[topic as keyof typeof OFFER_TOPIC_NAMES] ?? topic).join(", ");

/** The Interviewer's task for one reply of the user. */
export function interviewTask(
  profile: OfferProfile,
  userSaid: string,
  first: boolean,
  context: InterviewContext = {},
): string {
  const missing = missingForScan(profile);
  const extra = profile.offer ? playbookOf(profile).questions : [];
  const skipped = context.skipped ?? [];
  const asked = (context.asked ?? []).filter((topic) => !skipped.includes(topic));
  return [
    "First call save_offer with every detail the user gave below (what they sell, price, areas, industries, sizes, buyers, must-haves, exclusions), unless they gave none. Then reply: ask your next two or three questions.",
    first ? "This is the start of the interview: greet the user in a few words." : "",
    "",
    "PROFILE SO FAR",
    offerText(profile) || "(nothing yet)",
    "",
    missing.length > 0
      ? `STILL NEEDED BEFORE A SCAN: ${missing.join("; ")}`
      : "The profile has what a scan needs.",
    extra.length > 0 ? `WORTH ASKING ABOUT: ${extra.join(" ")}` : "",
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

/** Sent once when the Interviewer replied without saving. */
export function saveTask(profile: OfferProfile, userSaid: string): string {
  return [
    "You replied without calling save_offer, so nothing was saved. Call save_offer now with every detail the user gave below, then reply with one short sentence. If they really gave no detail, reply 'Nothing to save.'",
    "",
    "PROFILE SO FAR",
    offerText(profile) || "(nothing yet)",
    "",
    "THE USER SAID",
    userSaid,
  ].join("\n");
}

import type { CodingCard } from "@mrog/shared";

/**
 * Plan problems go back to the Planner. When files keep failing in a way no change to one file can fix (a file doing
 * too much, a job in the wrong file, a file missing, two files that disagree on what one must provide), the Developer,
 * who must follow the plan and stay in its card, can only go round in circles. So those cards (set aside after their
 * rounds, or flagged by QA as a plan problem) go back to the Planner, which changes only that part of the plan. Cards
 * of files it keeps word for word stay as they are. Pure: the limits and the words.
 */

/** Re-plans a project may make by itself; after that, cards that keep failing wait for the user. */
export const MAX_REPLANS = 2;

/** QA's flag counts from a card's second fail on: the Developer gets one go at it first. */
export const PLAN_FLAG_AFTER = 2;

/** QA's newest comment on a card that isn't a pass. */
const lastProblem = (card: CodingCard) =>
  card.comments.findLast((said) => said.author !== "developer" && said.kind !== "pass")?.text ?? "";

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** What the Planner is asked: the files that keep failing, what was said, and to change only what that needs. */
export function replanRequest(cards: CodingCard[]): string {
  return [
    "These files keep failing QA, and changing each file on its own hasn't fixed them:",
    ...cards.map((card) => {
      const said = lastProblem(card);
      return `- ${card.title}${said ? `: ${clip(said.replace(/\s+/g, " "), 400)}` : ""}`;
    }),
    "Change the plan only where these problems need it: split a file that does too much into smaller files, move a job to the file it belongs in, add a file that is missing, or make two files agree on the names one gives the other. Keep every other file exactly as it is (the same path and purpose), so its finished work stays.",
  ].join("\n");
}

/** The note a card gets when the re-plan changed or added it. */
export const replannedNote = (request: string) =>
  `Re-planned: ${clip(request.split("\n").slice(1, -1).join(" "), 600)}`;

/** What the Coding Bot says when it asked for a re-plan. */
export function replanReply(titles: string[], auto: boolean, nth: number): string {
  const list =
    titles.length <= 1 ? (titles[0] ?? "") : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
  return [
    `${list} kept failing in a way the plan has to change, so I asked the Planner to fix that part of the plan (re-plan ${nth} of ${MAX_REPLANS}).`,
    auto
      ? "Auto-approve is on, so the Developer carries on with it right after."
      : "You'll see the updated plan to approve before anything is rewritten.",
    "Files whose plan doesn't change keep their work.",
  ].join(" ");
}

/** Whether QA's review_card said the plan is the problem: true, or words for yes. */
export const flagged = (value: unknown): boolean =>
  value === true || (typeof value === "string" && /^\s*(?:true|yes|y|1)\s*$/i.test(value));

import type { CodingCard } from "@mrog/shared";

/**
 * A budget per card, not per project: a card that QA or the checks keep sending back is set aside for the user once it
 * has used its rounds, and the rest of the board carries on, instead of one stubborn card stopping everything at the
 * project's round limit. The project still stops at a safety cap, in case cards keep passing and failing in turn.
 */

/** The project stops after this many times its round limit in QA passes, whatever the cards say. */
export const PROJECT_ROUND_CAP = 3;

/**
 * How many rounds a card has been sent back in: by QA (a fail) or by the checks (a finding), counted once a round
 * however many things were found in it.
 */
export function timesSentBack(card: Pick<CodingCard, "comments">): number {
  return new Set(
    card.comments
      .filter((comment) => comment.author === "qa" && (comment.kind === "fail" || comment.kind === "check"))
      .map((comment) => comment.round),
  ).size;
}

/** Sets a card aside once it has been sent back as many times as the round limit. True when it was just set aside. */
export function setAsideIfSpent(card: CodingCard, maxRounds: number): boolean {
  if (card.parked || card.column === "done" || timesSentBack(card) < maxRounds) return false;
  card.parked = true;
  return true;
}

/** Brings back the cards set aside (Resume, a higher round limit); how many came back. */
export function bringBack(cards: CodingCard[], maxRounds?: number): number {
  let back = 0;
  for (const card of cards)
    if (card.parked && (maxRounds === undefined || timesSentBack(card) < maxRounds)) {
      delete card.parked;
      back += 1;
    }
  return back;
}

/** The line for a card set aside. */
export const setAsideLine = (card: Pick<CodingCard, "title" | "comments">) =>
  `${card.title} was sent back ${timesSentBack(card)} times: set aside for you, the rest carries on`;

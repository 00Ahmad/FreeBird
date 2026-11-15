import type { CodingCard, CodingColumn } from "@mrog/shared";

import { qaFailures } from "./codingBoard";

/** How long a card keeps its "just moved" flash and label. */
export const MOVED_FOR_MS = 4000;

/** What changed on the board since the last project the screen saw, for the flash and the new-comment badge. */
export interface CardActivity {
  columns: Record<string, CodingColumn>;
  /** How many QA findings (failures, and findings of the whole-project check) each card had. */
  qaComments: Record<string, number>;
  /** Cards that changed column lately: where to, and when. */
  moved: Record<string, { to: CodingColumn; at: number }>;
  /** Cards with a QA finding nobody has looked at yet. */
  unseenQa: Record<string, true>;
}

// A pass, or the note that a card is back in QA because a file it depends on changed, is no news to look at.
const qaCount = (card: CodingCard) => qaFailures(card).length;

/**
 * Folds a new project's cards into what was known. The first sight of a board is a starting point, not news; after
 * that a card in a different column is "moved", and a card with more QA comments than before has a new one. Cards
 * that are new (the plan just arrived) don't flash.
 */
export function advanceActivity(
  previous: CardActivity | null,
  cards: readonly CodingCard[],
  now: number,
): CardActivity {
  const columns: Record<string, CodingColumn> = {};
  const qaComments: Record<string, number> = {};
  const moved: CardActivity["moved"] = {};
  const unseenQa: CardActivity["unseenQa"] = {};
  for (const card of cards) {
    columns[card.id] = card.column;
    qaComments[card.id] = qaCount(card);
    if (!previous) continue;
    const before = previous.columns[card.id];
    if (before !== undefined && before !== card.column) moved[card.id] = { to: card.column, at: now };
    else if (previous.moved[card.id]) moved[card.id] = previous.moved[card.id]!;
    const had = previous.qaComments[card.id];
    if (previous.unseenQa[card.id] || (had !== undefined && qaComments[card.id]! > had))
      unseenQa[card.id] = true;
  }
  return { columns, qaComments, moved, unseenQa };
}

/** Forgets moves older than `ttl`; the same object comes back when none were. */
export function pruneMoved(activity: CardActivity, now: number, ttl = MOVED_FOR_MS): CardActivity {
  const stale = Object.entries(activity.moved).filter(([, move]) => now - move.at >= ttl);
  if (stale.length === 0) return activity;
  const moved = { ...activity.moved };
  for (const [id] of stale) delete moved[id];
  return { ...activity, moved };
}

/** The new comment on this card has been seen. */
export function acknowledgeCard(activity: CardActivity, cardId: string): CardActivity {
  if (!activity.unseenQa[cardId]) return activity;
  const unseenQa = { ...activity.unseenQa };
  delete unseenQa[cardId];
  return { ...activity, unseenQa };
}

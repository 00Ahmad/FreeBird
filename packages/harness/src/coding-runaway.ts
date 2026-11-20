/**
 * A Developer turn that keeps changing its files without ever calling finish_card is going round in circles: each step
 * resends every file it read, so one such turn on a small model cost 445,827 input tokens (18 tool calls, 12 edits, no
 * finish). The engine's own guard only catches the same call with the same result, and different edits never are. This
 * caps the edits a turn may make: a warning one edit before the limit, then the next edit is refused, the turn ends,
 * and what was written goes on to the checks and QA as it is.
 */

/** How many writes and edits of its files a Developer turn may make before it must call finish_card. */
export const DEVELOPER_MAX_EDITS = 6;

export type EditVerdict =
  /** Go ahead. */
  | { kind: "ok" }
  /** Go ahead, and say this after the result: the next edit is the last. */
  | { kind: "warn"; note: string }
  /** Don't run it: the turn ends here. */
  | { kind: "stop"; result: string };

/**
 * What to do with a write or edit when the turn has already made `made` of them (the ones that ran, whatever they
 * changed), with at most `max` allowed.
 */
export function editVerdict(made: number, max: number = DEVELOPER_MAX_EDITS): EditVerdict {
  if (made >= max)
    return {
      kind: "stop",
      result: `Not written: you have changed the files ${made} times in this turn without calling finish_card. Stop now: what you wrote goes to the checks and QA as it is, and any problem comes back to you with the exact error.`,
    };
  if (made === max - 2)
    return {
      kind: "warn",
      note: `\n\nYou have changed the files ${made + 1} times in this turn. Make at most one more change, then call finish_card.`,
    };
  return { kind: "ok" };
}

/** The activity line for a turn that was cut off. */
export const cutOffLine = (made: number, title: string) =>
  `Developer made ${made} edits without finishing ${title}; its work goes on as it is`;

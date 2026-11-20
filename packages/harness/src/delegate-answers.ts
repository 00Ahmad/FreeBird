/**
 * Helpers' answers handed back to a coordinator in one tool result. A tool result is cut at 20,000 characters, which
 * would keep the first helpers' answers whole and drop the last ones; instead each answer gets a fair share of the room
 * and is cut at its own end, saying where the full answer is.
 */

/** Room for every answer together: under the tool host's cut, with space for the headings. */
export const ANSWERS_ROOM = 18_000;

export interface HelperAnswer {
  name: string;
  text: string;
}

/**
 * The answers, each under its own heading. Short answers are kept whole; the room left is shared evenly by the long
 * ones, and each cut answer says so and points to the helper's thread with the coordinator.
 */
export function fitAnswers(answers: readonly HelperAnswer[], room = ANSWERS_ROOM): string {
  const limits = new Map<number, number>();
  let left = room;
  // Shortest first: each takes what it needs up to an even share of what is left.
  const order = answers.map((answer, index) => ({ index, length: answer.text.length }));
  order.sort((a, b) => a.length - b.length);
  order.forEach((item, position) => {
    const share = Math.floor(left / (order.length - position));
    const limit = Math.min(item.length, share);
    limits.set(item.index, limit);
    left -= limit;
  });
  return answers
    .map((answer, index) => {
      const limit = limits.get(index)!;
      const body =
        answer.text.length > limit
          ? `${answer.text.slice(0, limit)}\n…(cut to fit beside the other answers: ${answer.name}'s full answer is in your conversation with ${answer.name})`
          : answer.text;
      return `## ${answer.name}\n${body}`;
    })
    .join("\n\n");
}

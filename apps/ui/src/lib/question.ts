import type { MessagePart } from "@mrog/shared";

type QuestionPart = Extract<MessagePart, { type: "question" }>;

/** What a question card posts: the typed answer, or the choices (kept apart, as a choice may contain a comma). */
export type AnswerBody = { answer: string } | { choices: string[] };

/**
 * The answer for a card, or null while there is nothing to send. A tap on one option of a single-choice question
 * is its own answer; ticks on a multiple-choice one are sent together, with anything typed as one more pick.
 */
export function answerBody(input: { picks: string[]; typed: string; multiple: boolean }): AnswerBody | null {
  const typed = input.typed.trim();
  if (!input.multiple) {
    const pick = input.picks[0]?.trim();
    const answer = pick || typed;
    return answer ? { answer } : null;
  }
  const choices = [...new Set([...input.picks.map((pick) => pick.trim()), ...(typed ? [typed] : [])])].filter(
    Boolean,
  );
  return choices.length > 0 ? { choices } : null;
}

/** The lines to show for an answered question: one per pick for a multiple-choice one, else the answer as written. */
export function answerLines(part: Pick<QuestionPart, "answer" | "multiple" | "options">): string[] {
  const answer = part.answer ?? "";
  if (!answer) return [];
  return part.multiple && part.options ? answer.split("\n").filter(Boolean) : [answer];
}

/** Ticks an option on or off, in the order the options are listed (not the order they were ticked). */
export function togglePick(options: readonly string[], picks: readonly string[], option: string): string[] {
  const next = new Set(picks);
  if (next.has(option)) next.delete(option);
  else next.add(option);
  return options.filter((candidate) => next.has(candidate));
}

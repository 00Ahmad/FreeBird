import { estimateTextTokens } from "@mrog/engine";

/**
 * The rules for a bot's memory notes, as plain functions: which notes go into the prompt, whether a note is already
 * saved, and which notes a `forget` request names. The wiring (tools, routes) is in team.ts.
 */

/** At most this many notes go into a prompt, however short. */
export const MEMORY_IN_PROMPT = 60;

/** The share of the model's context window memory may take in the system prompt. */
export const MEMORY_SHARE = 0.1;

/** The tokens of memory a prompt may hold for a model with this context window (never under 600). */
export const memoryBudget = (contextWindow: number) =>
  Math.max(600, Math.floor(contextWindow * MEMORY_SHARE));

/** A note as the prompt rule sees it: its text, and whether the user pinned it. */
export interface PromptNote {
  text: string;
  pinned?: boolean;
}

/**
 * The notes that go into the prompt, in the order they were saved. Pinned notes always go in, however old and even
 * past the budget (`pinnedOver` then says so); then the newest others, until the budget or MEMORY_IN_PROMPT is
 * reached. `left` is how many were left out.
 */
export function notesForPrompt<T extends PromptNote | string>(
  notes: readonly T[],
  budgetTokens: number,
  max = MEMORY_IN_PROMPT,
): { notes: T[]; left: number; pinnedOver: boolean } {
  const textOf = (note: T) => (typeof note === "string" ? note : note.text);
  const pinnedOf = (note: T) => typeof note !== "string" && note.pinned === true;
  // "- " and a line break per note in the prompt; Urdu or Chinese notes cost more per character than English.
  const cost = (note: T) => estimateTextTokens(textOf(note)) + 1;
  // By position, so two notes with the same text are still two notes.
  const kept = new Set<number>(notes.flatMap((note, index) => (pinnedOf(note) ? [index] : [])));
  let used = [...kept].reduce((sum, index) => sum + cost(notes[index]!), 0);
  const pinnedOver = used > budgetTokens;
  for (let index = notes.length - 1; index >= 0 && kept.size < max; index--) {
    if (kept.has(index)) continue;
    const note = notes[index]!;
    if (used + cost(note) > budgetTokens) break;
    used += cost(note);
    kept.add(index);
  }
  return {
    notes: notes.filter((_, index) => kept.has(index)),
    left: notes.length - kept.size,
    pinnedOver,
  };
}

/** A note as compared: case, spacing and a closing full stop don't make it a different note. */
const folded = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!\s]+$/, "")
    .trim();

/** Whether this note is already saved. */
export const alreadySaved = (notes: readonly string[], note: string) =>
  notes.some((saved) => folded(saved) === folded(note));

/** A `forget` request has to name at least one word this long, so "the" or "a" can't empty the memory. */
export const MIN_FORGET_WORD = 4;

/** Above this many matching notes, the user is asked before they are deleted. */
export const FORGET_WITHOUT_ASKING = 3;

/** Why this text can't be used to forget notes, or null when it can. */
export function forgetProblem(text: string): string | null {
  const longest = Math.max(0, ...(text.match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => word.length));
  return longest >= MIN_FORGET_WORD
    ? null
    : `Name what to forget with at least one word of ${MIN_FORGET_WORD} letters or more, so other notes aren't deleted with it.`;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a note contains the text as whole words ("tea" is in "Likes tea", not in "Steady"). */
export function noteMentions(note: string, text: string): boolean {
  const words = text.trim().split(/\s+/).map(escape).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, "iu").test(note);
}

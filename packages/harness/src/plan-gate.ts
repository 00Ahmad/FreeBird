/**
 * Whether a coordinator's message is worth asking the model if it splits into parts for helpers. Asking costs a model
 * request before any work starts, so code settles the clear cases and the model is asked only about the rest.
 */

/** Shorter messages are greetings or quick questions. */
export const MIN_PLAN_WORDS = 8;

/** The user already asked for helpers; the coordinator's prompt covers that. */
const ASKS_FOR_HELPERS = /\b(sub-?agents?|helpers?|workers?|agents?|spawn|delegate)\b/i;

/**
 * Points back at the conversation ("compare those three", "check them again"). The planner sees only this message and
 * a helper sees only its task, so neither would know what "those" are.
 */
const POINTS_BACK =
  /\b(those|them|the same|that one|the above|above|mentioned|earlier|previous|again|you found|you said|you listed)\b/i;

/** A file or a folder on this computer: helpers can't see the coordinator's files. */
const NAMES_A_FILE =
  /(^|[\s"'(])(\.{1,2}[\\/]|[A-Za-z]:\\|~\/)|\b[\w-]+\.(tsx?|jsx?|py|md|json|txt|csv|html?|css|xlsx?|docx?|pdf|ya?ml|toml|sh|ps1)\b/i;

/** Writing, explaining or changing something: done from what the model knows, or step by step, never in parts. */
const WORKS_ON_ONE_THING =
  /^\s*(please\s+|can you\s+|could you\s+)?(write|explain|fix|change|edit|rewrite|translate|summari[sz]e|draft|debug|refactor|rename|tell me about|what is|what's|why|how do|how does)\b/i;

/** Several things, each to look into: what helpers are for. */
const SEVERAL = /\b(compare|comparison|each|every|versus|vs\.?|between|several|multiple|all of)\b/i;

/** Whether the message names several things in a list ("A, B and C", or one per line). */
const listsThings = (text: string) =>
  (text.match(/,/g) ?? []).length >= 2 ||
  /,[^,]+\b(and|or)\b/i.test(text) ||
  /(^|\n)\s*([-*•]|\d+[.)])\s+\S[\s\S]*\n\s*([-*•]|\d+[.)])\s+\S/.test(text);

/** Why the model isn't asked whether this message splits into parts, or null when it should be. */
export function skipPlan(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.split(/\s+/).length < MIN_PLAN_WORDS) return "short";
  if (ASKS_FOR_HELPERS.test(trimmed)) return "asks for helpers";
  if (POINTS_BACK.test(trimmed)) return "points back at the chat";
  if (NAMES_A_FILE.test(trimmed)) return "names a file";
  if (WORKS_ON_ONE_THING.test(trimmed)) return "one piece of work";
  if (!SEVERAL.test(trimmed) && !listsThings(trimmed)) return "one thing";
  return null;
}

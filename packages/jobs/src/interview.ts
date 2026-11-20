import { fold } from "./text";

/**
 * Keeping track of the interview, by code: which topics the Interviewer has asked about, and which the user skipped,
 * so it neither asks again nor forgets a "skip". Topics are found by their words in the Interviewer's question.
 */

export const INTERVIEW_TOPICS = {
  titles: /\b(job titles?|titles?|roles?|what (job|kind of job|position))\b/,
  seniority: /\b(seniority|senior|junior|level)\b/,
  workplace: /\b(remote|hybrid|office|on-?site)\b/,
  places: /\b(where|places?|locations?|cit(y|ies)|countr(y|ies)|area)\b/,
  salary: /\b(salary|pay|paid|compensation|earn)\b/,
  mustHaves: /\bmust[- ]haves?\b|\bmust have\b/,
  dealBreakers: /\bdeal[- ]?breakers?\b|\bavoid\b/,
  rightToWork: /\b(right to work|visa|sponsorship|work permit)\b/,
  experience: /\b(skills?|experience|background)\b/,
  niceToHaves: /\bnice[- ]to[- ]haves?\b|\bnice to have\b/,
} as const;
export type InterviewTopic = keyof typeof INTERVIEW_TOPICS;

/** A bot's interview topics: each one's name, and the words in a question that ask about it. */
export type TopicWords<T extends string = string> = Readonly<Record<T, RegExp>>;

/** The topics a question of the Interviewer's asks about (a Job Bot's by default; any bot passes its own). */
export function topicsIn<T extends string = InterviewTopic>(
  question: string,
  topics: TopicWords<T> = INTERVIEW_TOPICS as unknown as TopicWords<T>,
): T[] {
  const text = fold(question);
  return (Object.keys(topics) as T[]).filter((topic) => topics[topic].test(text));
}

/** A reply that skips the question: "skip", "pass", "not sure", "no preference". */
export const skipsQuestion = (said: string) =>
  /^\s*(skip|pass|next|no idea|i don'?t know|don'?t know|not sure|no preference|doesn'?t matter|none|n\/a|nothing)\b/i.test(
    said,
  );

/** The interview so far, after the user answered `lastQuestion` with `said`. */
export function nextInterviewState(
  current: { asked: readonly string[]; skipped: readonly string[] },
  lastQuestion: string | null,
  said: string,
  words: TopicWords = INTERVIEW_TOPICS,
): { asked: string[]; skipped: string[] } {
  const topics = lastQuestion ? topicsIn(lastQuestion, words) : [];
  return {
    asked: [...new Set([...current.asked, ...topics])],
    skipped: [...new Set([...current.skipped, ...(skipsQuestion(said) ? topics : [])])],
  };
}

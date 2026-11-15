import type { JobFact, MatchLine } from "@mrog/shared";

/** What a warning rule looks at: the page as read, the checked facts and the match. */
export interface WarningContext {
  page: string;
  facts: JobFact[];
  match: MatchLine[];
  /** Now, for rules about dates (tests pass a fixed one). */
  now: Date;
}

/** One warning sign: a small rule in its own file, with its own test. */
export interface WarningRule {
  id: string;
  /** The warning in plain words, or null when the sign isn't there. */
  check(context: WarningContext): string | null;
}

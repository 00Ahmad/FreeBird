import type { ClueId, PlaybookId, SignalKindId, TraitId } from "@mrog/shared";

/**
 * A kind of service, as data: which signals, traits and clues matter for it, what a company asking for it calls it,
 * which job ads mean a company may need it, and the words that mean a company sells it itself (a competitor).
 * Adding a service means adding one file and one line in the list.
 */
export interface Playbook {
  id: PlaybookId;
  label: string;
  /** Words in "what you sell" that pick this playbook. */
  matches: RegExp;
  signals: SignalKindId[];
  traits: TraitId[];
  clues: ClueId[];
  /** Who usually buys it. */
  buyerTitles: string[];
  /** Job titles whose ads are a sign a company may need you. */
  hiringTitles: string[];
  /** What a company asking for it calls it ("payroll provider"). */
  serviceNames: string[];
  /** Words on a page that mean the company sells this itself. */
  sells: RegExp;
  /** Words a public tender for it uses. */
  tenderWords: string[];
  /** Extra things the Interviewer should ask about. */
  questions: string[];
}

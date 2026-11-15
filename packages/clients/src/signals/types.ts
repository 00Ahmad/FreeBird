import type { SignalKindId } from "@mrog/shared";

import type { Playbook } from "../playbooks";

/** What a signal's searches are built from. */
export interface SearchContext {
  playbook: Playbook;
  serviceNames: string[];
  /** The first place you serve (not "remote"), or "". */
  place: string;
  /** The first industry of your ideal client, or "". */
  industry: string;
  year: number;
}

/**
 * One kind of sign that a company may need you, as a plug-in: how strong it is, how long it stays fresh, the words a
 * quote of it must have (code checks the Checker's quote), and the web searches that find it.
 */
export interface SignalKind {
  id: SignalKindId;
  label: string;
  /** 0 to 1: how strongly it says the company needs you. */
  strength: number;
  /** Days it stays fresh: it fades to half by then and counts for nothing after. */
  freshForDays: number;
  /** Whether the quote says this sign (code, not the model). */
  indicates(quote: string, playbook: Playbook): boolean;
  /** Web searches that find companies showing it; none when it comes only from registers or other sources. */
  searches(context: SearchContext): string[];
}

import type { SignalKind } from "./types";
import { namesServiceNear, serviceWords } from "./words";

const ASKS =
  /looking for|seeking|\bseek\b|recommend|recommendations?|request for (proposals?|quotations?|quotes?|tender)|\brf[pq]\b|\btender(s|ing)?\b|invitation to (tender|quote)|\bneed (a|an|some|someone)\b|wants? (a|an)\b|procur|appoint (a|an)\b|any suggestions|can anyone/;

/**
 * Asking now: a tender, a request for proposals, or a "seeking a provider" post. The strongest sign, so the quote
 * must name your service next to the asking words: "recommend booking early" and "tender beef" ask for nothing.
 */
export const asking: SignalKind = {
  id: "asking",
  label: "Asking now",
  strength: 1,
  freshForDays: 90,
  indicates: (quote, playbook, context) =>
    namesServiceNear(quote, ASKS, serviceWords(playbook, context?.serviceNames)),
  searches: ({ serviceNames, place }) =>
    serviceNames
      .slice(0, 2)
      .flatMap((name) => [`"looking for a ${name}" ${place}`, `"recommend a ${name}" ${place}`])
      .map((q) => q.trim()),
};

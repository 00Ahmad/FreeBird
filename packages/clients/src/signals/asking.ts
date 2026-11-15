import { fold } from "@mrog/jobs";

import type { SignalKind } from "./types";

const ASKS =
  /looking for|seeking|\bseek\b|recommend|recommendations?|request for (proposals?|quotations?|quotes?|tender)|\brf[pq]\b|tender|invitation to (tender|quote)|\bneed (a|an|some|someone)\b|wants? (a|an)\b|procur|appoint (a|an)\b|any suggestions|can anyone/;

/** Asking now: a tender, a request for proposals, or a "seeking a provider" post. The strongest sign. */
export const asking: SignalKind = {
  id: "asking",
  label: "Asking now",
  strength: 1,
  freshForDays: 90,
  indicates: (quote) => ASKS.test(fold(quote)),
  searches: ({ serviceNames, place }) =>
    serviceNames
      .slice(0, 2)
      .flatMap((name) => [`"looking for a ${name}" ${place}`, `"recommend a ${name}" ${place}`])
      .map((q) => q.trim()),
};

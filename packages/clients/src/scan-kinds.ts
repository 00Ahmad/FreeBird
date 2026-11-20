import { fold } from "@mrog/jobs";
import type { LeadKind } from "@mrog/shared";

/**
 * The kinds of lead a scan looks for, read from what you say in the chat (3.4): "10, only tenders", "5, no quiet
 * fits". Before, a scan started from the chat used last time's kinds without saying so.
 */

export const KIND_ORDER: readonly LeadKind[] = ["asking", "signs", "quiet"];

export const KIND_NAMES: Record<LeadKind, string> = {
  asking: "asking now (tenders and requests)",
  signs: "companies with signs",
  quiet: "quiet fits",
};

const KIND_WORDS: Record<LeadKind, string> = {
  asking: "(tenders?|asking( now)?|requests?)",
  signs: "((companies )?with signs|signs?)",
  quiet: "(quiet( fits?)?|lookalikes?|registers?)",
};

/** The kinds a message asks for, from `current` (last time's), or null when it says nothing about kinds. */
export function kindsFrom(text: string, current: readonly LeadKind[]): LeadKind[] | null {
  const t = fold(text);
  const mentioned = KIND_ORDER.filter((kind) => new RegExp(`\\b${KIND_WORDS[kind]}\\b`).test(t));
  const excluded = KIND_ORDER.filter((kind) =>
    new RegExp(`\\b(no|not|without|skip|except|leave out)\\s+(the\\s+|any\\s+)?${KIND_WORDS[kind]}\\b`).test(
      t,
    ),
  );
  if (/\b(only|just)\b/.test(t)) {
    const only = mentioned.filter((kind) => !excluded.includes(kind));
    if (only.length > 0) return only;
  }
  if (excluded.length > 0) {
    const kept = (current.length > 0 ? current : KIND_ORDER).filter((kind) => !excluded.includes(kind));
    return kept.length > 0 ? KIND_ORDER.filter((kind) => kept.includes(kind)) : null;
  }
  return null;
}

/** "asking now (tenders and requests), companies with signs and quiet fits". */
export function kindsText(kinds: readonly LeadKind[]): string {
  const names = KIND_ORDER.filter((kind) => kinds.includes(kind)).map((kind) => KIND_NAMES[kind]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

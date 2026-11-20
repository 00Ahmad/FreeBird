import { fold, unique, words } from "./text";

/**
 * Changing a profile's lists safely, for any bot's profile: a small model told "also add Go" sends the list as just
 * ["Go"]; read as a whole new list, that wiped the others. So items are added, items to take out are named
 * separately, and an item the user didn't say isn't saved.
 */

/** The lists of `change` added to `base`'s (and `remove`'s items taken out); other fields as sent. */
export function addToLists<F extends string>(
  base: Record<F, readonly string[]>,
  change: Partial<Record<F, readonly string[]>> & Record<string, unknown>,
  fields: readonly F[],
  remove: Partial<Record<F, readonly string[]>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...change };
  for (const field of fields) {
    const added = change[field];
    const gone = new Set((remove[field] ?? []).map(fold));
    if (added === undefined && gone.size === 0) continue;
    out[field] = unique([...base[field], ...(added ?? [])]).filter((item) => !gone.has(fold(item)));
  }
  return out;
}

const stem = (word: string) => (word.length > 3 ? word.replace(/(es|s)$/, "") : word);

/** Letters two words must share at their start to be one word's forms ("accountants", "accounting"). */
const SHARED_STEM = 6;

const sameWord = (a: string, b: string) => {
  if (a === b) return true;
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n >= SHARED_STEM;
};

/**
 * Whether the user's words back an item: it shares a word with them (or a form of one: a small model saved
 * "accounting" for "accountants", found in the Client Bot's benchmark), or is the long form of their initials ("PM").
 */
export function itemSaid(item: string, heard: string): boolean {
  const said = words(heard).map(stem);
  const have = new Set(said);
  const want = words(item).map(stem);
  if (want.some((word) => have.has(word) || said.some((one) => sameWord(word, one)))) return true;
  const initials = want.map((word) => word[0]).join("");
  return initials.length >= 2 && have.has(initials);
}

/** `change` with only the list items the user's message backs; `dropped` names the rest. */
export function keepItemsSaid<F extends string>(
  change: Record<string, unknown>,
  heard: string,
  fields: readonly F[],
): { change: Record<string, unknown>; dropped: string[] } {
  if (!heard.trim()) return { change, dropped: [] };
  const out: Record<string, unknown> = { ...change };
  const dropped: string[] = [];
  for (const field of fields) {
    const items = change[field] as string[] | undefined;
    if (!items) continue;
    const kept = items.filter((item) => itemSaid(item, heard));
    for (const item of items) if (!kept.includes(item)) dropped.push(item);
    out[field] = kept;
  }
  return { change: out, dropped };
}

/** "Added must-have: Go", "Removed area: York" for each list item that changed. */
export function describeLists<F extends string>(
  before: Record<F, readonly string[]>,
  after: Record<F, readonly string[]>,
  labels: Record<F, string>,
): string[] {
  const lines: string[] = [];
  for (const field of Object.keys(labels) as F[]) {
    const was = new Set(before[field].map(fold));
    const now = new Set(after[field].map(fold));
    for (const item of after[field]) if (!was.has(fold(item))) lines.push(`Added ${labels[field]}: ${item}`);
    for (const item of before[field])
      if (!now.has(fold(item))) lines.push(`Removed ${labels[field]}: ${item}`);
  }
  return lines;
}

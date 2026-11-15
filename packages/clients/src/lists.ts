import { MAX_LIST_ENTRIES, type ClientLists, type ListEntry, type ListName } from "@mrog/shared";

import { hostIn } from "./facts";
import { companyDomain, nameKey } from "./identity";

/** Your lists: existing clients, competitors, do-not-contact. Checked by code before any lead is made. */

export const emptyLists = (): ClientLists => ({ clients: [], competitors: [], doNotContact: [] });

const HEADER =
  /^(name|company|company name|business|business name|website|web|domain|url|email|e-mail|address)$/i;

/** One CSV line's cells ("a, b", quoted cells with commas kept). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if ((ch === "," || ch === ";" || ch === "\t") && !quoted) {
      out.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  out.push(cell.trim());
  return out.filter(Boolean);
}

/** A cell that is a web address or an email: its domain. */
function domainIn(cell: string): string | null {
  if (/\s/.test(cell)) return null;
  const email = /^[\w.+-]+@([\w-]+(\.[\w-]+)+)$/.exec(cell);
  if (email) return companyDomain(email[1]!);
  return /\./.test(cell) ? companyDomain(hostIn(cell)) : null;
}

/**
 * Companies from pasted text or a CSV: one per line, a name, a web address (or an email), or both. A header line is
 * skipped; a line with neither is ignored.
 */
export function parseEntries(text: string): ListEntry[] {
  const entries: ListEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = cells(line);
    // An empty line, or a header line (every cell a column name).
    if (row.every((c) => HEADER.test(c))) continue;
    const domain = row.map(domainIn).find(Boolean) ?? null;
    const name = row.find((c) => !domainIn(c) && !/@/.test(c) && /[\p{L}\p{N}]/u.test(c)) ?? domain ?? "";
    if (!name && !domain) continue;
    entries.push({ name: name.slice(0, 200), domain });
  }
  return entries;
}

const same = (a: ListEntry, b: { name: string | null; domain: string | null }) =>
  (!!a.domain && a.domain === b.domain) || (!!nameKey(a.name) && nameKey(a.name) === nameKey(b.name));

/** The list a company is on (clients first, then competitors, then do-not-contact), or null. */
export function listedIn(
  company: { name: string | null; domain: string | null },
  lists: ClientLists,
): ListName | null {
  if (lists.clients.some((e) => same(e, company))) return "clients";
  if (lists.competitors.some((e) => same(e, company))) return "competitors";
  if (lists.doNotContact.some((e) => same(e, company))) return "doNotContact";
  return null;
}

/** The lists with the entries added to one of them, without repeats, keeping at most MAX_LIST_ENTRIES. */
export function addToList(lists: ClientLists, list: ListName, entries: ListEntry[]): ClientLists {
  const kept = [...lists[list]];
  for (const entry of entries) if (!kept.some((e) => same(e, entry))) kept.push(entry);
  return { ...lists, [list]: kept.slice(-MAX_LIST_ENTRIES) };
}

export function removeFromList(lists: ClientLists, list: ListName, entry: ListEntry): ClientLists {
  return {
    ...lists,
    [list]: lists[list].filter((e) => !(e.name === entry.name && e.domain === entry.domain)),
  };
}

export const LIST_LABELS: Record<ListName, string> = {
  clients: "your clients",
  competitors: "your competitors",
  doNotContact: "do-not-contact",
};

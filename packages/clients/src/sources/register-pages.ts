import type { RegisterPage } from "@mrog/shared";

import type { Register, RegisterQuery } from "./types";

/**
 * How far each register query has been read, across scans (2.2): every scan asked for the same first page, so after
 * two or three scans a register gave nothing new and said nothing. Now each scan asks for the next page; one that has
 * read the last page says so, and starts again from the first after USED_UP_DAYS (registers change).
 */

export const USED_UP_DAYS = 30;
/** Query memories kept, newest last. */
export const MAX_REGISTER_PAGES = 200;
const DAY_MS = 86_400_000;

/**
 * One query's key: the register and what it asks, whatever page and whatever day. A date window ("incorporated in
 * the last year") moves every day, so only whether it has one is part of the key: else the memory was lost daily.
 */
export const queryKey = (register: Pick<Register, "id">, query: RegisterQuery): string =>
  `${register.id}:${JSON.stringify({
    words: query.words,
    place: query.place,
    sicCodes: query.sicCodes,
    from: query.incorporatedFrom !== null,
    to: query.incorporatedTo !== null,
  })}`;

/** Where a query reads next: its page, or "used up" while its last page was read lately. */
export function nextPage(
  memory: Readonly<Record<string, RegisterPage>>,
  key: string,
  now: Date,
): { page: number } | { usedUp: RegisterPage } {
  const seen = memory[key];
  if (!seen) return { page: 1 };
  const fresh = now.getTime() - Date.parse(seen.at) < USED_UP_DAYS * DAY_MS;
  if (seen.usedUp) return fresh ? { usedUp: seen } : { page: 1 };
  return { page: seen.page };
}

/**
 * The memory after reading a query's page: the next page, or used up when it was the last. `taken`: every new record
 * of the page was taken (when the scan stopped part way through it, the same page is read again next time).
 */
export function afterPage(
  memory: Readonly<Record<string, RegisterPage>>,
  key: string,
  read: { page: number; last: boolean; taken: boolean },
  now: Date,
): Record<string, RegisterPage> {
  const at = now.toISOString();
  const entry: RegisterPage = !read.taken
    ? { page: read.page, usedUp: false, at }
    : read.last
      ? { page: read.page, usedUp: true, at }
      : { page: read.page + 1, usedUp: false, at };
  const { [key]: _old, ...rest } = memory;
  return Object.fromEntries([...Object.entries(rest), [key, entry]].slice(-MAX_REGISTER_PAGES));
}

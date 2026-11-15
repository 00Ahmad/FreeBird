import type { PageRead } from "@mrog/jobs";
import type { ClueId } from "@mrog/shared";

import { freeEmail } from "./free-email";
import { noBlog } from "./no-blog";
import { noBooking } from "./no-booking";
import { noHttps } from "./no-https";
import { oldCopyright } from "./old-copyright";
import { ordersByPhone } from "./orders-by-phone";
import type { SiteClue } from "./types";

export type { SiteClue } from "./types";
export { isHomePage } from "./types";

export const CLUES: readonly SiteClue[] = [
  oldCopyright,
  noHttps,
  freeEmail,
  noBlog,
  noBooking,
  ordersByPhone,
];

/** The clues you switched on that a company's page shows, each with what code saw. */
export function cluesOn(
  page: PageRead,
  wanted: readonly ClueId[],
  now: Date,
): { id: ClueId; text: string }[] {
  return CLUES.filter((clue) => wanted.includes(clue.id)).flatMap((clue) => {
    const text = clue.check(page, now);
    return text ? [{ id: clue.id, text }] : [];
  });
}

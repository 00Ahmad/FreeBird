import type { PageRead } from "@mrog/jobs";
import type { ClueId } from "@mrog/shared";

/**
 * Something the bot sees on a company's own site, checked by code alone (no model): an old copyright year, no
 * secure connection. `check` gives what it saw in a few words, or null. One file each.
 */
export interface SiteClue {
  id: ClueId;
  label: string;
  check(page: PageRead, now: Date): string | null;
}

/** The page is a site's home page (clues about what a site lacks are only judged there). */
export function isHomePage(url: string): boolean {
  try {
    return /^\/?(index\.(html?|php))?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

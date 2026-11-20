import { looksLikeJob } from "./leads";
import type { PageRead } from "./page";
import { saysClosed } from "./warnings";

/** A page with this many links to jobs is a list of jobs, whatever one of them says. */
export const LIST_LINKS = 3;

/**
 * Whether a page is one closed job, so no model needs to read it. A list of jobs that mentions one closed posting
 * ("Data Analyst - applications closed") is still a list: only a page with few links to jobs, and never a job system's
 * own list, counts as closed.
 */
export function isClosedPosting(page: PageRead): boolean {
  if (!saysClosed(page.text)) return false;
  if (page.reader === "api" && page.links.length > 0) return false;
  const jobLinks = page.links.filter((link) => link.url !== page.url && looksLikeJob(link.url)).length;
  return jobLinks < LIST_LINKS;
}

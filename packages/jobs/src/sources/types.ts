import type { PageLink } from "../page";

/** A job system's page turned into text and links, read from its public job list (not the web page). */
export interface SourcePage {
  title: string;
  text: string;
  links: PageLink[];
}

/**
 * A job system with a public job list (Greenhouse, Lever…), one file each. Pure: it says which address to ask and
 * turns the answer into a page; the harness does the fetching. Adding a system is one file and one line in the list.
 */
export interface JobSource {
  id: string;
  label: string;
  /** The public JSON address for a posting or a board address of this system, or null when it isn't one. */
  apiUrl(url: string): string | null;
  /** The JSON as a page whose text the facts are checked against; null when it isn't what was expected. */
  toPage(json: unknown, url: string): SourcePage | null;
}

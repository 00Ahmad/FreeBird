import type { JobReader } from "@mrog/shared";

/** A link on a page: its words and where it points (always absolute). */
export interface PageLink {
  text: string;
  url: string;
  /** Where the job is, when a job system's list says (its own field, not the link's words). */
  place?: string;
}

/** A page as one of the readers read it. Every job card's facts are checked against this text. */
export interface PageRead {
  /** Where the page ended up (after redirects). */
  url: string;
  title: string;
  text: string;
  links: PageLink[];
  reader: JobReader;
  /** The page shows a CAPTCHA or "are you human" check. */
  humanCheck: boolean;
  /** HTTP status when it was an error. */
  status?: number;
  /** The page builds its content with JavaScript: read as text, it is only the frame. */
  scriptRendered?: boolean;
}

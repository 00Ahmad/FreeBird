import type { PageRead } from "@mrog/jobs";
import type { JobReader } from "@mrog/shared";

import type { Phase } from "../phase";

/** What a reader gets besides the address. */
export interface ReadContext {
  /** The Job Bot. */
  botId: string;
  signal: AbortSignal;
  /** The scan's status message (where a Visual helper's approval cards appear). */
  phase: Phase;
  /** Why the cheaper readers failed, in a few words. */
  why: string;
}

/**
 * One way of reading a page, one file each: a job system's public list, the page as text, the bot's browser, the
 * Visual helper. Null: this reader can't read this address (no job system handles it, no Visual helper). Throws
 * with a plain reason when it tried and failed.
 */
export interface PageReader {
  id: Exclude<JobReader, "you">;
  read(url: string, context: ReadContext): Promise<PageRead | null>;
}

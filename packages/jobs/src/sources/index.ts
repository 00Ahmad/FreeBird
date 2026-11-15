import { greenhouse } from "./greenhouse";
import { lever } from "./lever";
import type { JobSource } from "./types";

export type { JobSource, SourcePage } from "./types";

/** Job systems with a public job list. Adding one is one file and one line here. */
export const JOB_SOURCES: readonly JobSource[] = [greenhouse, lever];

/** The job system that handles an address, with its API address, or null. */
export function sourceFor(
  url: string,
  sources: readonly JobSource[] = JOB_SOURCES,
): { source: JobSource; apiUrl: string } | null {
  for (const source of sources) {
    const apiUrl = source.apiUrl(url);
    if (apiUrl) return { source, apiUrl };
  }
  return null;
}

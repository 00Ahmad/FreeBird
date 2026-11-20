import type { JobReader, JobProject } from "@mrog/shared";

import { createTeamPageReading, type TeamReadingDeps } from "../teams/page-reading";
import type { Handoffs } from "./handoff";
import type { PageReader } from "./readers/types";
import type { JobState } from "./state";

export type { ReadOutcome } from "../teams/page-reading";

/** The Visual helper reads at most this many pages a scan: each takes minutes on a local model. */
export const MAX_VISUAL_PAGES = 5;

export interface ReadPageDeps extends TeamReadingDeps<JobProject> {
  state: JobState;
  readers: Partial<Record<Exclude<JobReader, "you">, PageReader>>;
  handoffs: Handoffs;
}

/** A Job Bot's page reading: the team bots' shared reading ladder (`teams/page-reading.ts`). */
export const createPageReading = (deps: ReadPageDeps) => createTeamPageReading<JobProject>(deps);

export type PageReading = ReturnType<typeof createPageReading>;

import type { ClientProject, JobReader } from "@mrog/shared";

import type { Handoffs } from "../jobs/handoff";
import type { PageReader } from "../jobs/readers/types";
import { createTeamPageReading, type TeamReadingDeps } from "../teams/page-reading";
import type { ClientState } from "./state";

export type { ReadOutcome } from "../teams/page-reading";

/** The Visual helper reads at most this many pages a scan. */
export const MAX_VISUAL_PAGES = 5;

export interface ReadPageDeps extends TeamReadingDeps<ClientProject> {
  state: ClientState;
  readers: Partial<Record<Exclude<JobReader, "you">, PageReader>>;
  handoffs: Handoffs;
}

/**
 * A Client Bot's page reading: the team bots' shared reading ladder (`teams/page-reading.ts`), with `defer` so a page
 * that needs you is set aside instead of holding up the scan (5.4).
 */
export const createPageReading = (deps: ReadPageDeps) => createTeamPageReading<ClientProject>(deps);

export type PageReading = ReturnType<typeof createPageReading>;

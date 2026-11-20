import { emptyProfile, missingForApproval } from "@mrog/jobs";
import {
  DEFAULT_JOB_TARGET,
  isJobBusy,
  JobCard,
  JobProfile,
  JobProject,
  JobRoleSeat,
  MAX_JOB_LOG,
  MAX_SEEN_JOBS,
} from "@mrog/shared";

import type { Services } from "../services";
import { createTeamState } from "../teams/state";

export { SAVE_EVERY_MS } from "../teams/state";

/** A request the Job Bot can't do now: the route answers with its status and code. */
export class JobError extends Error {
  constructor(
    message: string,
    readonly code = "invalid_request",
    readonly status = 400,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export const settingsKey = (botId: string) => `job:${botId}`;

/**
 * A project as saved, checked: fields added since it was saved get their defaults. One that doesn't parse whole
 * (saved by another version) keeps its profile, its board and the jobs already shown, each as far as it parses, and
 * starts the rest afresh. Null when even its team can't be read.
 */
export function restoreProject(saved: unknown, now: string): JobProject | null {
  const parsed = JobProject.safeParse(saved);
  if (parsed.success) return parsed.data;
  if (!saved || typeof saved !== "object") return null;
  const raw = saved as Record<string, unknown>;
  const roles = (raw.roles ?? {}) as Record<string, unknown>;
  const seats = ["interviewer", "searcher", "checker", "visual"].map((role) =>
    JobRoleSeat.safeParse(roles[role]),
  );
  if (typeof raw.botId !== "string" || seats.some((seat) => !seat.success)) return null;
  const profile = JobProfile.safeParse(raw.profile);
  const kept = profile.success ? profile.data : emptyProfile();
  const cards = Array.isArray(raw.cards)
    ? raw.cards.flatMap((card) => {
        const one = JobCard.safeParse(card);
        return one.success ? [one.data] : [];
      })
    : [];
  const seen = Array.isArray(raw.seen)
    ? raw.seen.filter((print): print is string => typeof print === "string")
    : [];
  const restored = JobProject.safeParse({
    botId: raw.botId,
    status: missingForApproval(kept).length > 0 ? "interview" : "ready",
    roles: Object.fromEntries(
      seats.map((seat, i) => [["interviewer", "searcher", "checker", "visual"][i], seat.data]),
    ),
    profile: kept,
    cards,
    seen: seen.slice(-MAX_SEEN_JOBS),
    siteNotes: [],
    deadPages: [],
    searchesRun: [],
    interview: { asked: [], skipped: [] },
    suggestions: [],
    scan: null,
    lastTarget: DEFAULT_JOB_TARGET,
    askingCount: false,
    active: null,
    handoff: null,
    log: [
      {
        at: now,
        text: "Saved by another version of FreeBird: kept the profile and the board, reset the rest",
      },
    ],
    note: null,
    error: null,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : now,
  });
  return restored.success ? restored.data : null;
}

/**
 * A Job Bot's state: the team bots' shared state (`teams/state.ts`) for a Job Bot's project. The service is the only
 * writer.
 */
export function createJobState(services: Pick<Services, "store" | "bus">) {
  return createTeamState<JobProject>(services, {
    key: settingsKey,
    publish: (project) => services.bus.publish({ type: "job.updated", project: structuredClone(project) }),
    restore: restoreProject,
    isBusy: isJobBusy,
    maxLog: MAX_JOB_LOG,
    missing: () => new JobError("This Job Bot has no project.", "not_found", 404),
    label: "a Job Bot's",
  });
}

export type JobState = ReturnType<typeof createJobState>;

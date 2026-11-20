import { emptyLists, emptyOffer, missingForScan } from "@mrog/clients";
import {
  ClientLists,
  ClientProject,
  DEFAULT_CLIENT_TARGET,
  isClientBusy,
  JobRoleSeat,
  Lead,
  Lookalikes,
  MAX_CLIENT_LOG,
  MAX_SEEN_COMPANIES,
  OfferProfile,
} from "@mrog/shared";

import type { Services } from "../services";
import { createTeamState } from "../teams/state";

/** A request the Client Bot can't do now: the route answers with its status and code. */
export class ClientError extends Error {
  constructor(
    message: string,
    readonly code = "invalid_request",
    readonly status = 400,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

export const settingsKey = (botId: string) => `client:${botId}`;

const ROLES = ["interviewer", "searcher", "checker", "visual"] as const;

/**
 * A project as saved, checked: fields added since it was saved get their defaults. One that doesn't parse whole
 * (saved by another version) keeps its profile, its leads, your lists, lookalikes and the companies already shown,
 * each as far as it parses, and starts the rest afresh. Null when even its team can't be read (5.7).
 */
export function restoreClientProject(saved: unknown, now: string): ClientProject | null {
  const parsed = ClientProject.safeParse(saved);
  if (parsed.success) return parsed.data;
  if (!saved || typeof saved !== "object") return null;
  const raw = saved as Record<string, unknown>;
  const roles = (raw.roles ?? {}) as Record<string, unknown>;
  const seats = ROLES.map((role) => JobRoleSeat.safeParse(roles[role]));
  if (typeof raw.botId !== "string" || seats.some((seat) => !seat.success)) return null;
  const profile = OfferProfile.safeParse(raw.profile);
  const kept = profile.success ? profile.data : emptyOffer();
  const each = <T>(list: unknown, parse: (item: unknown) => { success: boolean; data?: T }) =>
    Array.isArray(list)
      ? list.flatMap((item) => {
          const one = parse(item);
          return one.success ? [one.data as T] : [];
        })
      : [];
  const lists = ClientLists.safeParse(raw.lists);
  const lookalikes = Lookalikes.safeParse(raw.lookalikes);
  const seen = Array.isArray(raw.seen)
    ? raw.seen.filter((print): print is string => typeof print === "string")
    : [];
  const restored = ClientProject.safeParse({
    botId: raw.botId,
    status: missingForScan(kept).length > 0 ? "interview" : "ready",
    roles: Object.fromEntries(seats.map((seat, i) => [ROLES[i], seat.data])),
    profile: kept,
    leads: each(raw.leads, (item) => Lead.safeParse(item)),
    seen: seen.slice(-MAX_SEEN_COMPANIES),
    notShown: [],
    registerPages: {},
    deadPages: [],
    searchesRun: [],
    siteNotes: [],
    suggestions: [],
    lists: lists.success ? lists.data : emptyLists(),
    lookalikes: lookalikes.success
      ? lookalikes.data
      : { clients: [], matched: [], profile: null, approved: false },
    watchOff: raw.watchOff === true,
    scan: null,
    lastTarget: DEFAULT_CLIENT_TARGET,
    lastKinds: ["asking", "signs", "quiet"],
    askingCount: false,
    interview: { asked: [], skipped: [] },
    active: null,
    handoff: null,
    log: [
      {
        at: now,
        text: "Saved by another version of FreeBird: kept the profile, the board and your lists, reset the rest",
      },
    ],
    note: null,
    error: null,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : now,
  });
  return restored.success ? restored.data : null;
}

/**
 * A Client Bot's state: the team bots' shared state (`teams/state.ts`) for a Client Bot's project, checked when
 * loaded and saved at most every SAVE_EVERY_MS (5.7, 5.8). The service is the only writer.
 */
export function createClientState(services: Pick<Services, "store" | "bus">) {
  return createTeamState<ClientProject>(services, {
    key: settingsKey,
    publish: (project) => services.bus.publish({ type: "client.updated", project: structuredClone(project) }),
    restore: restoreClientProject,
    isBusy: isClientBusy,
    maxLog: MAX_CLIENT_LOG,
    missing: () => new ClientError("This Client Bot has no project.", "not_found", 404),
    label: "a Client Bot's",
  });
}

export type ClientState = ReturnType<typeof createClientState>;

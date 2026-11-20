import { clip } from "@mrog/jobs";
import type { JobRoleSeat, JobStatus, Message, SiteNote } from "@mrog/shared";

import type { Services } from "../services";

/**
 * A team bot's project state (the Job Bot's and the Client Bot's, one copy): one in-memory project per bot, checked
 * when loaded, saved to settings and published at most every SAVE_EVERY_MS. The service is the only writer. Each bot
 * passes its own project type, settings key, event and restore.
 */

/** A project is saved and published at most this often; the last change is always saved. */
export const SAVE_EVERY_MS = 400;

/** What every team bot's project has, whatever else it holds. */
export interface TeamProject<Role extends string = string> {
  botId: string;
  status: JobStatus;
  roles: Record<Role, JobRoleSeat>;
  active: { role: Role; url: string | null; since: string } | null;
  handoff: { url: string; reason: string; since: string } | null;
  askingCount: boolean;
  scan: { number: number; visualPages: number; endedAt: string | null; stopReason: string | null } | null;
  siteNotes: SiteNote[];
  log: { at: string; text: string }[];
  note: string | null;
}

export interface TeamStateOptions<P> {
  /** Where the project is saved in settings. */
  key: (botId: string) => string;
  /** Publishes a copy of the project to the screen. */
  publish: (project: P) => void;
  /** The project as saved, checked (new fields get their defaults), or null when it can't be read at all. */
  restore: (saved: unknown, now: string) => P | null;
  /** Whether a status means work was running (a project saved like that was cut off when the app closed). */
  isBusy: (status: JobStatus) => boolean;
  maxLog: number;
  /** The error for a bot with no project. */
  missing: () => Error;
  /** For warnings: "a Job Bot's". */
  label: string;
}

export function createTeamState<P extends TeamProject>(
  { store, bus }: Pick<Services, "store" | "bus">,
  options: TeamStateOptions<P>,
) {
  const projects = new Map<string, P>();
  const now = () => new Date().toISOString();

  /** A project saved while a scan ran didn't finish it: the app closed. */
  const interrupted = (saved: P): P => ({
    ...saved,
    status: "ready",
    active: null,
    handoff: null,
    askingCount: false,
    scan: saved.scan && {
      ...saved.scan,
      endedAt: saved.scan.endedAt ?? now(),
      stopReason: saved.scan.stopReason ?? "The app closed during the scan.",
    },
    note: "The app closed during a scan. Start a new scan when you're ready.",
  });

  const load = (botId: string): P | null => {
    const live = projects.get(botId);
    if (live) return live;
    const saved = options.restore(store.settings.get<unknown>(options.key(botId)), now());
    if (!saved) return null;
    const project = options.isBusy(saved.status) ? interrupted(saved) : saved;
    projects.set(botId, project);
    return project;
  };

  /** When each project was last saved and published, and the save waiting to catch up with later changes. */
  const lastSaved = new Map<string, number>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const saveNow = (project: P) => {
    const waiting = pending.get(project.botId);
    if (waiting) clearTimeout(waiting);
    pending.delete(project.botId);
    lastSaved.set(project.botId, Date.now());
    store.settings.set(options.key(project.botId), project);
    options.publish(project);
  };

  /**
   * Saves and publishes a project, at most every SAVE_EVERY_MS: a full board is megabytes, a scan changes it several
   * times a page, and each save sent all of it to the screen. Changes in between are made in memory at once
   * (everything reads that), and one save follows them.
   */
  const persist = (project: P) => {
    const since = Date.now() - (lastSaved.get(project.botId) ?? 0);
    if (since >= SAVE_EVERY_MS && !pending.has(project.botId)) return saveNow(project);
    if (pending.has(project.botId)) return;
    const timer = setTimeout(
      () => {
        const live = projects.get(project.botId);
        pending.delete(project.botId);
        if (!live) return;
        try {
          saveNow(live);
        } catch (error) {
          // The store closed first (the app is shutting down): the flush on closing saved what it could.
          console.warn(`[teams] couldn't save ${options.label} project: ${(error as Error).message}`);
        }
      },
      Math.max(0, SAVE_EVERY_MS - since),
    );
    timer.unref?.();
    pending.set(project.botId, timer);
  };

  /** Saves every project with a save still waiting (the app is closing). */
  const flush = () => {
    for (const botId of pending.keys()) {
      const live = projects.get(botId);
      if (live) saveNow(live);
    }
  };

  /** One short plain-English line for the activity list, keeping the last `maxLog`. */
  const logLine = (project: P, text: string) => {
    project.log = [...project.log, { at: now(), text: clip(text, 200) }].slice(-options.maxLog);
  };

  /** Changes the project, saves it and publishes it. Null when the project is gone. */
  const change = (botId: string, fn: (project: P) => void): P | null => {
    const project = load(botId);
    if (!project) return null;
    fn(project);
    persist(project);
    return project;
  };

  const need = (botId: string): P => {
    const project = load(botId);
    if (!project) throw options.missing();
    return project;
  };

  /** A message from the bot in its own chat. */
  const say = (botId: string, text: string): Message | null => {
    const bot = store.bots.get(botId);
    if (!bot) return null;
    const message = store.messages.create({
      threadId: bot.threadId,
      role: "bot",
      botId,
      parts: [{ type: "text", text }],
    });
    bus.publish({ type: "message.created", message });
    return message;
  };

  /** A new project, saved and published. */
  const adopt = (project: P) => {
    projects.set(project.botId, project);
    saveNow(project);
    return project;
  };

  const forget = (botId: string) => {
    const waiting = pending.get(botId);
    if (waiting) clearTimeout(waiting);
    pending.delete(botId);
    projects.delete(botId);
    store.settings.delete(options.key(botId));
  };

  /** The projects saved earlier (a bot deleted while the app was closed has none). */
  const saved = (botId: string) => projects.get(botId) ?? store.settings.get<P>(options.key(botId)) ?? null;

  return { load, persist, flush, logLine, change, need, say, adopt, forget, saved, now };
}

export type TeamState<P extends TeamProject> = ReturnType<typeof createTeamState<P>>;

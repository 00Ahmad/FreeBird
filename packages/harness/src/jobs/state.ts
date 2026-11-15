import { clip } from "@mrog/jobs";
import { isJobBusy, MAX_JOB_LOG, type JobProject, type Message } from "@mrog/shared";

import type { Services } from "../services";

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
 * A Job Bot's state: one in-memory project per bot, saved to settings and published whole on every change. The
 * service is the only writer.
 */
export function createJobState({ store, bus }: Pick<Services, "store" | "bus">) {
  const projects = new Map<string, JobProject>();
  const now = () => new Date().toISOString();

  /** A project saved while a scan ran didn't finish it: the app closed. */
  const interrupted = (saved: JobProject): JobProject => ({
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

  const load = (botId: string): JobProject | null => {
    const live = projects.get(botId);
    if (live) return live;
    const saved = store.settings.get<JobProject>(settingsKey(botId));
    if (!saved) return null;
    const project = isJobBusy(saved.status) ? interrupted(saved) : saved;
    projects.set(botId, project);
    return project;
  };

  const persist = (project: JobProject) => {
    store.settings.set(settingsKey(project.botId), project);
    bus.publish({ type: "job.updated", project: structuredClone(project) });
  };

  /** One short plain-English line for the activity list, keeping the last MAX_JOB_LOG. */
  const logLine = (project: JobProject, text: string) => {
    project.log = [...project.log, { at: now(), text: clip(text, 200) }].slice(-MAX_JOB_LOG);
  };

  /** Changes the project, saves it and publishes it. Null when the project is gone. */
  const change = (botId: string, fn: (project: JobProject) => void): JobProject | null => {
    const project = load(botId);
    if (!project) return null;
    fn(project);
    persist(project);
    return project;
  };

  const need = (botId: string): JobProject => {
    const project = load(botId);
    if (!project) throw new JobError("This Job Bot has no project.", "not_found", 404);
    return project;
  };

  /** A message from the Job Bot in its own chat. */
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
  const adopt = (project: JobProject) => {
    projects.set(project.botId, project);
    persist(project);
    return project;
  };

  const forget = (botId: string) => {
    projects.delete(botId);
    store.settings.delete(settingsKey(botId));
  };

  /** The projects saved earlier (a bot deleted while the app was closed has none). */
  const saved = (botId: string) =>
    projects.get(botId) ?? store.settings.get<JobProject>(settingsKey(botId)) ?? null;

  return { load, persist, logLine, change, need, say, adopt, forget, saved, now };
}

export type JobState = ReturnType<typeof createJobState>;

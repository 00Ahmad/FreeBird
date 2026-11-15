import { clip } from "@mrog/jobs";
import { isClientBusy, MAX_CLIENT_LOG, type ClientProject, type Message } from "@mrog/shared";

import type { Services } from "../services";

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

/**
 * A Client Bot's state: one in-memory project per bot, saved to settings and published whole on every change. The
 * service is the only writer. (The same shape as a Job Bot's state, for its own project type.)
 */
export function createClientState({ store, bus }: Pick<Services, "store" | "bus">) {
  const projects = new Map<string, ClientProject>();
  const now = () => new Date().toISOString();

  /** A project saved while a scan ran didn't finish it: the app closed. */
  const interrupted = (saved: ClientProject): ClientProject => ({
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

  const load = (botId: string): ClientProject | null => {
    const live = projects.get(botId);
    if (live) return live;
    const saved = store.settings.get<ClientProject>(settingsKey(botId));
    if (!saved) return null;
    const project = isClientBusy(saved.status) ? interrupted(saved) : saved;
    projects.set(botId, project);
    return project;
  };

  const persist = (project: ClientProject) => {
    store.settings.set(settingsKey(project.botId), project);
    bus.publish({ type: "client.updated", project: structuredClone(project) });
  };

  const logLine = (project: ClientProject, text: string) => {
    project.log = [...project.log, { at: now(), text: clip(text, 200) }].slice(-MAX_CLIENT_LOG);
  };

  const change = (botId: string, fn: (project: ClientProject) => void): ClientProject | null => {
    const project = load(botId);
    if (!project) return null;
    fn(project);
    persist(project);
    return project;
  };

  const need = (botId: string): ClientProject => {
    const project = load(botId);
    if (!project) throw new ClientError("This Client Bot has no project.", "not_found", 404);
    return project;
  };

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

  const adopt = (project: ClientProject) => {
    projects.set(project.botId, project);
    persist(project);
    return project;
  };

  const forget = (botId: string) => {
    projects.delete(botId);
    store.settings.delete(settingsKey(botId));
  };

  const saved = (botId: string) =>
    projects.get(botId) ?? store.settings.get<ClientProject>(settingsKey(botId)) ?? null;

  return { load, persist, logLine, change, need, say, adopt, forget, saved, now };
}

export type ClientState = ReturnType<typeof createClientState>;

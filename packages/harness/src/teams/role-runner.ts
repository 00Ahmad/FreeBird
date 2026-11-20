import { messageText, type Bot, type Message, type Thread } from "@mrog/shared";

import type { Phase } from "../jobs/phase";
import type { Services } from "../services";
import { TurnCancelled } from "../turns";
import { Halt } from "./halt";
import type { TeamProject, TeamState } from "./state";

export interface RoleReply<Capture> {
  /** The role's own words (relayed to the user for the Interviewer). */
  text: string;
  capture: Capture;
  /** The model failed; the caller decides whether to go on. */
  error?: string;
}

export interface RunOptions<Capture> {
  phase?: Phase;
  capture?: Capture;
  url?: string | null;
  /** What the task is kept as once the turn has ended (a Checker's page, shortened: it stays in the thread). */
  keepAs?: (task: string) => string;
}

/** The part of a team the runner needs: the pair thread of the bot and one of its roles. */
export interface PairSource<Role extends string> {
  ensurePair(botId: string, roleBot: Bot, role: Role): Thread | undefined;
}

/**
 * Gives a role one task in its pair thread with its team bot and waits for its turn to end (one copy for the Job Bot
 * and the Client Bot). The task carries everything the role needs (a turn reads nothing earlier). Throws Halt when
 * the work is stopped.
 */
export function createTeamRoleRunner<
  Role extends string,
  P extends TeamProject<Role>,
  Capture extends object,
>(services: Services, state: TeamState<P>, team: PairSource<Role>) {
  const { store, bus, turns } = services;
  /** What each role bot's current turn handed back, written by its own tools. */
  const captures = new Map<string, Capture>();

  const run = async (
    botId: string,
    role: Role,
    task: string,
    signal: AbortSignal,
    options: RunOptions<Capture> = {},
  ): Promise<RoleReply<Capture>> => {
    const project = state.load(botId);
    const roleBot = project && store.bots.get(project.roles[role].botId);
    const pair = roleBot && team.ensurePair(botId, roleBot, role);
    if (signal.aborted || !project || !roleBot || !pair) throw new Halt();
    const sent = store.messages.create({
      threadId: pair.id,
      role: "bot",
      botId,
      parts: [{ type: "text", text: task }],
    });
    bus.publish({ type: "message.created", message: sent });
    const capture = options.capture ?? ({} as Capture);
    captures.set(roleBot.id, capture);
    state.change(botId, (p) => {
      (p as TeamProject<Role>).active = { role, url: options.url ?? null, since: state.now() };
    });
    let reply: Message;
    try {
      reply = await turns.start(pair, store.bots.get(roleBot.id) ?? roleBot, "routine", {
        delegated: true,
        standalone: true,
        parentSignal: signal,
        ...(options.phase ? { surface: options.phase.surface } : {}),
      });
    } catch (error) {
      if (error instanceof TurnCancelled) throw new Halt();
      throw error;
    } finally {
      if (captures.get(roleBot.id) === capture) captures.delete(roleBot.id);
      state.change(botId, (p) => {
        if (p.active?.role === role) p.active = null;
      });
    }
    // Kept in the thread for you to follow the work, but without the whole page: every page read stayed there in full.
    if (options.keepAs) {
      const kept = store.messages.update(sent.id, { parts: [{ type: "text", text: options.keepAs(task) }] });
      if (kept) bus.publish({ type: "message.updated", message: kept });
    }
    if (signal.aborted) throw new Halt();
    const text = messageText(reply).trim();
    if (reply.status === "error")
      return {
        text,
        capture,
        error: reply.parts.find((part) => part.type === "error")?.message ?? "The model didn't answer.",
      };
    // Stopped from its team thread (Stop or Clear chat there): the work stops too.
    if (reply.status !== "done") throw new Halt();
    return { text, capture };
  };

  return { run, captureOf: (roleBotId: string) => captures.get(roleBotId) };
}

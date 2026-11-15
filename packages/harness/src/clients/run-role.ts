import { messageText, type ClientRole, type Message } from "@mrog/shared";

import type { Phase } from "../jobs/phase";
import { Halt } from "../jobs/run-role";
import type { Services } from "../services";
import { TurnCancelled } from "../turns";
import type { ClientState } from "./state";
import type { ClientTeam } from "./team";
import type { Capture } from "./tools";

export { Halt } from "../jobs/run-role";

export interface RoleReply {
  text: string;
  capture: Capture;
  error?: string;
}

/**
 * Gives a role one task in its pair thread with the Client Bot and waits for its turn to end. The task carries
 * everything the role needs. Throws Halt when the work is stopped.
 */
export function createRoleRunner(services: Services, state: ClientState, team: ClientTeam) {
  const { store, bus, turns } = services;
  const captures = new Map<string, Capture>();

  const run = async (
    botId: string,
    role: ClientRole,
    task: string,
    signal: AbortSignal,
    options: { phase?: Phase; capture?: Capture; url?: string | null } = {},
  ): Promise<RoleReply> => {
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
    const capture = options.capture ?? {};
    captures.set(roleBot.id, capture);
    state.change(botId, (p) => {
      p.active = { role, url: options.url ?? null, since: state.now() };
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
    if (signal.aborted) throw new Halt();
    const text = messageText(reply).trim();
    if (reply.status === "error")
      return {
        text,
        capture,
        error: reply.parts.find((part) => part.type === "error")?.message ?? "The model didn't answer.",
      };
    if (reply.status !== "done") throw new Halt();
    return { text, capture };
  };

  return { run, captureOf: (roleBotId: string) => captures.get(roleBotId) };
}

export type RoleRunner = ReturnType<typeof createRoleRunner>;

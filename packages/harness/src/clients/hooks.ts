import type { Message, Thread } from "@mrog/shared";
import type { ToolSpec } from "@mrog/tools";

import type { Services } from "../services";
import { ROLES } from "./roles";
import type { RoleRunner } from "./run-role";
import type { ClientTeam } from "./team";
import { roleTool } from "./tools";

const MAX_STEPS = { interviewer: 4, searcher: 4, checker: 4, visual: 15 } as const;

/**
 * Plugs the Client Bot into the app. Every turn extension set before (the Coding Bot's, the Job Bot's) is kept and
 * called for bots that aren't the Client Bot's: each slot is chained, never replaced.
 */
export function installClientHooks(
  services: Services,
  team: ClientTeam,
  roles: RoleRunner,
  hear: (botId: string, message: Message) => void,
) {
  const { agent, turns, store, bus } = services;

  agent.toolSources.push((bot): ToolSpec[] => {
    const found = team.roleOf(bot);
    const make = found && roleTool[found.role];
    return make ? [make(roles.captureOf(bot.id) ?? {})] : [];
  });

  agent.promptSources.push((bot) => {
    const found = team.roleOf(bot);
    return found ? { extra: [ROLES[found.role].rules] } : {};
  });

  const baseOptions = turns.extensions.turnOptions;
  turns.extensions.turnOptions = (bot, thread, info) => {
    const options = baseOptions?.(bot, thread, info) ?? {};
    const found = team.roleOf(bot);
    if (!found) return options;
    const plain = { ...options, selfCheck: false, stepLimitNote: false, maxSteps: MAX_STEPS[found.role] };
    return found.role === "visual" ? plain : { ...plain, think: false, thinkOff: true };
  };

  const DROPS = ["save it with remember", "call update_plan"];
  const baseExtras = turns.extensions.promptExtras;
  turns.extensions.promptExtras = (bot, thread, info) => {
    const result = baseExtras?.(bot, thread, info) ?? {};
    if (!team.roleOf(bot)) return result;
    return {
      ...result,
      extra: (result.extra ?? []).filter((line) => !DROPS.some((drop) => line.includes(drop))),
    };
  };

  const baseRefuses = turns.extensions.refuses;
  turns.extensions.refuses = (bot) =>
    bot.client
      ? "A Client Bot runs its team instead of answering with a model."
      : (baseRefuses?.(bot) ?? null);

  const baseHandles = turns.extensions.handles;
  turns.extensions.handles = (thread: Thread, message: Message) => {
    const members = thread.memberIds.flatMap((id) => store.bots.get(id) ?? []);
    const owner = members.find((bot) => bot.client);
    if (thread.kind === "direct" && owner) {
      hear(owner.id, message);
      return true;
    }
    const role = members.find((bot) => team.roleOf(bot));
    const lead = owner ?? (role?.parentId ? store.bots.get(role.parentId) : undefined);
    if (lead?.client) {
      const reply = store.messages.create({
        threadId: thread.id,
        role: "bot",
        botId: lead.id,
        parts: [
          {
            type: "text",
            text: `${lead.name} runs its team from its own chat. Tell ${lead.name} what you need there; this thread is the team's work log.`,
          },
        ],
      });
      bus.publish({ type: "message.created", message: reply });
      return true;
    }
    return baseHandles?.(thread, message) ?? false;
  };
}

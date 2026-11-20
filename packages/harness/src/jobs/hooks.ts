import type { Message, Thread } from "@mrog/shared";
import type { ToolSpec } from "@mrog/tools";

import type { Services } from "../services";
import { checkerNudge, checkerSteer } from "../teams/checker-nudge";
import { ROLES } from "./roles";
import type { RoleRunner } from "./run-role";
import type { JobTeam } from "./team";
import { roleTool } from "./tools";

/** Said once to a Checker that is ending its turn without having called finish_job. */
export const CHECKER_NUDGE = checkerNudge("finish_job");

/** The most model rounds a role's turn gets: each has one tool to call (the Visual helper clicks around). */
const MAX_STEPS = { interviewer: 4, searcher: 4, checker: 4, visual: 15 } as const;

/**
 * Plugs the Job Bot into the app. Every turn extension the Coding Bot (or anything else) set first is kept and
 * called for bots that aren't the Job Bot's: the slots hold one function each, so each is chained, never replaced.
 */
export function installJobHooks(
  services: Services,
  team: JobTeam,
  roles: RoleRunner,
  hear: (botId: string, message: Message) => void,
) {
  const { agent, turns, store, bus } = services;

  agent.toolSources.push((bot): ToolSpec[] => {
    const found = team.roleOf(bot);
    const make = found && roleTool[found.role];
    // A turn that isn't the loop's (the Details panel listing tools) gets a capture nothing reads.
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
    // One page or one reply per turn: no self-check pass, no thinking before each move (it doubles a turn's time).
    const plain = { ...options, selfCheck: false, stepLimitNote: false, maxSteps: MAX_STEPS[found.role] };
    if (found.role === "visual") return plain;
    const capture = roles.captureOf(bot.id);
    // A small model often writes its report as text and stops: told once, in the same turn, to call its tool.
    const steer =
      found.role === "checker" && capture
        ? { steer: checkerSteer("finish_job", () => !!capture.result) }
        : {};
    return { ...plain, think: false, thinkOff: true, ...steer };
  };

  // The lines every bot gets about a checklist and memory don't fit a role with one tool.
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

  // A Job Bot has no model: nothing starts a model turn for it.
  const baseRefuses = turns.extensions.refuses;
  turns.extensions.refuses = (bot) =>
    bot.job ? "A Job Bot runs its team instead of answering with a model." : (baseRefuses?.(bot) ?? null);

  const baseHandles = turns.extensions.handles;
  turns.extensions.handles = (thread: Thread, message: Message) => {
    const members = thread.memberIds.flatMap((id) => store.bots.get(id) ?? []);
    const jobBot = members.find((bot) => bot.job);
    if (thread.kind === "direct" && jobBot) {
      hear(jobBot.id, message);
      return true;
    }
    // The team's work log: nobody answers there, and a role bot's own chat is not for giving it work.
    const role = members.find((bot) => team.roleOf(bot));
    const owner = jobBot ?? (role?.parentId ? store.bots.get(role.parentId) : undefined);
    if (owner?.job) {
      const reply = store.messages.create({
        threadId: thread.id,
        role: "bot",
        botId: owner.id,
        parts: [
          {
            type: "text",
            text: `${owner.name} runs its team from its own chat. Tell ${owner.name} what you need there; this thread is the team's work log.`,
          },
        ],
      });
      bus.publish({ type: "message.created", message: reply });
      return true;
    }
    return baseHandles?.(thread, message) ?? false;
  };
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { assignedSkillsSection, pickAssigned } from "@mrog/skills";
import { SKILL_TOOLS, type Bot, type Skill } from "@mrog/shared";

import { fail, parse } from "../http";
import type { Services } from "../services";
import type { Skills } from "./install";

const ASSIGNED_KEY = "skills.assigned";

/** The names a bot starts with when nobody has chosen any for it (a Coding Bot's role), or null for none. */
export type AssignedDefaults = (bot: Bot) => string[] | null;

export interface AssignedSkills {
  defaults: AssignedDefaults[];
  /** The names assigned to a bot, and whether they are its defaults (nobody has changed them). */
  names(bot: Bot): { names: string[]; defaults: boolean };
  /** The bot's assigned skills that exist, in the order they were assigned. */
  skillsFor(bot: Bot): Skill[];
  set(botId: string, names: string[]): string[];
}

const Names = z.array(z.string().trim().min(1).max(40)).max(20);

/**
 * Skills assigned to a bot: their steps go into its prompt on every turn (see `assignedSkillsSection`), so a bot that
 * works to a fixed routine still applies them. Only while it may use skills at all ("Can use skills").
 */
export function installAssignedSkills(services: Services, skills: Skills): AssignedSkills {
  const { store, agent, bus } = services;
  const saved = () => store.settings.get<Record<string, string[]>>(ASSIGNED_KEY) ?? {};
  const assigned: AssignedSkills = {
    defaults: [],
    names: (bot) => {
      const own = saved()[bot.id];
      if (own) return { names: own, defaults: false };
      for (const defaults of assigned.defaults) {
        const names = defaults(bot);
        if (names) return { names, defaults: true };
      }
      return { names: [], defaults: true };
    },
    skillsFor: (bot) => pickAssigned(skills.skillsFor(bot), assigned.names(bot).names),
    set: (botId, names) => {
      // The first spelling of a name given twice is the one kept.
      const unique = names.filter(
        (name, at) => names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === at,
      );
      store.settings.set(ASSIGNED_KEY, { ...saved(), [botId]: unique });
      bus.publish({ type: "data.changed", keys: ["skills"] });
      return unique;
    },
  };
  agent.promptSources.push((bot) => {
    if (!SKILL_TOOLS.every((name) => agent.allows(bot, name))) return {};
    const section = assignedSkillsSection(assigned.skillsFor(bot));
    return section ? { extra: [section] } : {};
  });
  // A deleted bot's choice goes with it.
  services.disposers.push(
    bus.subscribe((event) => {
      if (event.type !== "bot.deleted") return;
      const all = saved();
      if (!(event.botId in all)) return;
      delete all[event.botId];
      store.settings.set(ASSIGNED_KEY, all);
    }),
  );
  return assigned;
}

export function registerAssignedSkillRoutes(app: FastifyInstance, services: Services) {
  const { store } = services;
  app.get<{ Params: { id: string } }>("/api/bots/:id/assigned-skills", async (request, reply) => {
    const bot = store.bots.get(request.params.id);
    if (!bot) return fail(reply, 404, "not_found", "No bot has this id.");
    return services.assignedSkills.names(bot);
  });

  app.put<{ Params: { id: string } }>("/api/bots/:id/assigned-skills", async (request, reply) => {
    const body = parse(z.object({ names: Names }), request.body, reply);
    if (!body) return reply;
    if (!store.bots.get(request.params.id)) return fail(reply, 404, "not_found", "No bot has this id.");
    return { names: services.assignedSkills.set(request.params.id, body.names), defaults: false };
  });
}

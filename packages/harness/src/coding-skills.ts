import { CODING_ROLES, type Bot, type CodingProject, type CodingRole } from "@mrog/shared";

import type { AssignedDefaults } from "./skills/assigned";
import type { SkillOwners } from "./skills/install";

/**
 * A Coding Bot's Planner, Developer and QA have the skills given to the Coding Bot itself (the whole team's), as well
 * as their own and the shared ones. Each role's own skills stay its own: the Planner doesn't see the Developer's.
 */
export const codingTeamSkills =
  (getBot: (id: string) => Bot | null | undefined): SkillOwners =>
  (bot) => {
    const parent = bot.parentId ? getBot(bot.parentId) : null;
    return parent?.coding ? [parent.id] : [];
  };

/**
 * The built-in skills each role applies on every card until you choose others in Details → Skills: each role's own,
 * written for its tools and limits. The general ones don't fit as well: `refactor` and `write-tests` say to write and
 * run tests (the Developer runs nothing, QA writes nothing), and `project-plan` wants owners, dates and a deadline.
 */
export const CODING_ROLE_SKILLS: Record<CodingRole, string[]> = {
  planner: ["coding-planner"],
  developer: ["coding-developer"],
  qa: ["coding-qa"],
};

/** Which role of its Coding Bot a bot is, or null for any other bot. */
export function codingRoleOf(
  bot: Bot,
  getBot: (id: string) => Bot | null | undefined,
  getProject: (codingBotId: string) => CodingProject | null,
): CodingRole | null {
  const parent = bot.parentId ? getBot(bot.parentId) : null;
  if (!parent?.coding) return null;
  const project = getProject(parent.id);
  return project ? (CODING_ROLES.find((role) => project.roles[role].botId === bot.id) ?? null) : null;
}

export const codingRoleDefaults =
  (
    getBot: (id: string) => Bot | null | undefined,
    getProject: (codingBotId: string) => CodingProject | null,
  ): AssignedDefaults =>
  (bot) => {
    const role = codingRoleOf(bot, getBot, getProject);
    return role ? CODING_ROLE_SKILLS[role] : null;
  };

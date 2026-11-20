import { createHash } from "node:crypto";

import { BUILTIN_SKILLS, mergeSkills, skillsPromptLine } from "@mrog/skills";
import { SKILL_TOOLS, type Bot, type Skill } from "@mrog/shared";
import type { Store } from "@mrog/store";

import type { Services } from "../services";
import { findSkillsTool, useSkillTool } from "./tools";

const SEEDED_KEY = "skills.builtin";

/** A fingerprint of a skill's text, to tell whether you have edited a built-in one. */
export const skillHash = (skill: { description: string; prompt: string }) =>
  createHash("sha256").update(`${skill.description}\n${skill.prompt}`).digest("hex").slice(0, 16);

/**
 * Adds the built-in skills as skills shared by every bot, and keeps them up to date:
 * - one never added before is added (unless you already have a shared skill with its name);
 * - one added before whose text you haven't changed gets the newer text when a version improves it;
 * - one you edited, renamed or deleted is left alone, and never comes back.
 * The record of what was added is name → fingerprint of the text as added.
 */
export function seedBuiltinSkills(store: Store): { added: number; updated: number } {
  const saved = store.settings.get<Record<string, string> | string[]>(SEEDED_KEY) ?? {};
  // An early record kept names only: they count as added, with text of unknown origin (never replaced).
  const record: Record<string, string> = Array.isArray(saved)
    ? Object.fromEntries(saved.map((name) => [name, ""]))
    : { ...saved };
  const shared = new Map(
    store.skills
      .list()
      .filter((skill) => skill.botId === null)
      .map((skill) => [skill.name.toLowerCase(), skill]),
  );
  let added = 0;
  let updated = 0;
  for (const builtin of BUILTIN_SKILLS) {
    const latest = skillHash(builtin);
    const existing = shared.get(builtin.name.toLowerCase());
    if (!(builtin.name in record)) {
      if (!existing) {
        store.skills.add({
          botId: null,
          name: builtin.name,
          prompt: builtin.prompt,
          description: builtin.description,
        });
        added += 1;
      }
      record[builtin.name] = existing ? "" : latest;
      continue;
    }
    const asAdded = record[builtin.name];
    // Still exactly as FreeBird added it, and FreeBird has better text now: update it.
    if (existing && asAdded && asAdded !== latest && skillHash(existing) === asAdded) {
      store.skills.update(existing.id, { prompt: builtin.prompt, description: builtin.description });
      record[builtin.name] = latest;
      updated += 1;
    }
  }
  store.settings.set(SEEDED_KEY, record);
  return { added, updated };
}

/**
 * Which bots' own skills a bot also has, besides its own and the shared ones (a Coding Bot's role has the Coding
 * Bot's). Registered by the feature that makes such teams.
 */
export type SkillOwners = (bot: Bot) => string[];

export interface Skills {
  owners: SkillOwners[];
  /** The bot's skills: its own, then its teams', then the shared ones; on a name clash the more specific one wins. */
  skillsFor(bot: Bot): Skill[];
}

/**
 * Skills a bot looks up and uses by itself: the two tools for every bot, and one line in its prompt naming its skills.
 * The line is only there when the bot may use the tools ("Can use skills" on, and its coordinator lets it).
 */
export function installSkills(services: Services): Skills {
  const { store, agent } = services;
  seedBuiltinSkills(store);
  const ownOf = (botId: string) => store.skills.list(botId).filter((skill) => skill.botId === botId);
  const skills: Skills = {
    owners: [],
    skillsFor: (bot) => {
      const teams = [...new Set(skills.owners.flatMap((owners) => owners(bot)))].filter(
        (id) => id !== bot.id,
      );
      const shared = store.skills.list(bot.id).filter((skill) => skill.botId === null);
      return mergeSkills([ownOf(bot.id), ...teams.map(ownOf), shared]);
    },
  };
  agent.toolSources.push((bot) => {
    const list = () => skills.skillsFor(bot);
    return [findSkillsTool(list), useSkillTool(list)];
  });
  agent.promptSources.push((bot) => {
    if (!SKILL_TOOLS.every((name) => agent.allows(bot, name))) return {};
    const line = skillsPromptLine(skills.skillsFor(bot).map((skill) => skill.name));
    return line ? { extra: [line] } : {};
  });
  return skills;
}

import { z } from "zod";

import { findSkills, whatFor } from "@mrog/skills";
import type { Skill } from "@mrog/shared";
import { defineTool, safe, type ToolSpec } from "@mrog/tools";

/**
 * The two tools that let a bot use skills by itself: find one by what it does, then load it and follow it. Both only
 * read the bot's skills (its own and the shared ones); nothing leaves the app. Switched off together by the bot's
 * "Can use skills" switch, which is just these two names in its tool list.
 */

export const findSkillsTool = (skills: () => Skill[]): ToolSpec =>
  defineTool({
    name: "find_skills",
    description:
      "Search your skills (step-by-step guides for common tasks) by a few words about the task. Returns the best matches with what each is for; then call use_skill with a name.",
    args: z.object({ query: z.string().trim().max(200).default("") }),
    risk: () => safe("Look through its skills"),
    run: async ({ query }) => {
      const found = findSkills(skills(), query, query ? 8 : 60);
      if (found.length === 0) return "No skill matches. Carry on without one.";
      return found.map((skill) => `- ${skill.name}: ${whatFor(skill)}`).join("\n");
    },
  });

export const useSkillTool = (skills: () => Skill[]): ToolSpec =>
  defineTool({
    name: "use_skill",
    description: "Load one of your skills by its name and follow its steps for the current task.",
    args: z.object({ name: z.string().trim().min(1).max(60) }),
    risk: ({ name }) => safe(`Use the skill ${name}`),
    run: async ({ name }) => {
      const wanted = name.replace(/^\//, "").toLowerCase();
      const all = skills();
      const skill = all.find((s) => s.name.toLowerCase() === wanted);
      if (!skill) {
        const close = findSkills(all, wanted.replace(/[-_]/g, " "), 3).map((s) => s.name);
        return `No skill is called "${name}".${close.length > 0 ? ` Did you mean: ${close.join(", ")}?` : ""}`;
      }
      return [
        `Skill "${skill.name}". Follow these steps for the user's current request; the user's own instructions come first.`,
        "",
        skill.prompt,
      ].join("\n");
    },
  });

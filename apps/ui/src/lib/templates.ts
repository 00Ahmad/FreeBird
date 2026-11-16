import { Avatar, BotInstructions, BotLabel, BotName, ModelRef, type Bot, type Skill } from "@mrog/shared";
import { z } from "zod";

import type { BotTemplate } from "../hooks/team";
import { api } from "./api";

const Template = z.object({
  // Files exported before the app was renamed from OpenMrogBog say "openmrogbog.bot".
  kind: z.enum(["freebird.bot", "openmrogbog.bot"]),
  version: z.literal(1),
  bot: z.object({
    name: BotName,
    label: BotLabel.nullable(),
    avatar: Avatar,
    instructions: BotInstructions,
    model: ModelRef.nullable(),
  }),
  skills: z
    .array(z.object({ name: z.string(), prompt: z.string(), description: z.string().max(400).optional() }))
    .max(100),
});

/** "Share as template": saves a file someone else can import. No chat history, memory, files or keys. */
export function exportTemplate(bot: Bot, skills: Skill[]) {
  const template: BotTemplate = {
    kind: "freebird.bot",
    version: 1,
    bot: {
      name: bot.name,
      label: bot.label,
      avatar: bot.avatar,
      instructions: bot.instructions,
      model: bot.model,
    },
    skills: skills
      .filter((skill) => skill.botId === bot.id)
      .map(({ name, prompt, description }) => ({ name, prompt, description })),
  };
  const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${bot.name.replace(/[^\w -]+/g, "").trim() || "bot"}.mrogbot.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** Opens a file picker and creates a bot from a template file. */
export function importTemplate(): Promise<Bot | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const template = Template.parse(JSON.parse(await file.text()));
        const { bot } = await api<{ bot: Bot }>("/bots", { method: "POST", body: template.bot });
        for (const skill of template.skills) {
          await api("/skills", { method: "POST", body: { botId: bot.id, ...skill } }).catch(() => {});
        }
        resolve(bot);
      } catch (error) {
        window.alert(`That file isn't a bot template: ${(error as Error).message}`);
        resolve(null);
      }
    });
    input.click();
  });
}

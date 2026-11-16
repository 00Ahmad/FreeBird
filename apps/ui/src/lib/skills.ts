import { setToolEnabled, SKILL_TOOLS, type Bot } from "@mrog/shared";

/** Whether the bot may find and use skills by itself: neither skill tool is switched off in its list. */
export const canUseSkills = (bot: Pick<Bot, "tools">) =>
  SKILL_TOOLS.every((name) => !bot.tools.exclude.includes(name));

/** The bot's tool list with both skill tools on or off; its other switched-off tools are kept. */
export const withSkills = (tools: Bot["tools"], on: boolean): Bot["tools"] =>
  SKILL_TOOLS.reduce((next, name) => setToolEnabled(next, name, on), tools);

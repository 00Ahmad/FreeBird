import { messageText } from "@mrog/shared";

import type { Services } from "../services";

/**
 * A team bot's last reply before your newest message in its chat: the question you are answering ("the first", "yes",
 * "60k" mean nothing without it), or null. One copy for the Job Bot and the Client Bot.
 */
export function lastQuestion({ store }: Pick<Services, "store">, botId: string): string | null {
  const bot = store.bots.get(botId);
  if (!bot) return null;
  const messages = store.messages.list(bot.threadId, { limit: 20 });
  const you = messages.findLastIndex((message) => message.role === "user");
  const before = messages
    .slice(0, Math.max(0, you))
    .findLast((message) => message.role === "bot" && message.botId === botId && message.status === "done");
  return before ? messageText(before).trim() || null : null;
}

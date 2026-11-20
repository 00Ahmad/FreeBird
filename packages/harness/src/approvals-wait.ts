import type { Services } from "./services";

/**
 * A bot whose owner chose "wait for my answer" (Details → Approvals): its approval cards, and those of the helpers it
 * made, stay open until answered instead of being dropped unrun after 15 minutes. Waiting holds no slot on the shared
 * model (only a streaming request does), and the desktop notice for a waiting bot was already raised; Stop still ends
 * the wait.
 */
export function installApprovalsWait({ agent, store }: Pick<Services, "agent" | "store">) {
  agent.approvals.keepWaiting.push((botId) => {
    const bot = store.bots.get(botId);
    if (!bot) return false;
    // A helper's card shows in its coordinator's chat, so the coordinator's choice is the one that counts.
    const owner = bot.parentId ? store.bots.get(bot.parentId) : bot;
    return owner?.approvalsWait === true;
  });
}

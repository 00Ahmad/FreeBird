import type { QueryClient } from "@tanstack/react-query";

import type { Bot, CodingProject, CodingStatus } from "@mrog/shared";

import { attentionFor } from "../lib/codingAttention";
import { useUi } from "../state";
import { isWatching } from "../unread";
import { BOTS_KEY } from "./bots";

/** The status last heard for each Coding Bot, so a settings change while it waits isn't news again. */
const lastStatus = new Map<string, CodingStatus>();

/**
 * Tells the user when a Coding Bot needs them (a plan to approve, the round limit, finished, an error) with a desktop
 * notification, when they are elsewhere and the bot's notifications are on. Its sidebar row shows the same wait from
 * the project itself. Call it with each `coding.updated`, before the project replaces the cached one.
 */
export function noticeCoding(client: QueryClient, project: CodingProject) {
  const before =
    lastStatus.get(project.botId) ?? client.getQueryData<CodingProject>(["coding", project.botId])?.status;
  lastStatus.set(project.botId, project.status);
  const news = attentionFor(before, project);
  if (!news) return;
  const bot = client.getQueryData<Bot[]>(BOTS_KEY)?.find((candidate) => candidate.id === project.botId);
  if (!bot) return;

  // The unread badge comes from the bot's own status messages; this adds the desktop notification.
  if (
    !bot.notifications ||
    (document.hasFocus() && isWatching(bot.threadId)) ||
    typeof Notification === "undefined"
  )
    return;
  // One notification per bot: a newer one replaces the older.
  const notification = new Notification(bot.name, {
    body: news.body,
    tag: `coding-${bot.id}`,
    silent: false,
  });
  notification.addEventListener("click", () => {
    window.focus();
    useUi.getState().select(bot.threadId);
  });
}

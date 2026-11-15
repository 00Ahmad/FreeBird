import type { Bot, Thread } from "@mrog/shared";

/**
 * A Coding Bot (or a Job Bot) is one bot in the sidebar but a team underneath: hidden role bots made by it (Planner,
 * Developer, QA; or Interviewer, Searcher, Checker, Visual helper), each talking to it in a conversation of their
 * own. These say which bots and chats belong to such a team, so the screen can leave them out of notifications,
 * unread counts and the actions that would break the team.
 */

type TeamBot = Pick<Bot, "id" | "parentId" | "coding"> & { job?: boolean; client?: boolean };

/** A bot that runs a team of hidden role bots: a Coding Bot, a Job Bot or a Client Bot. */
export const leadsTeam = (bot: Pick<TeamBot, "coding" | "job" | "client">): boolean =>
  Boolean(bot.coding || bot.job || bot.client);

/** The Coding Bot a role bot works for, or null when the bot isn't one of a team's roles. */
export function codingParentOf(bot: Pick<Bot, "parentId">, bots: readonly TeamBot[]): TeamBot | null {
  if (!bot.parentId) return null;
  const parent = bots.find((candidate) => candidate.id === bot.parentId);
  return parent?.coding ? parent : null;
}

/** The Coding Bot or Job Bot a role bot works for, or null. */
export function teamParentOf(bot: Pick<Bot, "parentId">, bots: readonly TeamBot[]): TeamBot | null {
  if (!bot.parentId) return null;
  const parent = bots.find((candidate) => candidate.id === bot.parentId);
  return parent && leadsTeam(parent) ? parent : null;
}

/** A role bot of some Coding Bot or Job Bot. */
export const isTeamBot = (bot: Pick<Bot, "parentId">, bots: readonly TeamBot[]): boolean =>
  teamParentOf(bot, bots) !== null;

/** Whether a bot is a Coding Bot or one of its roles: in both cases its team is what the user deals with. */
const inTeam = (id: string, bots: readonly TeamBot[]): boolean => {
  const bot = bots.find((candidate) => candidate.id === id);
  return Boolean(bot && (leadsTeam(bot) || isTeamBot(bot, bots)));
};

/** A conversation between a Coding Bot and one of its roles (made by the app; the user only reads it). */
export function isTeamThread(thread: Pick<Thread, "pair" | "memberIds">, bots: readonly TeamBot[]): boolean {
  return thread.pair && thread.memberIds.some((id) => inTeam(id, bots));
}

/** The ids of every team conversation. */
export function teamThreadIds(
  threads: readonly Pick<Thread, "id" | "pair" | "memberIds">[],
  bots: readonly TeamBot[],
): Set<string> {
  return new Set(threads.filter((thread) => isTeamThread(thread, bots)).map((thread) => thread.id));
}

/** What the sidebar and the details pane may offer for a bot without breaking a Coding Bot's team. */
export interface BotActions {
  rename: boolean;
  duplicate: boolean;
  makePrimary: boolean;
  /** Hide from or show in the sidebar. */
  hide: boolean;
  delete: boolean;
  /** Sections, pinning and notifications: harmless, but meaningless for a role bot the user never sees. */
  arrange: boolean;
}

export function botActions(
  bot: Pick<Bot, "parentId" | "coding"> & { job?: boolean; client?: boolean },
  bots: readonly TeamBot[],
): BotActions {
  if (isTeamBot(bot, bots))
    // A role is made, named and deleted with its Coding Bot; the server refuses changes to it.
    return {
      rename: false,
      duplicate: false,
      makePrimary: false,
      hide: false,
      delete: false,
      arrange: false,
    };
  // A copy of a Coding Bot would have no team, and it can't coordinate other bots as a Primary Bot. Deleting it
  // deletes its team too.
  if (leadsTeam(bot))
    return { rename: true, duplicate: false, makePrimary: false, hide: true, delete: true, arrange: true };
  return { rename: true, duplicate: true, makePrimary: true, hide: true, delete: true, arrange: true };
}

import type { Bot, Thread } from "@mrog/shared";

/** The sidebar's lists of multi-bot threads: each one is in exactly one of them. */
export function splitGroups(groups: Thread[]) {
  return {
    races: groups.filter((thread) => thread.race),
    clusters: groups.filter((thread) => thread.cluster && !thread.race),
    // A group chat has you in it. The conversation between a coordinator and one helper (or teammate) is just that
    // conversation, so it isn't listed as a group.
    groupChats: groups.filter((thread) => !thread.cluster && !thread.pair),
    botTalks: groups.filter((thread) => thread.pair),
  };
}

/**
 * Whether a chat has no model to answer with: none shared by all bots, and none of its members has their own. A group
 * is usable when any member can answer, as a direct chat is when its one bot can.
 */
export function noModelFor(sharedModel: string | null | undefined, members: Pick<Bot, "model">[]): boolean {
  return !sharedModel && !members.some((member) => member.model);
}

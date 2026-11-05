/**
 * What arrived in a chat since the user last looked at it.
 *
 * Counted from the events the app receives while it is open: a message that arrived while the app was closed isn't
 * known here (the app shows it as an ordinary message when the chat opens). Kept per viewer, in the browser's
 * storage: whether you have read something is not a fact about the chat.
 */

export interface ThreadUnread {
  /** Messages made before this moment have been seen: events about them (a replay after reconnecting) don't count. */
  readAt: string;
  /** Replies that arrived unseen, oldest first. */
  ids: string[];
}

export interface UnreadState {
  /**
   * When counting began. Everything older is history, not news: the first run of the app, or of a new chat, must
   * not show every conversation as unread.
   */
  since: string;
  threads: Record<string, ThreadUnread>;
}

/** Replies remembered per chat; more than this shows as "99+" anyway. */
export const MAX_REMEMBERED = 200;

export const emptyUnread = (now: Date): UnreadState => ({ since: now.toISOString(), threads: {} });

/** Reads what was saved, or starts afresh from `now` when there is nothing usable. */
export function parseUnread(raw: string | null, now: Date): UnreadState {
  if (!raw) return emptyUnread(now);
  try {
    const value = JSON.parse(raw) as Partial<UnreadState> | null;
    if (!value || typeof value.since !== "string" || Number.isNaN(Date.parse(value.since)))
      return emptyUnread(now);
    const threads: Record<string, ThreadUnread> = {};
    for (const [id, entry] of Object.entries(value.threads ?? {})) {
      if (!entry || typeof entry.readAt !== "string" || !Array.isArray(entry.ids)) continue;
      threads[id] = {
        readAt: entry.readAt,
        ids: entry.ids
          .filter((candidate): candidate is string => typeof candidate === "string")
          .slice(-MAX_REMEMBERED),
      };
    }
    return { since: value.since, threads };
  } catch {
    return emptyUnread(now);
  }
}

/** The moment before which a chat's messages are already seen. ISO strings in one format compare as text. */
const seenBefore = (state: UnreadState, threadId: string) => {
  const readAt = state.threads[threadId]?.readAt ?? "";
  return readAt > state.since ? readAt : state.since;
};

interface Arrival {
  id: string;
  threadId: string;
  role: string;
  status: string;
  createdAt: string;
}

/**
 * An event about a message. Counts it when it is a finished reply the user hasn't seen: from a bot (not a note from
 * the app), done or errored, newer than what was last seen, and not counted before: `message.updated` fires again
 * for a reaction, for a replay after reconnecting, and for each step of a long reply.
 *
 * While the user is looking at the chat, nothing is added, and the chat counts as read up to that message, so a
 * later replay of it can't turn it into news.
 */
export function recordArrival(state: UnreadState, message: Arrival, watching: boolean): UnreadState {
  if (message.role !== "bot" || (message.status !== "done" && message.status !== "error")) return state;
  if (message.createdAt <= seenBefore(state, message.threadId)) return state;
  const entry = state.threads[message.threadId] ?? { readAt: state.since, ids: [] };
  if (watching) {
    return {
      ...state,
      threads: { ...state.threads, [message.threadId]: { ...entry, readAt: message.createdAt } },
    };
  }
  if (entry.ids.includes(message.id)) return state;
  const ids = [...entry.ids, message.id].slice(-MAX_REMEMBERED);
  return { ...state, threads: { ...state.threads, [message.threadId]: { ...entry, ids } } };
}

/**
 * The chat has been looked at. With nothing unread there is nothing to change (replies that arrive while it is open
 * move `readAt` on by themselves), so the same object comes back and nothing re-renders.
 */
export function markRead(state: UnreadState, threadId: string, now: Date): UnreadState {
  const entry = state.threads[threadId];
  if (entry && entry.ids.length === 0) return state;
  return { ...state, threads: { ...state.threads, [threadId]: { readAt: now.toISOString(), ids: [] } } };
}

export const unreadCount = (state: UnreadState, threadId: string) => state.threads[threadId]?.ids.length ?? 0;

/** The oldest reply that arrived unseen: where the "New messages" line goes. */
export const firstUnreadId = (state: UnreadState, threadId: string) =>
  state.threads[threadId]?.ids[0] ?? null;

/** The number to show in the window title: only the chats the sidebar shows, so one the user can't see adds nothing. */
export function totalUnread(state: UnreadState, shownThreadIds: Iterable<string>): number {
  let total = 0;
  for (const id of shownThreadIds) total += unreadCount(state, id);
  return total;
}

/** Forgets chats that are gone. Returns the same object when none were. */
export function pruneUnread(state: UnreadState, existing: ReadonlySet<string>): UnreadState {
  const gone = Object.keys(state.threads).filter((id) => !existing.has(id));
  if (gone.length === 0) return state;
  const threads = { ...state.threads };
  for (const id of gone) delete threads[id];
  return { ...state, threads };
}

export const forgetThread = (state: UnreadState, threadId: string): UnreadState =>
  pruneUnread(state, new Set(Object.keys(state.threads).filter((id) => id !== threadId)));

/** "3" or "99+", for a badge. */
export const badgeText = (count: number) => (count > 99 ? "99+" : String(count));

/** The window title with a count in front when there is news: "(3) FreeBird". */
export const titleWithUnread = (base: string, total: number) =>
  total > 0 ? `(${badgeText(total)}) ${base}` : base;

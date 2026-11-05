import { create } from "zustand";

import {
  emptyUnread,
  forgetThread,
  markRead,
  parseUnread,
  pruneUnread,
  recordArrival,
  type UnreadState,
} from "./lib/unread";
import { useUi } from "./state";

const KEY = "mrog.unread.v1";

function load(): UnreadState {
  try {
    return parseUnread(localStorage.getItem(KEY), new Date());
  } catch {
    return emptyUnread(new Date());
  }
}

function save(state: UnreadState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Per-viewer convenience only: without storage the counts last until the window closes.
  }
}

interface UnreadStore {
  state: UnreadState;
  /** A bot's message arrived or changed; `watching` is whether the user is looking at that chat right now. */
  arrive(message: Parameters<typeof recordArrival>[1], watching: boolean): void;
  /** The chat was looked at. */
  read(threadId: string): void;
  /** Chats that exist: counts for any others are dropped. */
  prune(existing: ReadonlySet<string>): void;
  forget(threadId: string): void;
}

export const useUnread = create<UnreadStore>((set, get) => {
  const apply = (next: UnreadState) => {
    if (next === get().state) return;
    save(next);
    set({ state: next });
  };
  return {
    state: load(),
    arrive: (message, watching) => apply(recordArrival(get().state, message, watching)),
    read: (threadId) => apply(markRead(get().state, threadId, new Date())),
    prune: (existing) => apply(pruneUnread(get().state, existing)),
    forget: (threadId) => apply(forgetThread(get().state, threadId)),
  };
});

/**
 * Whether the user is looking at this chat: it is open in the chat view (not the Library), and this window is the
 * one in front. Anything that arrives then is seen as it comes.
 */
export function isWatching(threadId: string): boolean {
  const ui = useUi.getState();
  return document.hasFocus() && !document.hidden && ui.view === "chat" && ui.selectedThreadId === threadId;
}

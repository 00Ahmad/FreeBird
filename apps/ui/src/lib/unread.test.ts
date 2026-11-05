import { describe, expect, it } from "vitest";

import {
  badgeText,
  emptyUnread,
  firstUnreadId,
  forgetThread,
  markRead,
  MAX_REMEMBERED,
  parseUnread,
  pruneUnread,
  recordArrival,
  titleWithUnread,
  totalUnread,
  unreadCount,
  type UnreadState,
} from "./unread";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 5, 12, minutes, 0));
const iso = (minutes: number) => at(minutes).toISOString();

const reply = (id: string, minutes: number, over: Partial<Parameters<typeof recordArrival>[1]> = {}) => ({
  id,
  threadId: "thr_a",
  role: "bot",
  status: "done",
  createdAt: iso(minutes),
  ...over,
});

/** A state that began at minute 0. */
const fresh = () => emptyUnread(at(0));

describe("counting what arrived unseen", () => {
  it("counts a finished reply from a bot that arrives while the chat is not being watched", () => {
    const state = recordArrival(fresh(), reply("m1", 5), false);
    expect(unreadCount(state, "thr_a")).toBe(1);
    expect(firstUnreadId(state, "thr_a")).toBe("m1");
    const more = recordArrival(state, reply("m2", 6), false);
    expect(unreadCount(more, "thr_a")).toBe(2);
    expect(firstUnreadId(more, "thr_a")).toBe("m1");
  });

  it("counts an errored reply too, but not a half-written one, the user's own, or a note from the app", () => {
    expect(unreadCount(recordArrival(fresh(), reply("m", 5, { status: "error" }), false), "thr_a")).toBe(1);
    for (const over of [{ status: "streaming" }, { status: "stopped" }, { role: "user" }, { role: "system" }])
      expect(
        unreadCount(recordArrival(fresh(), reply("m", 5, over), false), "thr_a"),
        JSON.stringify(over),
      ).toBe(0);
  });

  it("counts each reply once, however often an event about it comes (a reaction, a replay)", () => {
    let state = fresh();
    for (let i = 0; i < 5; i++) state = recordArrival(state, reply("m1", 5), false);
    expect(unreadCount(state, "thr_a")).toBe(1);
  });

  it("never treats history from before counting began as news", () => {
    // The first run, or a chat made earlier: replies older than the baseline are not unread.
    const state = recordArrival(fresh(), reply("old", -30), false);
    expect(unreadCount(state, "thr_a")).toBe(0);
    expect(state).toBe(recordArrival(state, reply("old", -30), false));
  });

  it("does not count a reply that was read, when an event about it comes again after reconnecting", () => {
    let state = recordArrival(fresh(), reply("m1", 5), false);
    state = markRead(state, "thr_a", at(10));
    expect(unreadCount(state, "thr_a")).toBe(0);
    // The stream replays what it missed, including the reply already read.
    state = recordArrival(state, reply("m1", 5), false);
    expect(unreadCount(state, "thr_a")).toBe(0);
    // A reply made after the chat was read is news.
    state = recordArrival(state, reply("m2", 12), false);
    expect(unreadCount(state, "thr_a")).toBe(1);
  });

  it("adds nothing while the chat is being watched, and a later replay of it is not news either", () => {
    let state = markRead(fresh(), "thr_a", at(1));
    state = recordArrival(state, reply("seen", 5), true);
    expect(unreadCount(state, "thr_a")).toBe(0);
    state = recordArrival(state, reply("seen", 5), false); // replayed after the user left
    expect(unreadCount(state, "thr_a")).toBe(0);
    state = recordArrival(state, reply("next", 7), false);
    expect(unreadCount(state, "thr_a")).toBe(1);
  });

  it("keeps chats apart", () => {
    let state = recordArrival(fresh(), reply("a1", 5), false);
    state = recordArrival(state, reply("b1", 5, { threadId: "thr_b" }), false);
    state = markRead(state, "thr_a", at(6));
    expect(unreadCount(state, "thr_a")).toBe(0);
    expect(unreadCount(state, "thr_b")).toBe(1);
  });

  it("remembers a bounded number of replies", () => {
    let state = fresh();
    for (let i = 0; i < MAX_REMEMBERED + 50; i++)
      state = recordArrival(
        state,
        reply(`m${i}`, 5 + (i % 50), { createdAt: new Date(at(5).getTime() + i * 1000).toISOString() }),
        false,
      );
    expect(unreadCount(state, "thr_a")).toBe(MAX_REMEMBERED);
  });
});

describe("marking read", () => {
  it("clears the count and the first-unread marker", () => {
    let state = recordArrival(fresh(), reply("m1", 5), false);
    state = markRead(state, "thr_a", at(9));
    expect(unreadCount(state, "thr_a")).toBe(0);
    expect(firstUnreadId(state, "thr_a")).toBeNull();
  });

  it("changes nothing when there is nothing unread, so nothing re-renders", () => {
    const state = markRead(fresh(), "thr_a", at(2));
    expect(markRead(state, "thr_a", at(3))).toBe(state);
  });
});

describe("the title and the numbers", () => {
  it("adds up only the chats that are shown", () => {
    let state = recordArrival(fresh(), reply("a1", 5), false);
    state = recordArrival(state, reply("a2", 6), false);
    state = recordArrival(state, reply("h1", 5, { threadId: "thr_hidden" }), false);
    expect(totalUnread(state, ["thr_a"])).toBe(2);
    expect(totalUnread(state, ["thr_a", "thr_hidden"])).toBe(3);
    expect(totalUnread(state, [])).toBe(0);
  });

  it("puts the count in front of the title only when there is one", () => {
    expect(titleWithUnread("FreeBird", 0)).toBe("FreeBird");
    expect(titleWithUnread("FreeBird", 3)).toBe("(3) FreeBird");
    expect(titleWithUnread("FreeBird", 250)).toBe("(99+) FreeBird");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
  });

  it("forgets chats that are gone", () => {
    let state = recordArrival(fresh(), reply("a1", 5), false);
    state = recordArrival(state, reply("b1", 5, { threadId: "thr_b" }), false);
    const pruned = pruneUnread(state, new Set(["thr_a"]));
    expect(Object.keys(pruned.threads)).toEqual(["thr_a"]);
    expect(pruneUnread(pruned, new Set(["thr_a"]))).toBe(pruned);
    expect(Object.keys(forgetThread(state, "thr_a").threads)).toEqual(["thr_b"]);
  });
});

describe("saving and loading", () => {
  it("round-trips", () => {
    const state = recordArrival(fresh(), reply("m1", 5), false);
    expect(parseUnread(JSON.stringify(state), at(99))).toEqual(state);
  });

  it("starts from now when nothing usable was saved, so old chats are not all unread", () => {
    for (const raw of [null, "", "{not json", "null", "[]", '{"since": 5}', '{"since": "not a date"}']) {
      const state = parseUnread(raw, at(30));
      expect(state.since, String(raw)).toBe(iso(30));
      expect(state.threads).toEqual({});
    }
  });

  it("keeps the good parts of a damaged save", () => {
    const raw = JSON.stringify({
      since: iso(1),
      threads: {
        thr_ok: { readAt: iso(2), ids: ["m1", 7, "m2"] },
        thr_bad: { readAt: 5, ids: [] },
        thr_worse: "x",
      },
    } satisfies unknown);
    const state: UnreadState = parseUnread(raw, at(50));
    expect(state.threads).toEqual({ thr_ok: { readAt: iso(2), ids: ["m1", "m2"] } });
    expect(state.since).toBe(iso(1));
  });
});

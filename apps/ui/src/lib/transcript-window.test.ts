import { describe, expect, it } from "vitest";

import { revealFrom, windowStart } from "./transcript-window";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

describe("the window over a long chat", () => {
  it("draws everything of a short chat", () => {
    expect(windowStart(ids(30), null, 120)).toBe(0);
    expect(windowStart(ids(120), null, 120)).toBe(0);
  });

  it("draws only the newest of a long one the first time", () => {
    expect(windowStart(ids(500), null, 120)).toBe(380);
  });

  it("only grows as replies arrive: the first message drawn stays the first message drawn", () => {
    const list = ids(500);
    let startId: string | null = null;
    let start = windowStart(list, startId, 120);
    startId = list[start]!;
    // New replies at the bottom do not take a row off the top.
    for (const total of [501, 530, 700]) {
      const next = ids(total);
      const at = windowStart(next, startId, 120);
      expect(next[at], String(total)).toBe(startId);
      expect(at).toBe(start);
    }
    start = windowStart(ids(700), startId, 120);
    expect(700 - start).toBe(320); // 120 + the 200 that arrived
  });

  it("starts over at the newest messages when the first one drawn is gone (a cleared chat)", () => {
    expect(windowStart(ids(300), "gone", 120)).toBe(180);
    expect(windowStart(ids(10), "gone", 120)).toBe(0);
  });

  it("widens to include a message that must be shown, such as the first unread one", () => {
    expect(windowStart(ids(500), null, 120, ["m100"])).toBe(100);
    // Already inside the window: nothing changes.
    expect(windowStart(ids(500), null, 120, ["m450"])).toBe(380);
    // Not in the list at all, or no such message: ignored.
    expect(windowStart(ids(500), null, 120, ["nope", null])).toBe(380);
    // The earliest of several.
    expect(windowStart(ids(500), null, 120, ["m200", "m50", "m300"])).toBe(50);
  });

  it("keeps a widened window widened", () => {
    const list = ids(500);
    const start = windowStart(list, null, 120, ["m100"]);
    expect(windowStart(list, list[start]!, 120, [])).toBe(100);
  });

  it("shows more above, down to the first message", () => {
    expect(revealFrom(380, 120)).toBe(260);
    expect(revealFrom(50, 120)).toBe(0);
    expect(revealFrom(0, 120)).toBe(0);
  });
});

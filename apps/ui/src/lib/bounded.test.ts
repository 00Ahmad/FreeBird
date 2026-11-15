import { describe, expect, it } from "vitest";

import { addBounded } from "./bounded";

describe("a set that keeps the newest keys", () => {
  it("says whether a key is new", () => {
    const set = new Set<string>();
    expect(addBounded(set, "a", 3)).toBe(true);
    expect(addBounded(set, "a", 3)).toBe(false);
  });

  it("drops the oldest keys past the limit", () => {
    const set = new Set<string>();
    for (const key of ["a", "b", "c", "d", "e"]) addBounded(set, key, 3);
    expect([...set]).toEqual(["c", "d", "e"]);
    // A key dropped long ago counts as new again.
    expect(addBounded(set, "a", 3)).toBe(true);
    expect(set.size).toBe(3);
  });
});

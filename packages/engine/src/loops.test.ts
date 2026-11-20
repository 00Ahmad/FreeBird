import { describe, expect, it } from "vitest";

import { goesRoundInCircles } from "./loops";

describe("going round in circles", () => {
  it("finds one call repeated, and two or three calls in turn", () => {
    expect(goesRoundInCircles(["x", "a", "a", "a"], 3)).toBe(true);
    expect(goesRoundInCircles(["a", "b", "a", "b", "a", "b"], 3)).toBe(true);
    expect(goesRoundInCircles(["a", "b", "c", "a", "b", "c", "a", "b", "c"], 3)).toBe(true);
  });

  it("doesn't count work that moves on, or a circle not yet repeated enough", () => {
    expect(goesRoundInCircles(["a", "a"], 3)).toBe(false);
    expect(goesRoundInCircles(["a", "b", "a", "b", "a"], 3)).toBe(false);
    expect(goesRoundInCircles(["a", "b", "c", "d", "e", "f"], 3)).toBe(false);
    expect(goesRoundInCircles(["a", "b", "a", "c", "a", "b"], 3)).toBe(false);
  });
});

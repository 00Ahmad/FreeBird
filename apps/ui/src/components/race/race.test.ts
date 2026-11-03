import { describe, expect, it } from "vitest";

import { splitStrategy } from "./RaceView";

describe("race lanes", () => {
  it("takes the strategy line off the top of a racer's answer", () => {
    expect(splitStrategy("**Strategy:** go narrow and deep.\n\nThe answer.")).toEqual({
      strategy: "go narrow and deep.",
      body: "The answer.",
    });
    expect(splitStrategy("The answer first.\nStrategy: too late")).toEqual({
      strategy: null,
      body: "The answer first.\nStrategy: too late",
    });
  });
});

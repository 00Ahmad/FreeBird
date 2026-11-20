import { describe, expect, it } from "vitest";

import { kindsFrom, kindsText } from "./scan-kinds";

const ALL = ["asking", "signs", "quiet"] as const;

describe("the kinds of lead asked for in the chat (3.4)", () => {
  it("reads 'only' and 'no'", () => {
    expect(kindsFrom("10, only tenders", [...ALL])).toEqual(["asking"]);
    expect(kindsFrom("5, no quiet fits", [...ALL])).toEqual(["asking", "signs"]);
    expect(kindsFrom("just quiet fits and signs please", [...ALL])).toEqual(["signs", "quiet"]);
    expect(kindsFrom("without tenders", ["asking", "quiet"])).toEqual(["quiet"]);
    expect(kindsFrom("10", [...ALL])).toBeNull();
    // Nothing would be left: not a choice.
    expect(kindsFrom("no tenders", ["asking"])).toBeNull();
  });

  it("names them plainly", () => {
    expect(kindsText(["asking", "quiet"])).toBe("asking now (tenders and requests) and quiet fits");
  });
});

import { describe, expect, it } from "vitest";

import { estimateTextTokens, estimateTokens } from "./history";

describe("token estimates by script", () => {
  it("counts English as before, and other alphabets and CJK as costing more", () => {
    expect(estimateTokens({ role: "user", content: "x".repeat(3500) })).toBe(Math.ceil((3500 + 8) / 3.5));
    // Before: both were counted as about 1,000 tokens, the same as English.
    expect(estimateTextTokens("ی".repeat(3500))).toBe(1750);
    expect(estimateTextTokens("中".repeat(3500))).toBe(3500);
    expect(estimateTextTokens("Price: “£20” – ok 🙂")).toBeCloseTo("Price: “£20” – ok 🙂".length / 3.5);
  });
});

describe("pictures the user attached", async () => {
  const { onlyRecentPictures } = await import("./history");
  const pic = (n: number) => ({ mediaType: "image/png", data: `p${n}` });
  it("keeps the newest three in full and replaces older ones with a note", () => {
    const history = [
      { role: "user" as const, content: "first", images: [pic(1), pic(2)] },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "second", images: [pic(3), pic(4)] },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "now", images: [pic(5)] },
    ];
    const out = onlyRecentPictures(history);
    expect(out[4]).toEqual(history[4]);
    expect(out[2]).toMatchObject({ images: [pic(3), pic(4)] });
    expect(out[0]).not.toHaveProperty("images");
    expect(out[0]!.content).toContain("2 pictures from earlier left out");
  });

  it("always keeps every picture of the newest message", () => {
    const history = [
      { role: "user" as const, content: "", images: [pic(1), pic(2), pic(3), pic(4), pic(5)] },
    ];
    expect(onlyRecentPictures(history)).toEqual(history);
  });
});

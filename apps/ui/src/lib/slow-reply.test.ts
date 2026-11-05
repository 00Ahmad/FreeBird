import { describe, expect, it } from "vitest";

import { nextStageIn, slowStage, SLOW } from "./slow-reply";

const stage = (elapsedMs: number, over: Partial<Parameters<typeof slowStage>[0]> = {}) =>
  slowStage({ elapsedMs, local: false, queued: false, dismissed: false, ...over });

describe("slow replies", () => {
  it("says nothing at first", () => {
    expect(stage(0)).toBe("none");
    expect(stage(SLOW.noteAfterMs - 1)).toBe("none");
    expect(stage(0, { local: true })).toBe("none");
  });

  it("offers a way out of a cloud model that hasn't started after 20 seconds", () => {
    expect(stage(20_000)).toBe("actions");
    expect(stage(60_000)).toBe("actions");
  });

  it("only notes that a local model is loading, offering Try again after about a minute and a half", () => {
    expect(stage(20_000, { local: true })).toBe("note");
    expect(stage(89_999, { local: true })).toBe("note");
    expect(stage(90_000, { local: true })).toBe("actions");
  });

  it("offers nothing while the reply is waiting behind other work: restarting wouldn't help", () => {
    for (const local of [true, false])
      for (const ms of [0, 30_000, 120_000, 600_000]) expect(stage(ms, { local, queued: true })).toBe("none");
  });

  it("stops once 'Keep waiting' was pressed", () => {
    expect(stage(600_000, { dismissed: true })).toBe("none");
    expect(stage(600_000, { dismissed: true, local: true })).toBe("none");
  });

  it("works out when to look again, once", () => {
    const input = { local: true, queued: false, dismissed: false };
    expect(nextStageIn({ ...input, elapsedMs: 0 })).toBe(20_000);
    expect(nextStageIn({ ...input, elapsedMs: 5_000 })).toBe(15_000);
    expect(nextStageIn({ ...input, elapsedMs: 20_000 })).toBe(70_000);
    expect(nextStageIn({ ...input, elapsedMs: 90_000 })).toBeNull();
    expect(nextStageIn({ ...input, local: false, elapsedMs: 0 })).toBe(20_000);
    expect(nextStageIn({ ...input, local: false, elapsedMs: 20_000 })).toBeNull();
    expect(nextStageIn({ ...input, queued: true, elapsedMs: 0 })).toBeNull();
    expect(nextStageIn({ ...input, dismissed: true, elapsedMs: 0 })).toBeNull();
  });
});

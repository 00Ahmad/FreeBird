import { describe, expect, it } from "vitest";

import { acknowledgeCard, advanceActivity, MOVED_FOR_MS, pruneMoved } from "./codingActivity";
import { comment, connectorCard, fileCard } from "./codingFixture";

describe("what changed on the board", () => {
  it("takes the first sight of a board as a starting point, not news", () => {
    const first = advanceActivity(null, [fileCard("a", "qa", [comment("qa", "hm")])], 1000);
    expect(first.moved).toEqual({});
    expect(first.unseenQa).toEqual({});
    expect(first.columns).toEqual({ "card-a": "qa" });
  });

  it("flashes a card that changed column, and says where to", () => {
    const before = advanceActivity(null, [fileCard("a", "todo"), fileCard("b", "todo")], 0);
    const after = advanceActivity(before, [fileCard("a", "in_progress"), fileCard("b", "todo")], 5000);
    expect(after.moved).toEqual({ "card-a": { to: "in_progress", at: 5000 } });
  });

  it("does not flash cards that appear with the plan", () => {
    const before = advanceActivity(null, [], 0);
    expect(advanceActivity(before, [fileCard("a"), connectorCard("x")], 10).moved).toEqual({});
  });

  it("keeps a recent move through updates that don't move it again, and replaces it when it moves again", () => {
    const t0 = advanceActivity(null, [fileCard("a", "todo")], 0);
    const t1 = advanceActivity(t0, [fileCard("a", "in_progress")], 100);
    const t2 = advanceActivity(t1, [fileCard("a", "in_progress")], 200);
    expect(t2.moved["card-a"]).toEqual({ to: "in_progress", at: 100 });
    const t3 = advanceActivity(t2, [fileCard("a", "qa")], 300);
    expect(t3.moved["card-a"]).toEqual({ to: "qa", at: 300 });
  });

  it("notes a new QA comment, and keeps it until it is seen", () => {
    const t0 = advanceActivity(null, [fileCard("a", "qa")], 0);
    const t1 = advanceActivity(t0, [fileCard("a", "todo", [comment("qa", "missing tests")])], 10);
    expect(t1.unseenQa).toEqual({ "card-a": true });
    // Later updates that add nothing keep the badge.
    const t2 = advanceActivity(t1, [fileCard("a", "in_progress", [comment("qa", "missing tests")])], 20);
    expect(t2.unseenQa).toEqual({ "card-a": true });
    expect(acknowledgeCard(t2, "card-a").unseenQa).toEqual({});
  });

  it("does not badge comments from anyone but QA", () => {
    const t0 = advanceActivity(null, [fileCard("a", "todo")], 0);
    const t1 = advanceActivity(
      t0,
      [fileCard("a", "todo", [comment("developer", "done"), comment("user", "hi")])],
      10,
    );
    expect(t1.unseenQa).toEqual({});
  });

  it("forgets a card that is gone", () => {
    const t0 = advanceActivity(null, [fileCard("a"), fileCard("b")], 0);
    const t1 = advanceActivity(t0, [fileCard("b", "qa")], 5);
    expect(Object.keys(t1.columns)).toEqual(["card-b"]);
  });

  it("lets a flash end after a few seconds", () => {
    const t0 = advanceActivity(null, [fileCard("a")], 0);
    const t1 = advanceActivity(t0, [fileCard("a", "qa")], 1000);
    expect(pruneMoved(t1, 1000 + MOVED_FOR_MS - 1)).toBe(t1);
    expect(pruneMoved(t1, 1000 + MOVED_FOR_MS).moved).toEqual({});
  });

  it("returns the same object when there is nothing to acknowledge", () => {
    const t0 = advanceActivity(null, [fileCard("a")], 0);
    expect(acknowledgeCard(t0, "card-a")).toBe(t0);
  });
});

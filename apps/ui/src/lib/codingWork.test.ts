import { describe, expect, it } from "vitest";

import { SLOW_CARD_SECONDS } from "@mrog/shared";

import { cornerKind, diagramMarks, NO_MARK } from "./codingFeedback";
import { comment, fileCard, node, project, withWork } from "./codingFixture";
import {
  activeElapsed,
  cardElapsedSeconds,
  cardWorkLine,
  formatDuration,
  formatTokens,
  isSlowCard,
  projectTotals,
  slowBadge,
  slowHint,
  SLOW_TOOLTIP,
  totalsLine,
} from "./codingWork";

const SINCE = "2026-01-01T10:00:00.000Z";
const T0 = Date.parse(SINCE);
const idle = project({ active: null });
const runningOn = (cardId: string | null, since: string | undefined = SINCE) =>
  project({ active: { role: "developer", cardId, since } });

describe("time on a card", () => {
  const card = withWork(fileCard("a", "in_progress"), { seconds: 100 });

  it("is the finished turns when nothing runs on it", () => {
    expect(cardElapsedSeconds(card, idle, T0 + 999_000)).toBe(100);
    expect(cardElapsedSeconds(card, project({ active: undefined }), T0)).toBe(100);
    // Another card is the one running.
    expect(cardElapsedSeconds(card, runningOn("card-other"), T0 + 50_000)).toBe(100);
  });

  it("adds the turn running on it now", () => {
    expect(cardElapsedSeconds(card, runningOn("card-a"), T0 + 30_000)).toBe(130);
    expect(cardElapsedSeconds(card, runningOn("card-a"), T0)).toBe(100);
  });

  it("counts a card with no work record as nothing, or just the running turn", () => {
    const old = fileCard("a", "todo");
    expect(old.work).toBeUndefined();
    expect(cardElapsedSeconds(old, idle, T0)).toBe(0);
    expect(cardElapsedSeconds(old, runningOn("card-a"), T0 + 5000)).toBe(5);
  });

  it("ignores a start time in the future or one that cannot be read", () => {
    expect(cardElapsedSeconds(card, runningOn("card-a"), T0 - 60_000)).toBe(100);
    expect(cardElapsedSeconds(card, runningOn("card-a", "not a date"), T0 + 60_000)).toBe(100);
    expect(
      cardElapsedSeconds(card, project({ active: { role: "developer", cardId: "card-a" } }), T0 + 60_000),
    ).toBe(100);
    expect(cardElapsedSeconds(card, runningOn("card-a", ""), T0 + 60_000)).toBe(100);
  });

  it("ignores impossible seconds", () => {
    for (const seconds of [-5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(cardElapsedSeconds(withWork(fileCard("a"), { seconds }), idle, T0), String(seconds)).toBe(0);
  });
});

describe("slow cards", () => {
  const at = (seconds: number) => withWork(fileCard("a", "in_progress"), { seconds });

  it("is the limit, to the second", () => {
    expect(SLOW_CARD_SECONDS).toBe(600);
    expect(isSlowCard(at(599), idle, T0)).toBe(false);
    expect(isSlowCard(at(599.9), idle, T0)).toBe(false);
    expect(isSlowCard(at(600), idle, T0)).toBe(true);
    expect(isSlowCard(at(601), idle, T0)).toBe(true);
  });

  it("counts the running turn towards it", () => {
    const card = at(590);
    expect(isSlowCard(card, runningOn("card-a"), T0 + 9_000)).toBe(false);
    expect(isSlowCard(card, runningOn("card-a"), T0 + 10_000)).toBe(true);
    // The same time on another card's turn does not.
    expect(isSlowCard(card, runningOn("card-b"), T0 + 10_000)).toBe(false);
  });

  it("is never slow for an old card without work", () => {
    expect(isSlowCard(fileCard("a"), idle, T0)).toBe(false);
  });

  it("words the badge and the tooltip", () => {
    expect(slowBadge(720)).toBe("Slow: 12 min");
    expect(SLOW_TOOLTIP).toBe(
      "This card has taken more than 10 minutes. A smaller or faster model for this role may help.",
    );
  });
});

describe("durations", () => {
  it("is seconds under a minute, minutes under an hour, then hours and minutes", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(59.9)).toBe("59 s");
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(720)).toBe("12 min");
    expect(formatDuration(3599)).toBe("59 min");
    expect(formatDuration(3600)).toBe("1 h 00 min");
    expect(formatDuration(3900)).toBe("1 h 05 min");
    expect(formatDuration(5520)).toBe("1 h 32 min");
    expect(formatDuration(100 * 3600 + 60)).toBe("100 h 01 min");
  });

  it("copes with nonsense", () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatDuration(value)).toBe("0 s");
  });
});

describe("token counts", () => {
  it("is plain under a thousand, then k, M and B", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(9_940)).toBe("9.9k");
    expect(formatTokens(58_000)).toBe("58k");
    expect(formatTokens(58_400)).toBe("58k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(4_600_000)).toBe("4.6M");
    expect(formatTokens(12_000_000)).toBe("12M");
    expect(formatTokens(2_300_000_000)).toBe("2.3B");
  });

  it("never prints 1000k or 1000M at a boundary", () => {
    expect(formatTokens(999_499)).toBe("999k");
    expect(formatTokens(999_500)).toBe("1M");
    expect(formatTokens(999_999)).toBe("1M");
    expect(formatTokens(999_499_999)).toBe("999M");
    expect(formatTokens(999_999_999)).toBe("1B");
  });

  it("copes with huge and odd counts", () => {
    expect(formatTokens(5e15)).toBe("5000000B");
    expect(formatTokens(-4)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("a card's work line", () => {
  const full = withWork(fileCard("a", "qa"), {
    seconds: 720,
    inputTokens: 1_500_000,
    outputTokens: 58_000,
    turns: 2,
  });

  it("gives time, tokens and turns", () => {
    expect(cardWorkLine(full, idle, T0)).toBe("12 min · 1.5M in · 58k out · 2 turns");
    expect(cardWorkLine(withWork(fileCard("a"), { seconds: 30, turns: 1 }), idle, T0)).toBe("30 s · 1 turn");
  });

  it("is empty when there is no work yet, and for cards from before work was tracked", () => {
    expect(cardWorkLine(fileCard("a"), idle, T0)).toBeNull();
    expect(cardWorkLine(withWork(fileCard("a"), {}), idle, T0)).toBeNull();
  });

  it("ticks with the running turn", () => {
    const running = runningOn("card-a");
    expect(cardWorkLine(full, running, T0 + 60_000)).toBe("13 min · 1.5M in · 58k out · 2 turns");
    expect(cardWorkLine(fileCard("a"), running, T0 + 90_000)).toBe("1 min");
  });
});

describe("project totals", () => {
  const cards = [
    withWork(fileCard("a", "done"), {
      seconds: 3000,
      inputTokens: 2_000_000,
      outputTokens: 100_000,
      turns: 3,
    }),
    withWork(fileCard("b", "in_progress"), {
      seconds: 600,
      inputTokens: 2_400_000,
      outputTokens: 100_000,
      turns: 1,
    }),
    fileCard("c"),
  ];
  const running = project({ cards, active: { role: "developer", cardId: "card-b", since: SINCE } });

  it("adds up time and tokens, including the turn running", () => {
    expect(projectTotals(project({ cards, active: null }), T0)).toEqual({
      seconds: 3600,
      inputTokens: 4_400_000,
      outputTokens: 200_000,
      turns: 4,
    });
    expect(projectTotals(running, T0 + 1_920_000).seconds).toBe(5520);
  });

  it("words the total line, and says nothing before any work", () => {
    expect(totalsLine(projectTotals(running, T0 + 1_920_000))).toBe("Total: 1 h 32 min · 4.6M tokens");
    expect(totalsLine(projectTotals(project({ cards: [fileCard("a")] }), T0))).toBeNull();
    expect(totalsLine(projectTotals(project({ cards: [] }), T0))).toBeNull();
    expect(totalsLine({ seconds: 0, inputTokens: 900, outputTokens: 50, turns: 1 })).toBe(
      "Total: 950 tokens",
    );
  });
});

describe("the role at work", () => {
  const cards = [withWork(fileCard("a", "in_progress"), { seconds: 120 })];
  const on = (role: "developer" | "planner" | "qa", cardId: string | null) =>
    project({ cards, active: { role, cardId, since: SINCE } });

  it("shows the time on its card, or on its turn when it has no card", () => {
    expect(activeElapsed(on("developer", "card-a"), T0 + 60_000)).toBe(180);
    expect(activeElapsed(on("planner", null), T0 + 60_000)).toBe(60);
  });

  it("shows nothing when nobody runs or the start is unknown", () => {
    expect(activeElapsed(project({ cards, active: null }), T0)).toBeNull();
    expect(activeElapsed(project({ cards, active: { role: "qa", cardId: "card-a" } }), T0)).toBeNull();
  });

  it("gives a hint in plain words only while the active card is slow", () => {
    const slow = [withWork(fileCard("a", "in_progress"), { seconds: 700 })];
    const active = { role: "developer", cardId: "card-a", since: SINCE } as const;
    expect(slowHint(project({ cards: slow, active }), T0)).toBe(
      "The Developer has spent 11 min on this card. A smaller or faster model for this role may help; you can change it under Models.",
    );
    expect(slowHint(project({ cards, active }), T0)).toBeNull();
    // A slow card nobody is working on right now.
    expect(slowHint(project({ cards: slow, active: null }), T0)).toBeNull();
    expect(
      slowHint(project({ cards: slow, active: { role: "qa", cardId: null, since: SINCE } }), T0),
    ).toBeNull();
  });
});

describe("slow marks in the diagram", () => {
  const nodes = [node("a"), node("b"), node("c"), node("d")];
  const slowWork = { seconds: 900 };
  const cards = [
    withWork(fileCard("a", "in_progress"), slowWork),
    withWork(fileCard("b", "done"), slowWork),
    withWork(fileCard("c", "todo", [comment("qa", "bad")]), slowWork),
    withWork(fileCard("d", "in_progress"), { seconds: 10 }),
  ];
  const marks = diagramMarks(project({ nodes, cards }));

  it("marks a slow node", () => {
    expect(marks.get("a")!.slow).toBe(true);
    expect(marks.get("d")!.slow).toBe(false);
    expect(NO_MARK.slow).toBe(false);
  });

  it("counts the running turn when given the time", () => {
    const near = [withWork(fileCard("a", "in_progress"), { seconds: 590 })];
    const running = project({
      nodes,
      cards: near,
      active: { role: "developer", cardId: "card-a", since: SINCE },
    });
    expect(diagramMarks(running).get("a")!.slow).toBe(false);
    expect(diagramMarks(running, T0 + 20_000).get("a")!.slow).toBe(true);
  });

  it("lets the sent-back and done marks win over slow", () => {
    expect(cornerKind(marks.get("c"))).toBe("sentBack");
    expect(cornerKind(marks.get("b"))).toBe("done");
    expect(cornerKind(marks.get("a"))).toBe("slow");
    expect(cornerKind(marks.get("d"))).toBeNull();
    expect(cornerKind(undefined)).toBeNull();
  });
});

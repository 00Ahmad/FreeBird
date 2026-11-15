import { describe, expect, it } from "vitest";

import { botActions, codingParentOf, isTeamBot, isTeamThread, teamThreadIds } from "./codingTeam";

const bot = (id: string, over: { parentId?: string | null; coding?: boolean } = {}) => ({
  id,
  parentId: over.parentId ?? null,
  coding: over.coding ?? false,
});

const bots = [
  bot("coder", { coding: true }),
  bot("planner", { parentId: "coder" }),
  bot("developer", { parentId: "coder" }),
  bot("primary"),
  bot("helper", { parentId: "primary" }),
];

const thread = (id: string, memberIds: string[], pair = true) => ({ id, memberIds, pair });

describe("a Coding Bot's team", () => {
  it("knows a role bot by its Coding Bot", () => {
    expect(codingParentOf(bots[1]!, bots)?.id).toBe("coder");
    expect(isTeamBot(bots[2]!, bots)).toBe(true);
  });

  it("does not take an ordinary helper, the Coding Bot itself or an unknown parent for a role", () => {
    expect(isTeamBot(bots[4]!, bots)).toBe(false);
    expect(isTeamBot(bots[0]!, bots)).toBe(false);
    expect(isTeamBot(bot("x", { parentId: "gone" }), bots)).toBe(false);
    // Before the bots have loaded nothing is a role, so nothing is left out by mistake.
    expect(isTeamBot(bots[1]!, [])).toBe(false);
  });

  it("finds the conversations between the Coding Bot and its roles", () => {
    const threads = [
      thread("t-plan", ["coder", "planner"]),
      thread("t-dev", ["developer", "coder"]),
      thread("t-help", ["primary", "helper"]),
      thread("t-group", ["coder", "primary"], false),
    ];
    expect(isTeamThread(threads[0]!, bots)).toBe(true);
    expect(isTeamThread(threads[2]!, bots)).toBe(false);
    // A group chat the user made with the Coding Bot in it is the user's own.
    expect(isTeamThread(threads[3]!, bots)).toBe(false);
    expect([...teamThreadIds(threads, bots)]).toEqual(["t-plan", "t-dev"]);
  });
});

describe("what may be done to a bot", () => {
  it("offers nothing that would break the team for a role bot", () => {
    expect(botActions(bots[1]!, bots)).toEqual({
      rename: false,
      duplicate: false,
      makePrimary: false,
      hide: false,
      delete: false,
      arrange: false,
    });
  });

  it("keeps Rename and Delete for the Coding Bot, but no copy and no Primary", () => {
    expect(botActions(bots[0]!, bots)).toMatchObject({
      rename: true,
      delete: true,
      duplicate: false,
      makePrimary: false,
    });
  });

  it("offers everything for any other bot", () => {
    for (const other of [bots[3]!, bots[4]!])
      expect(Object.values(botActions(other, bots)).every(Boolean), other.id).toBe(true);
  });
});

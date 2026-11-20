import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { messageText } from "@mrog/shared";

import { existingForPlanner, filesFromBefore, replacedBy, replacingLine } from "./coding-existing";
import { cleanTmp, codingTeam, makeCoding, tmp, turnsOf, type, until } from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const OLD = new Date("2020-01-01T00:00:00Z");

/** A file written long ago, as one from before the project. */
const oldFile = (folder: string, path: string, text = "old") => {
  mkdirSync(join(folder, path, ".."), { recursive: true });
  writeFileSync(join(folder, path), text);
  utimesSync(join(folder, path), OLD, OLD);
};

describe("files in the folder from before the project", () => {
  it("lists the old files, not new ones, hidden ones or tool folders", () => {
    const folder = tmp("existing");
    oldFile(folder, "index.html");
    oldFile(folder, "data/movies.json");
    oldFile(folder, ".env");
    oldFile(folder, "node_modules/x/index.js");
    writeFileSync(join(folder, "new.js"), "new");
    expect(filesFromBefore(folder, "2024-01-01T00:00:00Z")).toEqual(["data/movies.json", "index.html"]);
    expect(filesFromBefore(join(folder, "missing"), "2024-01-01T00:00:00Z")).toEqual([]);
  });

  it("says what the Planner and the user need to know", () => {
    expect(existingForPlanner([])).toBeNull();
    expect(existingForPlanner(["index.html"])).toContain(
      "Don't build on them or plan around them unless the brief asks",
    );
    expect(replacedBy(["Index.html", "app.js"], ["index.html", "movies.json"])).toEqual(["Index.html"]);
    expect(replacingLine(["index.html"], false)).toBe(
      " index.html is already in the folder from before, and would be replaced.",
    );
    expect(replacingLine([], true)).toBe("");
  });

  it("tells the Planner about them, and the user which the plan replaces", async () => {
    const out = tmp("out");
    oldFile(out, "a.txt");
    oldFile(out, "movies.json");
    const team = codingTeam({
      plans: [{ tool: { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] } }],
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot } = await makeCoding(h, out);
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    expect(turnsOf(team, "planner")[0]!.task).toContain(
      "The output folder already has files from before this project: a.txt, movies.json.",
    );
    const said = h.store.messages.list(bot.threadId).map(messageText).join("\n");
    expect(said).toContain("a.txt is already in the folder from before, and would be replaced.");
  });
});

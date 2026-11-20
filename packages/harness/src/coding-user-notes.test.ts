import { afterEach, describe, expect, it } from "vitest";

import { messageText } from "@mrog/shared";

import {
  codingTeam,
  cleanTmp,
  getProject,
  makeCoding,
  post,
  tmp,
  turnsOf,
  type,
  until,
} from "./coding-testing";
import { filesNamed, NAME_A_FILE, reportsFault, USER_NOTE_FIRST, userSpokeLast } from "./coding-user-notes";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const PATHS = ["index.html", "js/movies.js", "js/api.js", "data/movies.json", "a/util.js", "b/util.js"];

describe("which files a message names", () => {
  it("finds a file by its path, or its name alone when only one file has it, in the order named", () => {
    expect(filesNamed("movies.js:289 Uncaught TypeError: Cannot read properties of null", PATHS)).toEqual([
      "js/movies.js",
    ]);
    expect(filesNamed("api.js returns nothing, so js/movies.js shows an empty grid.", PATHS)).toEqual([
      "js/api.js",
      "js/movies.js",
    ]);
    expect(filesNamed("(index.html) the title is wrong", PATHS)).toEqual(["index.html"]);
    expect(filesNamed("js\\movies.js is broken", PATHS)).toEqual(["js/movies.js"]);
  });

  it("doesn't take a longer name, another extension, or a name two files share for a file", () => {
    expect(filesNamed("movies.json is fine, oldmovies.js too", PATHS)).toEqual(["data/movies.json"]);
    expect(filesNamed("util.js is wrong", PATHS)).toEqual([]);
    expect(filesNamed("a/util.js is wrong", PATHS)).toEqual(["a/util.js"]);
    expect(filesNamed("how is it going?", PATHS)).toEqual([]);
  });

  it("tells a fault from a change", () => {
    expect(reportsFault("movies.js:289 crashes")).toBe(true);
    expect(reportsFault("the Add button doesn't work in app.js")).toBe(true);
    expect(reportsFault("make app.js show 40 movies instead of 20")).toBe(false);
  });

  it("knows when the user's note is the newest word on a card", () => {
    expect(userSpokeLast([{ author: "qa" }, { author: "user" }, { author: "developer" }])).toBe(true);
    expect(userSpokeLast([{ author: "user" }, { author: "qa" }])).toBe(false);
    expect(userSpokeLast([])).toBe(false);
  });
});

const ONE_FILE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };
const startTeam = (team: ReturnType<typeof codingTeam>) =>
  makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
const said = (harness: TestHarness, threadId: string) =>
  harness.store.messages.list(threadId).map(messageText);

describe("the user's messages reach the right card", () => {
  it("sends a finished file back with a fault the user saw, fixes it, and is done again", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const before = turnsOf(team, "developer").length;

    await type(h, bot, "a.txt:3 shows undefined instead of the date");
    const done = await until(
      h,
      bot.id,
      (p) => p.status === "done" && turnsOf(team, "developer").length > before,
    );
    const card = done.cards[0]!;
    expect(card.comments.find((c) => c.author === "user")?.text).toBe(
      "a.txt:3 shows undefined instead of the date",
    );
    const fix = turnsOf(team, "developer").at(-1)!.task;
    expect(fix).toContain("The user (round");
    expect(fix).toContain(USER_NOTE_FIRST);
    expect(said(h, bot.threadId).some((t) => t.startsWith("I sent a.txt back to the Developer"))).toBe(true);
    // Not a change to the plan: the Planner wasn't asked.
    expect(turnsOf(team, "planner")).toHaveLength(1);
  });

  it("takes a message naming a file but no fault, once done, as a change to the plan", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    await type(h, bot, "make a.txt longer");
    await until(h, bot.id, () => turnsOf(team, "planner").length === 2);
  });

  it("passes a note on to a card while its file is being written, and sends it back once that turn ends", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      develop: (_card, attempt) => (attempt === 1 ? { wait: slow } : {}),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.cards[0]?.column === "in_progress");

    await type(h, bot, "a.txt should say hello");
    expect(said(h, bot.threadId).at(-1)).toBe(
      "I passed that on to a.txt's card: the Developer fixes it next, and QA checks it again.",
    );
    release();
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(turnsOf(team, "developer").filter((turn) => turn.fresh)).toHaveLength(2);
    expect(turnsOf(team, "developer").at(-1)!.task).toContain("a.txt should say hello");
    expect(done.log?.map((line) => line.text)).toContain(
      "Your note on a.txt came in while it was being worked on, so it goes back to the Developer",
    );
  });

  it("brings back a set-aside card the user writes about, for Resume", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: () => ({ pass: false, comment: "still wrong" }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, maxRounds: 1 });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "needs_you" && p.cards[0]!.parked === true);

    await type(h, bot, "In a.txt, write the word hello on the first line");
    expect(said(h, bot.threadId).at(-1)).toBe(
      "I added that to a.txt's card. Press Resume and the Developer fixes it first.",
    );
    const card = getProject(h, bot.id).cards[0]!;
    expect(card.parked).toBeUndefined();
    expect(card.column).toBe("todo");

    team.behave.review = () => ({ pass: true });
    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(200);
    await until(h, bot.id, (p) => p.status === "done");
  });

  it("answers a message naming no file with the status and how to pass something on", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: () => ({ pass: false, comment: "still wrong" }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, maxRounds: 1 });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "needs_you");
    await type(h, bot, "what's wrong?");
    expect(said(h, bot.threadId).at(-1)).toContain(NAME_A_FILE);
  });
});

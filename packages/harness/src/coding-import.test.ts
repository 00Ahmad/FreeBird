import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { messageText, type CodingProject } from "@mrog/shared";

import { cardsFor, validatePlan } from "./coding-plan";
import {
  boot,
  cleanTmp,
  codingTeam,
  freshStore,
  getProject,
  makeCoding,
  post,
  THREE_FILES,
  tmp,
  turnsOf,
  type,
  until,
} from "./coding-testing";
import { auth, makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const startTeam = (team: ReturnType<typeof codingTeam>) =>
  makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });

const watch = (harness: TestHarness) => {
  const published: CodingProject[] = [];
  harness.bus.subscribe((event) => {
    if (event.type === "coding.updated") published.push(event.project);
  });
  return published;
};

const chat = (harness: TestHarness, threadId: string) => harness.store.messages.list(threadId);

const ONE_FILE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };
const file = {
  format: "freebird-coding-plan",
  version: 1,
  brief: "A greeter, from the file",
  nodes: THREE_FILES.nodes,
  edges: THREE_FILES.edges,
};
const importTo = (harness: TestHarness, botId: string, body: Record<string, unknown>) =>
  post(harness, `/api/bots/${botId}/coding/import`, body);

describe("bringing in a plan", () => {
  it("gives the Coding Bot and its roles their own avatars", async () => {
    h = await startTeam(codingTeam());
    const { bot, project } = await makeCoding(h, tmp("out"));
    expect(bot.avatar).toEqual({ shape: "squircle", color: "violet" });
    const looks = Object.values(project.roles).map((seat) =>
      JSON.stringify(h!.store.bots.get(seat.botId)!.avatar),
    );
    expect(new Set([...looks, JSON.stringify(bot.avatar)]).size).toBe(4);
  });

  it("makes a good plan file the plan waiting for approval, without a Planner turn", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    const published = watch(h);
    const out = tmp("out");
    const { bot } = await makeCoding(h, out);
    mkdirSync(join(out, "src"));
    writeFileSync(join(out, "src", "util.ts"), "// mine");

    const res = await importTo(h, bot.id, { plan: file });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.preview).toMatchObject({
      ok: true,
      files: 2,
      connections: 1,
      errors: [],
      existing: ["src/util.ts"],
    });
    expect(body.preview.nodes.map((n: { id: string }) => n.id)).toEqual(["n1", "n2"]);
    expect(body.project).toMatchObject({
      status: "awaiting_approval",
      brief: "A greeter, from the file",
      round: 0,
    });
    expect(body.project.cards.map((c: { id: string; column: string }) => [c.id, c.column])).toEqual([
      ["card_n1", "todo"],
      ["card_n2", "todo"],
    ]);
    // The plan file's connection is kept in the plan, without a card of its own.
    expect(body.project.edges).toHaveLength(1);
    expect(body.project.log.at(-1).text).toBe("You brought in a plan: 2 files, 1 connections");
    expect(published.at(-1)!.status).toBe("awaiting_approval");
    expect(messageText(chat(h, bot.threadId).at(-1)!)).toContain(
      "Plan brought in: 2 files and 1 connections.",
    );
    // Nothing was asked of any model, and the user's own file was not touched.
    expect(team.seen).toHaveLength(0);
    expect(readFileSync(join(out, "src", "util.ts"), "utf8")).toBe("// mine");
    // It is an ordinary plan from here: approving it builds it.
    await post(h, `/api/bots/${bot.id}/coding/approve`);
    await until(h, bot.id, (p) => p.status === "done");
    expect(turnsOf(team, "planner")).toHaveLength(0);
  });

  it("keeps the brief when the file has none, and reads a bare plan as well", async () => {
    h = await startTeam(codingTeam());
    const { bot } = await makeCoding(h, tmp("out"));
    await type(h, bot, "Build a greeter");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    const res = await importTo(h, bot.id, { plan: { nodes: ONE_FILE.nodes, edges: [] } });
    expect(res.json().project).toMatchObject({ brief: "Build a greeter", status: "awaiting_approval" });
    expect(res.json().project.nodes).toHaveLength(1);
  });

  it("reads a plan from the text of a file or a chat reply", async () => {
    h = await startTeam(codingTeam());
    const { bot } = await makeCoding(h, tmp("out"));
    const reply = `Sure, here is the plan you asked for:\n\`\`\`json\n${JSON.stringify(THREE_FILES)}\n\`\`\`\nTell me if you want changes.`;
    const res = await importTo(h, bot.id, { plan: reply, dryRun: true });
    expect(res.json().preview).toMatchObject({ ok: true, files: 2, connections: 1 });
    const text = await importTo(h, bot.id, { plan: JSON.stringify(file) });
    expect(text.json().project.brief).toBe("A greeter, from the file");
  });

  it("reports an invalid plan's errors verbatim and applies nothing", async () => {
    h = await startTeam(codingTeam());
    const published = watch(h);
    const { bot } = await makeCoding(h, tmp("out"));
    const bad = {
      nodes: [
        { path: "/etc/x", purpose: "" },
        { path: "a.txt", purpose: "ok" },
      ],
      edges: [{ files: ["a.txt"], description: "x" }],
    };
    const expected = validatePlan(bad);
    if (expected.ok) throw new Error("the plan should be invalid");
    const before = published.length;
    const res = await importTo(h, bot.id, { plan: bad });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      project: null,
      preview: { ok: false, files: 0, connections: 0, errors: expected.errors },
    });
    expect(getProject(h, bot.id)).toMatchObject({ status: "setup", cards: [] });
    expect(published).toHaveLength(before);
  });

  it("holds a plan to the same limits: too many files", async () => {
    h = await startTeam(codingTeam());
    const { bot } = await makeCoding(h, tmp("out"));
    const nodes = Array.from({ length: 41 }, (_, i) => ({ path: `f${i}.ts`, purpose: "x" }));
    const res = await importTo(h, bot.id, { plan: { nodes, edges: [] } });
    expect(res.json().preview.ok).toBe(false);
    expect(res.json().preview.errors[0]).toBe(
      "The plan has 41 files; the limit is 40. Merge small files or leave out what isn't needed.",
    );
  });

  it("refuses what isn't a plan, with a message", async () => {
    h = await startTeam(codingTeam());
    const { bot } = await makeCoding(h, tmp("out"));
    for (const plan of ["just some words", '{"hello": 1}', 42]) {
      const res = await h.app.inject({
        method: "POST",
        url: `/api/bots/${bot.id}/coding/import`,
        headers: auth,
        payload: { plan },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("couldn't find a plan");
    }
    const future = await importTo(h, bot.id, { plan: { ...file, version: 2 } });
    expect(future.statusCode).toBe(400);
    expect(future.json().message).toContain("version 2");
    expect((await importTo(h, bot.id, {})).statusCode).toBe(400);
  });

  it("changes nothing on a dry run", async () => {
    h = await startTeam(codingTeam());
    const published = watch(h);
    const out = tmp("out");
    const { bot } = await makeCoding(h, out);
    writeFileSync(join(out, "README.md"), "x");
    const before = published.length;
    const res = await importTo(h, bot.id, {
      plan: { nodes: [...THREE_FILES.nodes, { path: "README.md", purpose: "docs" }], edges: [] },
      dryRun: true,
    });
    expect(res.json()).toMatchObject({
      project: null,
      preview: { ok: true, files: 3, existing: ["README.md"] },
    });
    expect(getProject(h, bot.id)).toMatchObject({ status: "setup", cards: [], nodes: [] });
    expect(published).toHaveLength(before);
  });

  it("refuses while the team is working, and takes a plan once it is done, with replace", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const team = codingTeam({ plans: [{ tool: ONE_FILE }], develop: () => ({ wait }) });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.active?.role === "developer");
    const busy = await importTo(h, bot.id, { plan: file });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().needsReplace).toBeUndefined();
    release();
    await until(h, bot.id, (p) => p.status === "done");
    // A finished project is no dead end: a plan can start it over, once you say the done cards may go back to Todo.
    const moved = await importTo(h, bot.id, { plan: file });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().needsReplace).toBe(true);
    const replaced = await importTo(h, bot.id, { plan: file, replace: true });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().project.cards).toHaveLength(2);
    // Auto-approve is on: the new plan is built straight away.
    await until(h, bot.id, (p) => p.status === "done" && p.cards.length === 2);
  });

  it("takes a plan when the project stopped with an error or waits for you", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }], develop: () => ({ write: null, finish: false }) });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "error");
    team.behave.develop = () => ({});
    const res = await importTo(h, bot.id, { plan: { ...file, nodes: ONE_FILE.nodes, edges: [] } });
    expect(res.statusCode).toBe(200);
    await until(h, bot.id, (p) => p.status === "done");

    const stuck = codingTeam({ plans: [{ tool: ONE_FILE }], review: () => ({ pass: false, comment: "no" }) });
    await h.close();
    h = await startTeam(stuck);
    const second = await makeCoding(h, tmp("out"), { autoApprove: true, maxRounds: 1 });
    await type(h, second.bot, "Make a note");
    await until(h, second.bot.id, (p) => p.status === "needs_you");
    expect((await importTo(h, second.bot.id, { plan: file, replace: true })).statusCode).toBe(200);
  });

  it("refuses a plan body over 2 MB", async () => {
    h = await startTeam(codingTeam());
    const { bot } = await makeCoding(h, tmp("out"));
    const res = await importTo(h, bot.id, { plan: "x".repeat(2 * 1024 * 1024 + 10) });
    expect(res.statusCode).toBe(413);
  });

  it("asks for replace once cards have moved, and then starts every card again from Todo", async () => {
    const store = freshStore();
    const dataDir = tmp("data");
    const team = codingTeam();
    const first = await boot(store, team.handlers, dataDir);
    const { bot, project } = await makeCoding(first, tmp("out"));
    await first.close();
    const nodes = [{ id: "n1", path: "old.ts", purpose: "old" }];
    const cards = cardsFor(nodes, []);
    cards[0]!.column = "qa";
    cards[0]!.comments.push({ author: "developer", text: "done", round: 1, at: new Date().toISOString() });
    store.settings.set(`coding:${bot.id}`, {
      ...project,
      status: "stopped",
      brief: "old brief",
      nodes,
      edges: [],
      cards,
      round: 2,
    });

    h = await boot(store, team.handlers, dataDir);
    const refused = await importTo(h, bot.id, { plan: file });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ needsReplace: true });
    expect(getProject(h, bot.id).cards[0]!.column).toBe("qa");

    const replaced = await importTo(h, bot.id, { plan: file, replace: true });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().project).toMatchObject({
      status: "awaiting_approval",
      round: 0,
      brief: "A greeter, from the file",
    });
    const fresh = replaced.json().project.cards as { column: string; comments: unknown[] }[];
    expect(fresh.every((c) => c.column === "todo" && c.comments.length === 0)).toBe(true);
    expect(replaced.json().project.nodes.map((n: { path: string }) => n.path)).toEqual([
      "src/util.ts",
      "src/main.ts",
    ]);
    await h.close();
    store.close();
    h = undefined;
  });

  it("goes on to developing at once with auto-approve", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    const res = await importTo(h, bot.id, { plan: file });
    expect(res.json().project.status).toBe("developing");
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(done.cards).toHaveLength(2);
    expect(existsSync(join(out, "src", "main.ts"))).toBe(true);
    expect(turnsOf(team, "planner")).toHaveLength(0);
  });

  it("404s for a bot that isn't a Coding Bot", async () => {
    h = await startTeam(codingTeam());
    const plain = (await post(h, "/api/bots", { name: "Plain" })).json().bot;
    expect((await importTo(h, plain.id, { plan: file })).statusCode).toBe(404);
  });
});

describe("a key in a plan file's brief", () => {
  it("is taken out like any brief's: the project keeps its name", async () => {
    const key = "3f9a8c7d6e5b4a3f2e1d0c9b8a7f6e5d";
    h = await startTeam(codingTeam());
    const { bot } = await makeCoding(h, tmp("out"));
    const res = await importTo(h, bot.id, {
      plan: { ...file, brief: `A movie list.\nTMDB API Key: ${key}` },
    });
    expect(res.statusCode).toBe(200);
    expect(getProject(h, bot.id).brief).toBe("A movie list.\nTMDB API Key: {{TMDB_API_KEY}}");
    expect(JSON.stringify(getProject(h, bot.id))).not.toContain(key);
  });
});

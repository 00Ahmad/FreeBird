import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { messageText, type CodingProject, type Message } from "@mrog/shared";

import {
  cardsFor,
  filesReady,
  nextForDeveloper,
  planFromReply,
  reviewable,
  validatePlan,
} from "./coding-plan";
import { ROLE_TOOLS } from "./coding-tools";
import {
  boot,
  cleanTmp,
  codingTeam,
  freshStore,
  getProject,
  makeCoding,
  post,
  tmp,
  turnsOf,
  type,
  until,
  useSharedModel,
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

/** Every project the service published, in order. */
const watch = (harness: TestHarness) => {
  const published: CodingProject[] = [];
  harness.bus.subscribe((event) => {
    if (event.type === "coding.updated") published.push(event.project);
  });
  return published;
};

const chat = (harness: TestHarness, threadId: string): Message[] => harness.store.messages.list(threadId);

const ONE_FILE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };

describe("a Coding Bot's loop", () => {
  it("plans, waits for approval, develops, sends a failing card back with QA's comment, and finishes", async () => {
    const team = codingTeam({
      review: (card, nth) =>
        card.key === "src/util.ts" && nth === 1
          ? { pass: false, comment: "util is missing the greet export" }
          : { pass: true },
    });
    h = await startTeam(team);
    const published = watch(h);
    const pending: string[] = [];
    h.bus.subscribe((e) => {
      if (e.type !== "message.updated") return;
      for (const part of e.message.parts)
        if (part.type === "tool" && part.status === "pending_approval") pending.push(part.name);
    });
    const out = tmp("out");
    const { bot } = await makeCoding(h, out);

    // The brief is the first message; the Coding Bot itself runs no model turn.
    expect((await type(h, bot, "Build a greeter")).statusCode).toBe(201);
    const plan = await until(h, bot.id, (p) => p.status === "awaiting_approval");
    expect(plan.brief).toBe("Build a greeter");
    expect(plan.nodes.map((n) => [n.id, n.path])).toEqual([
      ["n1", "src/util.ts"],
      ["n2", "src/main.ts"],
    ]);
    expect(plan.edges).toEqual([
      { id: "e1", files: ["n2", "n1"], description: "main imports greet from util" },
    ]);
    expect(plan.cards.map((c) => [c.id, c.kind, c.column])).toEqual([
      ["card_n1", "file", "todo"],
      ["card_n2", "file", "todo"],
      ["card_e1", "connector", "todo"],
    ]);
    // Nothing is written before the plan is approved.
    expect(existsSync(join(out, "src", "util.ts"))).toBe(false);
    expect(turnsOf(team, "developer")).toHaveLength(0);

    expect((await post(h, `/api/bots/${bot.id}/coding/approve`)).statusCode).toBe(200);
    const done = await until(h, bot.id, (p) => p.status === "done");

    expect(done.round).toBe(2);
    expect(done.cards.every((c) => c.column === "done")).toBe(true);
    expect(readFileSync(join(out, "src", "util.ts"), "utf8")).toBe("// src/util.ts\n");
    expect(existsSync(join(out, "src", "main.ts"))).toBe(true);
    const util = done.cards[0]!;
    expect(util.comments.map((c) => [c.author, c.round, c.text])).toEqual([
      ["developer", 0, "Did src/util.ts"],
      ["qa", 1, "util is missing the greet export"],
      ["developer", 1, "Did src/util.ts"],
    ]);

    // Files first in the planner's order, a connection only after its files, and the fixed file once more.
    const developed = turnsOf(team, "developer");
    const keys = [...new Set(developed.map((s) => /^(?:File|Connection): (.+)$/m.exec(s.task)![1]))];
    expect(keys).toEqual(["src/util.ts", "src/main.ts", "main imports greet from util"]);
    // The fix gets QA's comment, and the message stands on its own: the brief, the card, the folder.
    const fix = developed.findLast((s) => s.task.includes("File: src/util.ts"))!;
    expect(fix.task).toContain("QA (round 1): util is missing the greet export");
    expect(fix.task).toContain("Build a greeter");
    expect(fix.task).toContain(out);
    // The connection waited in round 1, because QA failed a file it links; both are reviewed together in round 2.
    const reviewed = turnsOf(team, "qa").map((s) => /^(?:File|Connection): (.+)$/m.exec(s.task)![1]);
    expect(reviewed).toEqual(["src/util.ts", "src/main.ts", "src/util.ts", "main imports greet from util"]);

    // Every turn stands on its own: the model is sent the one task and nothing from earlier turns.
    for (const role of ["planner", "developer", "qa"] as const)
      for (const turn of turnsOf(team, role)) expect(turn.messages).toBe(1);

    // Each role has its own tools and nothing that hands work to other bots.
    for (const role of ["planner", "developer", "qa"] as const) {
      const tools = new Set(team.seen.filter((s) => s.role === role).flatMap((s) => s.tools));
      expect([...tools].toSorted()).toEqual(ROLE_TOOLS[role].toSorted());
    }
    // The Coding Bot never ran a model turn, and file writes in the output folder asked for nothing.
    expect(team.seen.filter((s) => s.role === "other")).toHaveLength(0);
    expect(pending).toEqual([]);

    // The chat tells the story, and the project was published after every change.
    const texts = chat(h, bot.threadId).map((m) => messageText(m));
    expect(texts.some((t) => t.startsWith("Plan ready: 2 files and 1 connections."))).toBe(true);
    expect(texts.some((t) => t.startsWith("Done: all 3 cards passed QA."))).toBe(true);
    expect(published.length).toBeGreaterThan(10);
    expect(new Set(published.map((p) => p.status))).toContain("awaiting_approval");
  });

  it("shows who is working and keeps a plain-English activity list of at most 50 lines", async () => {
    const team = codingTeam({
      review: (card, nth) =>
        card.key === "src/util.ts" && nth === 1
          ? { pass: false, comment: "util is missing the greet export and more" }
          : { pass: true },
    });
    h = await startTeam(team);
    const published = watch(h);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Build a greeter");
    const done = await until(h, bot.id, (p) => p.status === "done");

    const actives = published.flatMap((p) => (p.active ? [`${p.active.role}:${p.active.cardId}`] : []));
    expect(actives).toContain("planner:null");
    expect(actives).toContain("developer:card_n1");
    expect(actives).toContain("qa:card_e1");
    // Cleared when each turn ends, and when the project is done.
    expect(done.active).toBeNull();
    const lines = done.log!.map((l) => l.text);
    expect(lines).toContain("Developer started src/util.ts");
    expect(lines).toContain("Developer finished src/util.ts");
    expect(lines).toContain("QA passed src/main.ts");
    expect(lines).toContain("QA sent src/util.ts back: util is missing the greet export and more");
    expect(lines).toContain("Every card passed QA: the project is done");
    expect(done.log!.length).toBeLessThanOrEqual(50);
    // Oldest first, and every line published as it happened.
    expect(
      published.some(
        (p) => p.log?.some((l) => l.text === "Developer started src/util.ts") && p.status === "developing",
      ),
    ).toBe(true);
  });

  it("keeps only the last 50 activity lines", async () => {
    const store = freshStore();
    const dataDir = tmp("data");
    const team = codingTeam();
    const first = await boot(store, team.handlers, dataDir);
    const { bot, project } = await makeCoding(first, tmp("out"));
    await first.close();
    store.settings.set(`coding:${bot.id}`, {
      ...project,
      log: Array.from({ length: 50 }, (_, i) => ({ at: new Date().toISOString(), text: `old ${i}` })),
    });
    h = await boot(store, team.handlers, dataDir);
    await type(h, bot, "Anything");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    const log = getProject(h, bot.id).log!;
    expect(log).toHaveLength(50);
    expect(log[0]!.text).not.toBe("old 0");
    expect(log.at(-1)!.text).toContain("Planner finished the plan");
    await h.close();
    store.close();
    h = undefined;
  });

  it("skips the approval gate with auto-approve", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    h = await startTeam(team);
    const published = watch(h);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    expect(published.map((p) => p.status)).not.toContain("awaiting_approval");
  });

  it("turning auto-approve on while a plan waits approves it", async () => {
    h = await startTeam(codingTeam({ plans: [{ tool: ONE_FILE }] }));
    const { bot } = await makeCoding(h, tmp("out"));
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}/coding/settings`,
      headers: auth,
      payload: { autoApprove: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.autoApprove).toBe(true);
    await until(h, bot.id, (p) => p.status === "done");
  });

  it("sends the user's change request back to the planner and shows the new plan for approval", async () => {
    const second = { nodes: [...ONE_FILE.nodes, { path: "README.md", purpose: "how to use it" }], edges: [] };
    const team = codingTeam({ plans: [{ tool: ONE_FILE }, { tool: second }, { tool: second }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"));
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");

    const revise = await post(h, `/api/bots/${bot.id}/coding/revise`, { note: "add a README" });
    expect(revise.statusCode).toBe(200);
    const revised = await until(h, bot.id, (p) => p.status === "awaiting_approval" && p.nodes.length === 2);
    expect(revised.cards).toHaveLength(2);
    const asked = turnsOf(team, "planner").at(-1)!;
    expect(asked.task).toContain("add a README");
    expect(asked.task).toContain('"path": "a.txt"');

    // Typing in the Coding Bot's chat while the plan waits is the same thing.
    await type(h, bot, "and tests please");
    await until(h, bot.id, (p) => p.status === "awaiting_approval" && turnsOf(team, "planner").length === 3);
    expect(turnsOf(team, "planner").at(-1)!.task).toContain("and tests please");

    // Only a plan that is waiting can be changed or approved.
    await post(h, `/api/bots/${bot.id}/coding/approve`);
    await until(h, bot.id, (p) => p.status === "done");
    expect((await post(h, `/api/bots/${bot.id}/coding/revise`, { note: "x" })).statusCode).toBe(409);
    expect((await post(h, `/api/bots/${bot.id}/coding/approve`)).statusCode).toBe(409);
  });

  it("stops at needs_you when the round limit is reached, and continues after the limit is raised", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: () => ({ pass: false, comment: "still wrong" }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, maxRounds: 2 });
    await type(h, bot, "Make a note");
    const stuck = await until(h, bot.id, (p) => p.status === "needs_you");
    expect(stuck.round).toBe(2);
    expect(stuck.note).toContain("a.txt");
    expect(stuck.note).toContain("still wrong");
    expect(
      chat(h, bot.threadId)
        .map(messageText)
        .some((t) => t.startsWith("I stopped after round 2 of 2.")),
    ).toBe(true);

    // Resuming without raising the limit changes nothing.
    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(409);
    // Raising it does not resume by itself.
    const raised = await h.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}/coding/settings`,
      headers: auth,
      payload: { maxRounds: 3 },
    });
    expect(raised.json().project).toMatchObject({ status: "needs_you", maxRounds: 3 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getProject(h, bot.id).status).toBe("needs_you");

    // Resume: one more round, which fails again, then QA is content.
    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(200);
    expect((await until(h, bot.id, (p) => p.status === "needs_you" && p.round === 3)).round).toBe(3);
    team.behave.review = () => ({ pass: true });
    await h.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}/coding/settings`,
      headers: auth,
      payload: { maxRounds: 4 },
    });
    await post(h, `/api/bots/${bot.id}/coding/resume`);
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(done.round).toBe(4);
  });

  it("sends a Done connection back to QA when a file it links fails, and doesn't review it before the file is fixed", async () => {
    const store = freshStore();
    const dataDir = tmp("data");
    const team = codingTeam({
      review: (card, nth) =>
        card.key === "src/a.ts" && nth === 1 ? { pass: false, comment: "a is broken" } : { pass: true },
    });
    const first = await boot(store, team.handlers, dataDir);
    const { bot, project } = await makeCoding(first, tmp("out"));
    await first.close();
    // A project that stopped with a.ts waiting for QA while b.ts and the connection a.ts-b.ts are Done.
    const nodes = [
      { id: "n1", path: "src/a.ts", purpose: "a" },
      { id: "n2", path: "src/b.ts", purpose: "b" },
    ];
    const edges = [{ id: "e1", files: ["n1", "n2"], description: "a calls b" }];
    const cards = cardsFor(nodes, edges);
    cards[0]!.column = "qa";
    cards[1]!.column = "done";
    cards[2]!.column = "done";
    store.settings.set(`coding:${bot.id}`, {
      ...project,
      status: "stopped",
      brief: "x",
      nodes,
      edges,
      cards,
      round: 1,
    });

    h = await boot(store, team.handlers, dataDir);
    const published = watch(h);
    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(200);
    const done = await until(h, bot.id, (p) => p.status === "done");

    const back = published.find((p) => p.cards[2]!.column === "qa" && p.cards[0]!.column === "todo");
    expect(back).toBeTruthy();
    expect(back!.cards[2]!.comments.at(-1)!.text).toContain("Back in QA: src/a.ts failed review");
    expect(done.round).toBe(3);
    // Round 2 reviewed only the file; the connection came back to QA with the fixed file in round 3.
    const reviewed = turnsOf(team, "qa").map((s) => /^(?:File|Connection): (.+)$/m.exec(s.task)![1]);
    expect(reviewed).toEqual(["src/a.ts", "src/a.ts", "a calls b"]);
    await h.close();
    store.close();
    h = undefined;
  });

  it("stops at once, puts the card in hand back in Todo, and resumes where it left off", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const team = codingTeam({ plans: [{ tool: ONE_FILE }], develop: () => ({ wait }) });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.active?.role === "developer");
    expect(getProject(h, bot.id).cards[0]!.column).toBe("in_progress");

    // Typing while the team works gets the status, not a plan change.
    await type(h, bot, "actually, make it a poem");
    expect(messageText(chat(h, bot.threadId).at(-1)!)).toBe(
      "The team is working on round 1 of 5; stop it first to change the plan.",
    );

    const stopping = post(h, `/api/bots/${bot.id}/coding/stop`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The fake model ignores the stop signal, so let its request finish; the turn is stopped.
    release();
    const res = await stopping;
    expect(res.json().project).toMatchObject({ status: "stopped", active: null });
    const stopped = getProject(h, bot.id);
    expect(stopped.cards[0]!.column).toBe("todo");
    expect(existsSync(join(stopped.outputFolder, "a.txt"))).toBe(false);

    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(200);
    await until(h, bot.id, (p) => p.status === "done");
    expect(existsSync(join(stopped.outputFolder, "a.txt"))).toBe(true);
  });

  it("brings a project that was working when the app closed back as stopped, and a plan nobody approved back for approval", async () => {
    const store = freshStore();
    const dataDir = tmp("data");
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    const first = await boot(store, team.handlers, dataDir);
    const a = await makeCoding(first, tmp("out-a"), { name: "Alpha" });
    const b = await makeCoding(first, tmp("out-b"), { name: "Beta" });
    const c = await makeCoding(first, tmp("out-c"), { name: "Gamma" });
    await first.close();
    const cards = cardsFor(
      ONE_FILE.nodes.map((n, i) => ({ id: `n${i + 1}`, ...n })),
      [],
    );
    const nodes = [{ id: "n1", ...ONE_FILE.nodes[0]! }];
    const seed = (made: typeof a, over: Partial<CodingProject>) =>
      store.settings.set(`coding:${made.bot.id}`, { ...made.project, brief: "x", ...over });
    seed(a, {
      status: "developing",
      nodes,
      cards: [{ ...cards[0]!, column: "in_progress" }],
      active: { role: "developer", cardId: "card_n1" },
    });
    seed(b, { status: "planning", nodes, cards });
    seed(c, { status: "planning" });

    h = await boot(store, team.handlers, dataDir);
    const got = (id: string) => getProject(h!, id);
    expect(got(a.bot.id)).toMatchObject({ status: "stopped", active: null });
    expect(got(a.bot.id).cards[0]!.column).toBe("todo");
    expect(got(b.bot.id).status).toBe("awaiting_approval");
    expect(got(c.bot.id).status).toBe("stopped");
    const route = await h.app.inject({ url: `/api/bots/${a.bot.id}/coding`, headers: auth });
    expect(route.json().project.status).toBe("stopped");

    // And it can carry on.
    await post(h, `/api/bots/${a.bot.id}/coding/resume`);
    await until(h, a.bot.id, (p) => p.status === "done");
    await h.close();
    store.close();
    h = undefined;
  });

  it("gives each role its own model", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] }, ["test:1b", "big:7b", "small:3b"]);
    h = await startTeam(team);
    const { bot, project } = await makeCoding(h, tmp("out"), {
      autoApprove: true,
      roles: { planner: { model: "ollama:big:7b" }, developer: { model: "ollama:small:3b" }, qa: {} },
    });
    expect(project.roles.planner.model).toBe("ollama:big:7b");
    expect(project.roles.qa.model).toBeNull();
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const modelsOf = (role: string) => [
      ...new Set(team.seen.filter((s) => s.role === role).map((s) => s.model)),
    ];
    expect(modelsOf("planner")).toEqual(["big:7b"]);
    expect(modelsOf("developer")).toEqual(["small:3b"]);
    expect(modelsOf("qa")).toEqual(["test:1b"]);

    // Changing one in the settings is picked up by the next turn.
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}/coding/settings`,
      headers: auth,
      payload: { roles: { qa: { model: "ollama:big:7b" } } },
    });
    expect(res.json().project.roles.qa.model).toBe("ollama:big:7b");
    expect(h.store.bots.get(project.roles.qa.botId)!.model).toBe("ollama:big:7b");
    const bad = await h.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}/coding/settings`,
      headers: auth,
      payload: { roles: { qa: { model: "ollama:nope:1b" } } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("model_missing");
  });

  it("sends an invalid plan back with exactly what is wrong, then takes the corrected one", async () => {
    const bad = {
      nodes: [
        { path: "/etc/x", purpose: "" },
        { path: "a.txt", purpose: "ok" },
      ],
      edges: [{ files: ["a.txt"], description: "x" }],
    };
    const team = codingTeam({ plans: [{ tool: bad }, { json: ONE_FILE }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"));
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    const planner = turnsOf(team, "planner");
    expect(planner).toHaveLength(2);
    expect(planner[1]!.task).toContain("Your last plan was not accepted");
    expect(planner[1]!.task).toContain("paths are relative to the output folder; this one is absolute");
    expect(planner[1]!.task).toContain("a connection links at least 2 different files; this one has 1");
    // The corrected plan came as a JSON block in the reply, not through the tool.
    expect(getProject(h, bot.id).nodes.map((n) => n.path)).toEqual(["a.txt"]);
  });

  it("gives up on a planner that never sends a valid plan after three retries, and starts over on resume", async () => {
    const team = codingTeam({ plans: [{ tool: { nodes: [] } }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"));
    await type(h, bot, "Make a note");
    const failed = await until(h, bot.id, (p) => p.status === "error");
    expect(failed.error).toContain("couldn't make a valid plan after 4 tries");
    expect(turnsOf(team, "planner")).toHaveLength(4);
    team.behave.plans = [{ tool: ONE_FILE }];
    await post(h, `/api/bots/${bot.id}/coding/resume`);
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
  });

  it("asks again when the Developer finishes before the file exists, saying what happened", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      // First try: finishes without writing the file (refused), twice. Third: does it properly.
      develop: (_card, attempt) => (attempt < 3 ? { write: null } : {}),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(done.cards[0]!.comments.map((c) => [c.author, c.kind])).toEqual([["developer", "note"]]);
    const retries = turnsOf(team, "developer").filter((s) =>
      s.task.includes("Your last try read 0 files and wrote nothing."),
    );
    expect(retries).toHaveLength(2);
    expect(retries[0]!.task).toContain("Write a.txt now with at most 2 reads, then call finish_card.");
  });

  it("sends a file the Developer wrote to QA even when it never called finish_card", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }], develop: () => ({ finish: false }) });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(turnsOf(team, "developer")).toHaveLength(1);
    expect(done.log!.map((l) => l.text)).toContain(
      "a.txt was written; sent to QA (finish_card wasn't called)",
    );
    expect(turnsOf(team, "qa").map((s) => s.task)).toHaveLength(1);
  });

  it("asks again when a fix turn leaves the file as it was and never calls finish_card", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      // The fix writes the same content again and doesn't finish; the next try does.
      develop: (_card, attempt) => (attempt === 2 ? { finish: false } : {}),
      review: (_card, nth) => (nth === 1 ? { pass: false, comment: "needs a heading" } : { pass: true }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const fixes = turnsOf(team, "developer").slice(1);
    expect(fixes).toHaveLength(2);
    expect(fixes[1]!.task).toContain("Your last try wrote a.txt, but finish_card was not called.");
    expect(fixes[1]!.task).toContain("Written so far: a.txt.");
  });

  it("stops with an error after three turns without finish_card, and resumes", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      develop: () => ({ write: null, finish: false }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const failed = await until(h, bot.id, (p) => p.status === "error");
    expect(failed.error).toContain("never called finish_card");
    expect(failed.cards[0]!.column).toBe("todo");
    team.behave.develop = () => ({});
    await post(h, `/api/bots/${bot.id}/coding/resume`);
    await until(h, bot.id, (p) => p.status === "done");
  });

  it("wants a comment when QA fails a card, and asks again without one", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: (_card, nth) =>
        nth === 1
          ? { pass: false, comment: "" }
          : nth === 2
            ? { pass: false, comment: "no heading" }
            : { pass: true },
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(done.cards[0]!.comments.filter((c) => c.author === "qa").map((c) => c.text)).toEqual([
      "no heading",
    ]);
    expect(done.round).toBe(2);
  });
});

describe("approval cards from the team", () => {
  /** The first pending approval card in the Coding Bot's chat. */
  const cardIn = async (harness: TestHarness, threadId: string) => {
    for (let i = 0; i < 400; i++) {
      for (const message of chat(harness, threadId))
        for (const part of message.parts)
          if (part.type === "tool" && part.status === "pending_approval" && part.approval)
            return { message, part };
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error("No approval card appeared in the Coding Bot's chat.");
  };

  it("shows QA's command card in the Coding Bot's chat, runs it once approved, and doesn't hold the model meanwhile", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: () => ({ pass: true, command: "echo spiked > made.txt" }),
    });
    h = await startTeam(team);
    const published = watch(h);
    const out = tmp("out");
    const { bot, project } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Make a note");

    const { message, part } = await cardIn(h, bot.threadId);
    expect(message).toMatchObject({ botId: bot.id, model: null, status: "streaming" });
    expect(part.name).toBe("Alpha QA · run_command");
    expect(part.approval).toMatchObject({ kind: "terminal", summary: "echo spiked > made.txt" });
    expect(existsSync(join(out, "made.txt"))).toBe(false);

    // The command waits for the user without holding the model: another bot's reply goes through (one slot).
    const plain = (await post(h, "/api/bots", { name: "Plain" })).json().bot;
    await type(h, plain, "hi");
    await until(h, bot.id, () =>
      chat(h!, plain.threadId).some((m) => m.role === "bot" && m.status === "done"),
    );
    expect(messageText(chat(h, plain.threadId).at(-1)!)).toBe("hello");
    expect(getProject(h, bot.id).cards[0]!.column).toBe("qa");
    expect(published.at(-1)!.log!.map((l) => l.text)).toContain(
      "Alpha QA · run_command is waiting for your approval: echo spiked > made.txt",
    );

    expect(
      (await post(h, `/api/approvals/${part.approval!.id}`, { decision: "allow_once" })).statusCode,
    ).toBe(204);
    await until(h, bot.id, (p) => p.status === "done");
    // The command ran from the output folder.
    expect(existsSync(join(out, "made.txt"))).toBe(true);
    expect(getProject(h, bot.id).log!.map((l) => l.text)).toContain("You approved Alpha QA · run_command");
    // The card stays on the phase's message as a record, and the phase's message is finished.
    const final = chat(h, bot.threadId).find((m) => m.id === message.id)!;
    expect(final.status).toBe("done");
    expect(final.parts.some((p) => p.type === "tool" && p.status === "done")).toBe(true);
    // Answering the card marked the chat as working; once the phase is over nothing may leave it that way.
    expect(h.services.turns.activities()[bot.threadId]).toBeUndefined();
    expect(project.outputFolder).toBe(out);
  });

  it("doesn't run a command the user denied", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: () => ({ pass: true, command: "echo spiked > made.txt" }),
    });
    h = await startTeam(team);
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Make a note");
    const { part } = await cardIn(h, bot.threadId);
    await post(h, `/api/approvals/${part.approval!.id}`, { decision: "deny" });
    await until(h, bot.id, (p) => p.status === "done");
    expect(existsSync(join(out, "made.txt"))).toBe(false);
    expect(getProject(h, bot.id).log!.map((l) => l.text)).toContain("You denied Alpha QA · run_command");
  });

  it("closes a card nobody answered when the team is stopped", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: () => ({ pass: true, command: "echo hi" }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const { message } = await cardIn(h, bot.threadId);
    await post(h, `/api/bots/${bot.id}/coding/stop`);
    const closed = chat(h, bot.threadId).find((m) => m.id === message.id)!;
    expect(closed.status).toBe("stopped");
    expect(closed.parts.some((p) => p.type === "tool" && p.status === "pending_approval")).toBe(false);
    expect(getProject(h, bot.id).status).toBe("stopped");
    // The stopped card was answered by the stop; nothing leaves the chat looking busy.
    expect(h.services.turns.activities()[bot.threadId]).toBeUndefined();
  });
});

describe("talking to the team", () => {
  it("answers a message in a team thread with a note instead of a model turn", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    const { bot, project } = await makeCoding(h, tmp("out"));
    const pair = h.store.threads
      .list()
      .find((t) => t.pair && t.memberIds.includes(project.roles.planner.botId))!;
    expect(pair.title).toBe("Alpha ↔ Planner");
    await post(h, `/api/threads/${pair.id}/messages`, { text: "hey planner" });
    const own = h.store.bots.get(project.roles.planner.botId)!;
    await post(h, `/api/threads/${own.threadId}/messages`, { text: "hey again" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(team.seen).toHaveLength(0);
    expect(messageText(chat(h, pair.id).at(-1)!)).toContain("runs the team from its own chat");
    expect(bot.coding).toBe(true);
  });

  it("answers with a short status when a message can't change anything", async () => {
    h = await startTeam(
      codingTeam({ plans: [{ tool: ONE_FILE }], develop: () => ({ write: null, finish: false }) }),
    );
    const { bot } = await makeCoding(h, tmp("out"));
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    await post(h, `/api/bots/${bot.id}/coding/approve`);
    await until(h, bot.id, (p) => p.status === "error");
    await type(h, bot, "thanks");
    const last = chat(h, bot.threadId).at(-1)!;
    expect(messageText(last)).toMatch(/^I stopped because of a problem: The Developer didn't finish/);
    expect(last.botId).toBe(bot.id);
  });

  it("never starts a model turn for a Coding Bot by retry, routine or hand-over", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    useSharedModel(h);
    const { bot } = await makeCoding(h, tmp("out"));
    const coding = h.store.bots.get(bot.id)!;
    await expect(h.services.turns.start(h.store.threads.get(coding.threadId)!, coding)).rejects.toThrow(
      "runs its team",
    );
    const retry = await post(h, `/api/threads/${coding.threadId}/retry`, {
      botId: bot.id,
      messageId: chat(h, coding.threadId)[0]!.id,
    });
    expect(retry.statusCode).toBe(409);
    // Another coordinator can't hand work to it either.
    await post(h, "/api/bots", { name: "Plain" });
    const boss = (await post(h, "/api/bots", { name: "Boss", coordinator: true })).json().bot;
    const roster = h.services.agent.listTools(boss).find((t) => t.name === "message_bot")!.description;
    expect(roster).toContain("Plain");
    expect(roster).not.toContain("Alpha");
    expect(team.seen).toHaveLength(0);
  });

  it("404s for a bot that isn't a Coding Bot", async () => {
    h = await startTeam(codingTeam());
    const plain = (await post(h, "/api/bots", { name: "Plain" })).json().bot;
    for (const url of ["", "/approve", "/stop", "/resume"]) {
      const res = await h.app.inject({
        method: url ? "POST" : "GET",
        url: `/api/bots/${plain.id}/coding${url}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("a Coding Bot's creation", () => {
  it("makes the bot, a hidden team with their own models, and their threads", async () => {
    h = await startTeam(codingTeam());
    const events: string[] = [];
    h.bus.subscribe((e) => void events.push(e.type));
    const out = tmp("out");
    const { bot, project } = await makeCoding(h, out, { maxRounds: 4 });
    expect(bot).toMatchObject({
      name: "Alpha",
      label: "Coding Bot",
      coding: true,
      model: null,
      hidden: false,
    });
    expect(project).toMatchObject({
      status: "setup",
      outputFolder: out,
      maxRounds: 4,
      autoApprove: false,
      round: 0,
      cards: [],
    });
    for (const [role, name] of [
      ["planner", "Planner"],
      ["developer", "Developer"],
      ["qa", "QA"],
    ] as const) {
      const member = h.store.bots.get(project.roles[role].botId)!;
      expect(member).toMatchObject({
        name: `Alpha ${name}`,
        parentId: bot.id,
        temporary: false,
        hidden: true,
        section: "Coding team",
        coding: false,
      });
      const pair = h.store.threads.list().find((t) => t.pair && t.memberIds.includes(member.id))!;
      expect(pair).toMatchObject({ title: `Alpha ↔ ${name}`, kind: "group", memberIds: [bot.id, member.id] });
      // The team's tools are the role's own, so the Details panel and the model agree.
      expect(
        h.services.agent
          .listTools(member)
          .filter((t) => t.enabled)
          .map((t) => t.name)
          .toSorted(),
      ).toEqual(ROLE_TOOLS[role].toSorted());
    }
    expect(h.services.agent.listTools(h.store.bots.get(bot.id)!)).toEqual([]);
    expect(events.filter((e) => e === "bot.created")).toHaveLength(4);
    expect(events).toContain("coding.updated");
    expect(events.filter((e) => e === "thread.created").length).toBeGreaterThanOrEqual(7);
    const got = await h.app.inject({ url: `/api/bots/${bot.id}/coding`, headers: auth });
    expect(got.json().project).toEqual(project);
    expect(messageText(chat(h, bot.threadId)[0]!)).toContain("Tell me what to build");
  });

  it("refuses what can't work, saying why", async () => {
    h = await startTeam(codingTeam());
    const out = tmp("out");
    const make = (payload: Record<string, unknown>) =>
      h!.app.inject({
        method: "POST",
        url: "/api/coding-bots",
        headers: auth,
        payload: {
          name: "Alpha",
          outputFolder: out,
          roles: { planner: {}, developer: {}, qa: {} },
          ...payload,
        },
      });
    // No model: neither the roles' own nor a shared one.
    let res = await make({});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "model_missing" });
    useSharedModel(h);
    res = await make({ roles: { planner: { model: "ollama:nope:1b" }, developer: {}, qa: {} } });
    expect(res.json()).toMatchObject({ error: "model_missing" });
    expect(res.json().message).toContain("ollama:nope:1b");
    res = await make({ outputFolder: "relative/dir" });
    expect(res.json().message).toContain("must be a full path");
    res = await make({ name: "x".repeat(55) });
    expect(res.json().message).toContain("too long");
    expect((await make({})).statusCode).toBe(201);
    res = await make({ outputFolder: tmp("other") });
    expect(res.json().message).toContain("already exists");
    res = await make({ name: "Beta" });
    expect(res.json().message).toContain("already writes to");
  });
});

describe("validatePlan", () => {
  const ok = (plan: unknown) => {
    const result = validatePlan(plan);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    return result;
  };
  const errors = (plan: unknown) => {
    const result = validatePlan(plan);
    return result.ok ? [] : result.errors;
  };
  const node = (path: string, purpose = "does a thing") => ({ path, purpose });

  it("numbers files and connections and maps a connection's paths to files", () => {
    const plan = ok({
      nodes: [node("a.ts"), node("src\\b.ts"), node("./c.ts")],
      edges: [{ files: ["a.ts", "src/b.ts", "C.ts"], description: "all three share a type" }],
    });
    expect(plan.nodes.map((n) => [n.id, n.path])).toEqual([
      ["n1", "a.ts"],
      ["n2", "src/b.ts"],
      ["n3", "c.ts"],
    ]);
    expect(plan.edges).toEqual([
      { id: "e1", files: ["n1", "n2", "n3"], description: "all three share a type" },
    ]);
  });

  it("accepts the shapes small models send", () => {
    const plan = ok({
      nodes: JSON.stringify([node("a.ts"), node("b.ts")]),
      edges: [
        { files: "a.ts, b.ts", description: "x" },
        { files: ["b.ts", "a.ts"], description: "x" },
      ],
    });
    // The same connection twice is one.
    expect(plan.edges).toHaveLength(1);
    expect(ok({ nodes: [node("a.ts")] }).edges).toEqual([]);
    expect(ok({ files: [node("a.ts")] }).nodes).toHaveLength(1);
  });

  it.each([
    [{}, "The plan has no files"],
    [{ nodes: [] }, "The plan has no files"],
    ["plan", "must be an object"],
    [{ nodes: [node("")] }, "nodes[0]: the path is empty"],
    [{ nodes: [node("/etc/passwd")] }, "this one is absolute"],
    [{ nodes: [node("C:\\x\\a.ts")] }, "this one is absolute"],
    [{ nodes: [node("../a.ts")] }, 'can\'t contain ".."'],
    [{ nodes: [node("src/../../a.ts")] }, 'can\'t contain ".."'],
    [{ nodes: [node("src/")] }, "that is a folder"],
    [{ nodes: [node("a?.ts")] }, "characters a file name can't have"],
    [{ nodes: [node("a.ts", "  ")] }, "the purpose is empty"],
    [{ nodes: [{ path: "a.ts" }] }, "the purpose is empty"],
    [{ nodes: [node("a.ts"), node("A.ts")] }, "listed twice (also nodes[0])"],
    [{ nodes: [node("src"), node("src/a.ts")] }, "needs it to be a folder"],
    [
      { nodes: [node("a.ts"), node("b.ts")], edges: [{ files: ["a.ts"], description: "x" }] },
      "at least 2 different files; this one has 1",
    ],
    [
      { nodes: [node("a.ts"), node("b.ts")], edges: [{ files: ["a.ts", "a.ts"], description: "x" }] },
      "this one has 1",
    ],
    [
      { nodes: [node("a.ts"), node("b.ts")], edges: [{ files: ["a.ts", "z.ts"], description: "x" }] },
      "“z.ts” isn't one of the plan's files",
    ],
    [
      { nodes: [node("a.ts"), node("b.ts")], edges: [{ files: ["a.ts", "b.ts"], description: "" }] },
      "the description is empty",
    ],
    [{ nodes: [node("a.ts")], edges: "x" }, '"edges" must be a list'],
    [{ nodes: [node("a.ts")], edges: [{ description: "x" }] }, '"files" must be a list'],
  ])("rejects %j", (plan, message) => {
    expect(errors(plan).join("\n")).toContain(message);
  });

  it("limits the number of files and connections", () => {
    const nodes = Array.from({ length: 41 }, (_, i) => node(`f${i}.ts`));
    expect(errors({ nodes }).join("\n")).toContain("The plan has 41 files; the limit is 40");
    const edges = Array.from({ length: 81 }, () => ({ files: ["f0.ts", "f1.ts"], description: "x" }));
    expect(errors({ nodes: nodes.slice(0, 2), edges }).join("\n")).toContain(
      "81 connections; the limit is 80",
    );
  });

  it("lists every problem, so one retry can fix them all", () => {
    const list = errors({ nodes: [node(""), node("../a.ts"), node("b.ts", "")] });
    expect(list).toHaveLength(3);
  });
});

describe("planFromReply", () => {
  it("finds the plan in a fenced block, a bare object or after thinking, and ignores other JSON", () => {
    const plan = { nodes: [{ path: "a.ts", purpose: "x" }], edges: [] };
    expect(planFromReply(`Sure!\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nDone.`)).toEqual(plan);
    expect(planFromReply(`<think>{"nodes": 1}</think>\n${JSON.stringify(plan)}`)).toEqual(plan);
    expect(
      planFromReply(`\`\`\`\n{"other": 1}\n\`\`\`\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``),
    ).toEqual(plan);
    expect(planFromReply("I would make a.ts and b.ts.")).toBeNull();
    expect(planFromReply('{"nodes": [broken')).toBeNull();
  });
});

describe("the board", () => {
  const project = () => {
    const nodes = [
      { id: "n1", path: "a.ts", purpose: "a" },
      { id: "n2", path: "b.ts", purpose: "b" },
    ];
    const edges = [{ id: "e1", files: ["n1", "n2"], description: "a uses b" }];
    return { nodes, edges, cards: cardsFor(nodes, edges) } as CodingProject;
  };

  it("builds files in the planner's order and a connection only after its files are written", () => {
    const p = project();
    expect(nextForDeveloper(p)!.id).toBe("card_n1");
    p.cards[0]!.column = "qa";
    expect(nextForDeveloper(p)!.id).toBe("card_n2");
    p.cards[1]!.column = "in_progress";
    expect(nextForDeveloper(p)).toBeNull();
    p.cards[1]!.column = "qa";
    expect(nextForDeveloper(p)!.id).toBe("card_e1");
    // A file QA sent back holds the connection up again.
    p.cards[0]!.column = "todo";
    expect(nextForDeveloper(p)!.id).toBe("card_n1");
  });

  it("lets QA review a connection only while none of its files is waiting to be fixed", () => {
    const p = project();
    p.cards.forEach((card) => (card.column = "qa"));
    expect(reviewable(p).map((c) => c.id)).toEqual(["card_n1", "card_n2", "card_e1"]);
    p.cards[0]!.column = "todo";
    expect(reviewable(p).map((c) => c.id)).toEqual(["card_n2"]);
    expect(filesReady(p, p.cards[2]!)).toBe(false);
  });
});

import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { messageText, SLOW_CARD_SECONDS, type CodingProject } from "@mrog/shared";

import { alreadyWritten, cardsFor, zeroWork } from "./coding-plan";
import { DEVELOPER_MAX_READS, DEVELOPER_MAX_STEPS, developerMessage, ROLE_TOOLS } from "./coding-tools";
import {
  cleanTmp,
  codingTeam,
  getProject,
  makeCoding,
  post,
  THREE_FILES,
  tmp,
  turnsOf,
  type,
  until,
} from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const startTeam = (team: ReturnType<typeof codingTeam>) =>
  makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });

const watch = (target: TestHarness) => {
  const published: CodingProject[] = [];
  target.bus.subscribe((event) => {
    if (event.type === "coding.updated") published.push(event.project);
  });
  return published;
};

const ONE_FILE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };
const keyOf = (task: string) => /^(?:File|Connection): (.+)$/m.exec(task)![1];

describe("one card per turn", () => {
  it("tells the Developer which file is its card, which files it connects to, and what it must not do", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Build a greeter");
    await until(h, bot.id, (p) => p.status === "done");
    const [util, main, connection] = turnsOf(team, "developer").map((s) => s.task);
    expect(util).toContain("Write only this file: src/util.ts.");
    expect(util).toContain("with write_file");
    expect(util).toContain("Do not write any other file: the other files are other cards");
    expect(util).toContain(
      "Make no helper, scratch, verification, duplicate, backup or temporary files or scripts",
    );
    expect(util).toContain("You can't run commands: QA runs and tests the work");
    // Only the files it connects to are named for reading, and one that isn't written yet is named as such.
    expect(util).not.toContain("Files already written");
    expect(util).toContain(
      "Not written yet (a later card writes them): src/main.ts. Don't read them: follow the connection description instead.",
    );
    expect(util).toContain("Read at most 6 files in all, then write.");
    expect(main).toContain("Write only this file: src/main.ts.");
    expect(main).toContain(
      "Files already written (read these only if you need them, and no others): src/util.ts.",
    );
    expect(main).not.toContain("Not written yet");
    expect(main).toContain("Call finish_card straight after writing");
    // A connection may edit the files it links, and still makes no scripts.
    expect(connection).toContain("editing only the files it links (src/main.ts, src/util.ts)");
    expect(connection).toContain("Make no helper, scratch");
    expect(connection).not.toContain("Write only this file");
  });

  it("names no file to read when the card connects to none", () => {
    const nodes = [{ id: "n1", path: "solo.txt", purpose: "alone" }];
    const project = {
      brief: "b",
      outputFolder: "/out",
      round: 0,
      nodes,
      edges: [],
      cards: cardsFor(nodes, []),
    };
    const text = developerMessage(project as unknown as CodingProject, project.cards[0]!);
    expect(text).toContain("connects to no other file");
  });

  it("refuses a write to another card's planned file during a file card's turn, and allows it for a connection", async () => {
    const team = codingTeam({
      develop: (card) =>
        card.key === "src/util.ts"
          ? { extra: { path: "src/main.ts", content: "STOLEN\n" } }
          : card.kind === "connector"
            ? { extra: { path: "src/util.ts", content: "// edited by the connection\n" } }
            : {},
    });
    h = await startTeam(team);
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Build a greeter");
    await until(h, bot.id, (p) => p.status === "done");
    const told = turnsOf(team, "developer").length && team.seen.map((s) => s.lastTool);
    expect(told).toContainEqual(expect.stringContaining("src/main.ts belongs to another card"));
    expect(told).toContainEqual(expect.stringContaining("write only src/util.ts"));
    // main.ts is what its own card wrote; util.ts was edited by the connection card, which may.
    expect(readFileSync(join(out, "src", "main.ts"), "utf8")).toBe("// src/main.ts\n");
    expect(readFileSync(join(out, "src", "util.ts"), "utf8")).toBe("// edited by the connection\n");
  });
});

describe("thinking and steps", () => {
  it("turns thinking off for the Developer only, even when the model list doesn't say it thinks", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Build a greeter");
    await until(h, bot.id, (p) => p.status === "done");
    const thinks = (role: string) => [
      ...new Set(team.seen.filter((s) => s.role === role).map((s) => s.think)),
    ];
    expect(thinks("developer")).toEqual([false]);
    expect(thinks("planner")).toEqual([undefined]);
    expect(thinks("qa")).toEqual([undefined]);
  });

  it("stops a Developer turn that loops after DEVELOPER_MAX_STEPS rounds, and retries it saying what happened", async () => {
    expect(DEVELOPER_MAX_STEPS).toBe(15);
    const team = codingTeam({ plans: [{ tool: ONE_FILE }], develop: () => ({ loop: true }) });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const failed = await until(h, bot.id, (p) => p.status === "error");
    expect(failed.error).toContain("never called finish_card and wrote nothing after reading 6 files");
    // Each of the 3 tries makes at most 15 rounds and the one closing reply.
    const requests = team.seen.filter((s) => s.role === "developer").length;
    expect(requests).toBeLessThanOrEqual(3 * (DEVELOPER_MAX_STEPS + 1));
    expect(requests).toBeGreaterThan(3 * 10);
    const retries = turnsOf(team, "developer").filter((s) => s.task.includes("Your last try"));
    expect(retries).toHaveLength(2);
    expect(retries[0]!.task).toContain(
      "Your last try read 6 files and wrote nothing, and it hit the step limit. Write a.txt now with at most 2 reads, then call finish_card.",
    );
  });

  it("refuses a 7th file to read, says a planned file isn't written yet, and steers once with 3 steps left", async () => {
    expect(DEVELOPER_MAX_READS).toBe(6);
    const team = codingTeam({ plans: [{ tool: THREE_FILES }], develop: () => ({ loop: true }) });
    h = await startTeam(team);
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    for (let i = 0; i < 8; i++) {
      mkdirSync(join(out, "notes"), { recursive: true });
      writeFileSync(join(out, "notes", `${i}.txt`), `note ${i}\n`);
    }
    await type(h, bot, "Build a greeter");
    await until(h, bot.id, (p) => p.status === "error");
    const firstTry = team.seen.filter((s) => s.role === "developer" && !s.task.includes("Your last try"));
    const results = firstTry.map((s) => s.lastTool);
    // Six different files are read; the seventh is refused.
    expect(new Set(results.filter((r) => /^1\| note \d/.test(r)))).toHaveProperty("size", 6);
    expect(results).toContainEqual(
      "You have read enough. Write src/util.ts now with write_file, then call finish_card.",
    );
    // With 3 of the 15 rounds left, one note says to write the file now.
    const steered = firstTry.filter((s) => s.notes.length > 0);
    expect(steered.length).toBeGreaterThan(0);
    // (The engine's own out-of-steps note, in brackets, is the closing request's.)
    expect(new Set(firstTry.flatMap((s) => s.notes.filter((n) => !n.startsWith("("))))).toEqual(
      new Set(["3 steps left: write src/util.ts now with write_file, then call finish_card."]),
    );
    expect(firstTry.findIndex((s) => s.notes.length > 0)).toBe(DEVELOPER_MAX_STEPS - 3);
  });

  it("answers a read of a planned file nobody wrote yet with where it comes from, not an error", async () => {
    const team = codingTeam({
      develop: (card) => (card.key === "src/util.ts" ? { reads: ["src/main.ts", "./src/util.ts"] } : {}),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Build a greeter");
    await until(h, bot.id, (p) => p.status === "done");
    const told = team.seen.map((s) => s.lastTool);
    expect(told).toContain(
      "src/main.ts is not written yet; another card writes it later. Don't read it: use the connection description.",
    );
    expect(told).toContain(
      "src/util.ts is not written yet: writing it is this card's job. Write it now with write_file.",
    );
    expect(told.some((t) => /ENOENT|no such file/i.test(t))).toBe(false);
  });

  it("names the card's own file to read on a fix, once it exists", () => {
    const out = tmp("out");
    const nodes = [
      { id: "n1", path: "a.txt", purpose: "a" },
      { id: "n2", path: "b.txt", purpose: "b" },
    ];
    const edges = [{ id: "e1", files: ["n1", "n2"], description: "a uses b" }];
    const project = { brief: "b", outputFolder: out, round: 1, nodes, edges, cards: cardsFor(nodes, edges) };
    writeFileSync(join(out, "a.txt"), "written");
    const text = developerMessage(project as unknown as CodingProject, project.cards[0]!);
    expect(text).toContain("Files already written (read these only if you need them, and no others): a.txt.");
    expect(text).toContain("Not written yet (a later card writes them): b.txt.");
  });
});

describe("no commands for the Developer", () => {
  it("gives the Developer no run_command (or any command tool) and QA still has it", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }], develop: () => ({ command: "echo hi" }) });
    h = await startTeam(team);
    const { bot, project } = await makeCoding(h, tmp("out"), { autoApprove: true });
    expect(ROLE_TOOLS.developer).not.toContain("run_command");
    expect(ROLE_TOOLS.qa).toContain("run_command");
    const developer = h.store.bots.get(project.roles.developer.botId)!;
    expect(developer.tools.allow).not.toContain("run_command");
    expect(h.services.agent.listTools(developer).map((tool) => tool.name)).not.toContain("run_command");
    expect(
      h.services.agent.listTools(h.store.bots.get(project.roles.qa.botId)!).map((tool) => tool.name),
    ).toContain("run_command");

    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    for (const request of team.seen.filter((s) => s.role === "developer"))
      expect(request.tools.some((tool) => /run_command|computer_|command|terminal/.test(tool))).toBe(false);
    // A call to it anyway finds nothing to run, and nothing asked the user.
    expect(team.seen.map((s) => s.lastTool)).toContainEqual(
      expect.stringContaining('no tool named "run_command"'),
    );
    expect(
      h.store.messages.list(bot.threadId).some((m) => m.parts.some((p) => p.type === "tool" && p.approval)),
    ).toBe(false);
  });

  it("tells QA to run and test the code", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const qa = team.seen.find((s) => s.role === "qa")!;
    expect(qa.system).toContain("You run and test the code");
    expect(qa.system).toContain("install the packages it needs");
    expect(qa.task).toContain("You are the one who runs the code");
    expect(team.seen.find((s) => s.role === "developer")!.system).toContain("You cannot run commands");
  });
});

describe("a file that is already written", () => {
  const project = (out: string, startedAt: Date, over: Partial<CodingProject> = {}) => {
    const nodes = [
      { id: "n1", path: "a.txt", purpose: "a" },
      { id: "n2", path: "b.txt", purpose: "b" },
    ];
    const edges = [{ id: "e1", files: ["n1", "n2"], description: "a uses b" }];
    return {
      outputFolder: out,
      startedAt: startedAt.toISOString(),
      nodes,
      edges,
      cards: cardsFor(nodes, edges),
      ...over,
    } as CodingProject;
  };
  const past = () => new Date(Date.now() - 60_000);

  it("is true for a file the team wrote, and false in each of the four cases that must not skip the Developer", () => {
    const out = tmp("out");
    const p = project(out, past());
    writeFileSync(join(out, "a.txt"), "content");
    expect(alreadyWritten(p, p.cards[0]!)).toBe(true);

    // Not a file that was never written, nor an empty one.
    expect(alreadyWritten(p, p.cards[1]!)).toBe(false);
    writeFileSync(join(out, "b.txt"), "");
    expect(alreadyWritten(p, p.cards[1]!)).toBe(false);
    // Not a file that was there before the project began.
    writeFileSync(join(out, "b.txt"), "old");
    utimesSync(join(out, "b.txt"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    expect(alreadyWritten(p, p.cards[1]!)).toBe(false);
    // Not a card QA sent back (it has comments).
    p.cards[0]!.comments.push({ author: "qa", text: "wrong", round: 1, at: new Date().toISOString() });
    expect(alreadyWritten(p, p.cards[0]!)).toBe(false);
    // Never a connection, even when something sits at the path its title spells.
    writeFileSync(join(out, p.cards[2]!.title), "x");
    expect(alreadyWritten(p, p.cards[2]!)).toBe(false);
  });

  it("sends a file the team already wrote straight to QA, logs it, and still gives the next card to the Developer", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    const published = watch(h);
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    mkdirSync(join(out, "src"), { recursive: true });
    writeFileSync(join(out, "src", "util.ts"), "// written earlier\n");
    // Windows stamps files from a clock that ticks every ~15 ms, so a file written just after the project began can
    // look older than it; this one is clearly from after.
    const later = new Date(Date.now() + 2000);
    utimesSync(join(out, "src", "util.ts"), later, later);
    await type(h, bot, "Build a greeter");
    const done = await until(h, bot.id, (p) => p.status === "done");

    const keys = turnsOf(team, "developer").map((s) => keyOf(s.task));
    expect(keys).toEqual(["src/main.ts", "main imports greet from util"]);
    expect(readFileSync(join(out, "src", "util.ts"), "utf8")).toBe("// written earlier\n");
    expect(done.log!.map((l) => l.text)).toContain("src/util.ts was already written; sent to QA");
    // The card went to QA without a Developer turn, and QA reviewed it.
    expect(done.cards[0]!.work!.turns).toBe(1);
    expect(done.cards[0]!.work!.startedAt).toBeNull();
    expect(published.some((p) => p.cards[0]?.column === "qa" && p.status === "developing")).toBe(true);
    expect(turnsOf(team, "qa").map((s) => keyOf(s.task))).toContain("src/util.ts");
  });

  it("still runs the Developer for a file older than the project", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    mkdirSync(join(out, "src"), { recursive: true });
    writeFileSync(join(out, "src", "util.ts"), "// from last year\n");
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(out, "src", "util.ts"), old, old);
    await type(h, bot, "Build a greeter");
    await until(h, bot.id, (p) => p.status === "done");
    expect(turnsOf(team, "developer").map((s) => keyOf(s.task))[0]).toBe("src/util.ts");
    expect(readFileSync(join(out, "src", "util.ts"), "utf8")).toBe("// src/util.ts\n");
  });

  it("still runs the Developer for a card QA sent back, whose file exists", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: (_card, nth) => (nth === 1 ? { pass: false, comment: "needs a heading" } : { pass: true }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(turnsOf(team, "developer")).toHaveLength(2);
    expect(done.log!.map((l) => l.text)).not.toContain("a.txt was already written; sent to QA");
  });
});

describe("time and tokens per card", () => {
  it("starts every card at zero, however it was made", async () => {
    const nodes = THREE_FILES.nodes.map((n, i) => ({ id: `n${i + 1}`, ...n }));
    expect(cardsFor(nodes, []).every((c) => JSON.stringify(c.work) === JSON.stringify(zeroWork()))).toBe(
      true,
    );
    expect(zeroWork()).toEqual({ startedAt: null, seconds: 0, inputTokens: 0, outputTokens: 0, turns: 0 });

    h = await startTeam(codingTeam());
    const { bot } = await makeCoding(h, tmp("out"));
    const res = await post(h, `/api/bots/${bot.id}/coding/import`, { plan: THREE_FILES });
    const cards = res.json().project.cards as { work: unknown }[];
    expect(cards).toHaveLength(3);
    for (const card of cards) expect(card.work).toEqual(zeroWork());
  });

  it("adds each Developer and QA turn's time and tokens to its card, and sets startedAt once", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: (_card, nth) => (nth === 1 ? { pass: false, comment: "needs a heading" } : { pass: true }),
    });
    h = await startTeam(team);
    const published = watch(h);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const done = getProject(h, bot.id);
    const work = done.cards[0]!.work!;

    // Two Developer turns and two QA turns; every model request reported 100 in and 10 out.
    expect(work.turns).toBe(4);
    const requests = team.seen.filter(
      (s) => (s.role === "developer" || s.role === "qa") && !s.finalCheck,
    ).length;
    expect(work.inputTokens).toBe(100 * requests);
    expect(work.outputTokens).toBe(10 * requests);
    expect(work.seconds).toBeGreaterThanOrEqual(0);
    // Set when the card first went In progress, and never moved by the send-back.
    expect(work.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const starts = new Set(
      published.flatMap((p) => (p.cards[0]?.work?.startedAt ? [p.cards[0].work.startedAt] : [])),
    );
    expect([...starts]).toEqual([work.startedAt]);
    // Counted after the first Developer turn already, before QA looked.
    const afterDeveloper = published.find((p) => p.cards[0]?.work?.turns === 1)!;
    expect(afterDeveloper.cards[0]!.work!.inputTokens).toBe(100 * 3);
    expect(afterDeveloper.cards[0]!.work!.outputTokens).toBe(10 * 3);
  });

  it("marks when the running turn began, and clears it when the turn ends", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const team = codingTeam({ plans: [{ tool: ONE_FILE }], develop: () => ({ wait }) });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const running = await until(h, bot.id, (p) => p.active?.role === "developer");
    expect(running.active!.since).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(Date.parse(running.active!.since!)).toBeLessThanOrEqual(Date.now());
    release();
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(done.active).toBeNull();
  });

  it("says once when a card has taken too long, and keeps the minutes in the note", async () => {
    expect(SLOW_CARD_SECONDS).toBe(600);
    const wait = new Promise<void>((resolve) => setTimeout(resolve, 400));
    const team = codingTeam({ plans: [{ tool: ONE_FILE }], develop: () => ({ wait }) });
    h = await startTeam(team);
    // Ten minutes in the real world is 50 milliseconds here, checked every 20.
    h.services.coding.timing.slowSeconds = 0.05;
    h.services.coding.timing.tickMs = 20;
    const published = watch(h);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");

    expect(
      published.some((p) => /^Developer is working on a\.txt \(\d+ min so far\)$/.test(p.note ?? "")),
    ).toBe(true);
    // Once while each role has it: the time is the card's, so QA isn't said to have spent the Developer's minutes.
    expect(done.log!.map((l) => l.text).filter((text) => text.includes("has taken"))).toEqual([
      "a.txt has taken 1 minute so far (Developer is on it)",
      "a.txt has taken 1 minute so far (QA is on it)",
    ]);
  });

  it("says nothing about a card that is quick", async () => {
    h = await startTeam(codingTeam({ plans: [{ tool: ONE_FILE }] }));
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(done.log!.some((l) => l.text.includes("has taken"))).toBe(false);
    expect(existsSync(done.outputFolder)).toBe(true);
    expect(messageText(h.store.messages.list(bot.threadId).at(-1)!)).toContain("Done");
  });
});

describe("the chat's activity", () => {
  it("is not left looking busy between one role's turns and the next once a card was answered", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const two = {
      nodes: [
        { path: "a.txt", purpose: "a" },
        { path: "b.txt", purpose: "b" },
      ],
      edges: [],
    };
    const team = codingTeam({
      plans: [{ tool: two }],
      review: (card) => (card.key === "a.txt" ? { pass: true, command: "echo hi" } : { pass: true, wait }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Two notes");
    let cardId: string | undefined;
    for (let i = 0; i < 400 && !cardId; i++) {
      for (const message of h.store.messages.list(bot.threadId))
        for (const part of message.parts)
          if (part.type === "tool" && part.status === "pending_approval" && part.approval)
            cardId = part.approval.id;
      if (!cardId) await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await post(h, `/api/approvals/${cardId}`, { decision: "allow_once" });
    // QA is now on the second card, still inside the same phase.
    await until(h, bot.id, (p) => p.active?.role === "qa" && p.active.cardId === "card_n2");
    expect(h.services.turns.activities()[bot.threadId]).toBeUndefined();
    release();
    await until(h, bot.id, (p) => p.status === "done");
  });
});

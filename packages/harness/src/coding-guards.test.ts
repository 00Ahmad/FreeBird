import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { messageText, type CodingProject } from "@mrog/shared";

import { ROLE_TOOLS } from "./coding-tools";
import {
  boot,
  cleanTmp,
  codingTeam,
  freshStore,
  finalChecksOf,
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

/** What the role bots may and may not touch, what they are told, and what happens when their model fails. */

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const startTeam = async (team: ReturnType<typeof codingTeam>) => {
  const harness = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
  // A failed model is asked again at once here, not after 2 and 10 seconds.
  harness.services.coding.timing.retryBackoffMs = [0, 0];
  return harness;
};

const watch = (target: TestHarness) => {
  const published: CodingProject[] = [];
  target.bus.subscribe((event) => {
    if (event.type === "coding.updated") published.push(event.project);
  });
  return published;
};

const ONE_FILE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };
const LINES = {
  nodes: [
    { path: "a.js", purpose: "a" },
    { path: "b.js", purpose: "b" },
    { path: "c.js", purpose: "c" },
  ],
  edges: [{ files: ["a.js", "b.js"], description: "a calls b" }],
};

describe("what a role may write", () => {
  it("refuses helper files, tool folders, other names for a file and files of other cards, and writes its own", async () => {
    const tries = [
      { path: "helper.js", content: "scratch\n" },
      { path: ".vscode/tasks.json", content: "{}\n" },
      { path: ".git/hooks/pre-commit", content: "echo pwned\n" },
      { path: "src/util.ts:hidden", content: "stream\n" },
      { path: "SRC~1/util.ts", content: "short name\n" },
      { path: "../outside.txt", content: "escape\n" },
      { path: "SRC/MAIN.TS", content: "other card, other case\n" },
    ];
    const team = codingTeam({ develop: (card) => (card.key === "src/util.ts" ? { extras: tries } : {}) });
    h = await startTeam(team);
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Build a greeter");
    await until(h, bot.id, (p) => p.status === "done");
    const told = team.seen.map((s) => s.lastTool);
    expect(told).toContainEqual(
      expect.stringContaining("Not written: helper.js is not one of the project's planned files."),
    );
    expect(told).toContainEqual(expect.stringContaining("Not written: .vscode/tasks.json is off limits"));
    expect(told).toContainEqual(expect.stringContaining("Not written: .git/hooks/pre-commit is off limits"));
    expect(told).toContainEqual(
      expect.stringMatching(/^Not written: src\/util\.ts:hidden can't be written because it is not a plain/),
    );
    expect(told).toContainEqual(expect.stringMatching(/^Not written: SRC~1\/util\.ts can't be written/));
    expect(told).toContainEqual(
      expect.stringContaining("Not written: ../outside.txt can't be written because it is outside"),
    );
    for (const path of ["helper.js", ".vscode", ".git", "outside.txt"])
      expect(existsSync(join(out, path))).toBe(false);
    expect(existsSync(join(out, "..", "outside.txt"))).toBe(false);
    if (process.platform === "win32" || process.platform === "darwin")
      expect(told).toContainEqual(
        expect.stringContaining("Not written: src/main.ts belongs to another card"),
      );
    // Its own file and the other card's are each what their own card wrote.
    expect(readFileSync(join(out, "src", "util.ts"), "utf8")).toBe("// src/util.ts\n");
    expect(readFileSync(join(out, "src", "main.ts"), "utf8")).toBe("// src/main.ts\n");
  });

  it("lets a connection change only the files it links, on an older board that has connection cards", async () => {
    const team = codingTeam({
      plans: [{ tool: LINES }],
      develop: (card) =>
        card.kind === "connector"
          ? {
              extras: [
                { path: "c.js", content: "// not linked\n" },
                { path: "b.js", content: "// b, connected\n" },
              ],
            }
          : {},
    });
    h = await startTeam(team);
    h.services.coding.timing.connectionCards = true;
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Three files");
    await until(h, bot.id, (p) => p.status === "done");
    expect(team.seen.map((s) => s.lastTool)).toContainEqual(
      "Not written: c.js is not one of the files this card may change. This connection may change only the files it links: a.js, b.js.",
    );
    expect(readFileSync(join(out, "c.js"), "utf8")).toBe("// c.js\n");
    expect(readFileSync(join(out, "b.js"), "utf8")).toBe("// b, connected\n");
  });
});

describe("what a role may read", () => {
  it("never reads a file that may hold secrets, by its name or another name for it, and leaves it out of searches", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      develop: () => ({ reads: [".env", "config/.env.local", "id_rsa", ".env::$DATA", "ENV~1"] }),
      review: () => ({ pass: true, reads: [".env"], search: "TOKEN" }),
    });
    h = await startTeam(team);
    const out = tmp("out");
    writeFileSync(join(out, ".env"), "TOKEN=real-secret-123\n");
    writeFileSync(join(out, "id_rsa"), "-----BEGIN KEY----- TOKEN\n");
    writeFileSync(join(out, "notes.md"), "the TOKEN goes in .env\n");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const told = team.seen.map((s) => s.lastTool);
    expect(told).toContain(
      "Not read: .env is off limits because it may hold real secrets. Don't read it or copy anything from it.",
    );
    expect(told).toContain(
      "Not read: config/.env.local is off limits because it may hold real secrets. Don't read it or copy anything from it.",
    );
    expect(told).toContainEqual(
      expect.stringContaining("Not read: id_rsa is off limits because it is a private key"),
    );
    expect(told).toContainEqual(expect.stringMatching(/^Not read: \.env::\$DATA can't be read/));
    expect(told).toContainEqual(expect.stringMatching(/^Not read: ENV~1 can't be read/));
    // QA's search finds the line in notes.md, and nothing from the secret files.
    const search = told.find((t) => t.includes("notes.md:1:"))!;
    expect(search).toContain("the TOKEN goes in .env");
    expect(told.some((t) => t.includes("real-secret-123") || t.includes("BEGIN KEY"))).toBe(false);
  });
});

describe("QA's commands", () => {
  it("always show a card without Auto-approve, even with commands set to always allowed", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      review: () => ({ pass: true, command: "echo hi" }),
    });
    h = await startTeam(team);
    const approvals = h.services.agent.approvals;
    approvals.savePermissions({ ...approvals.permissions(), localExecution: "always" });
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: false });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    expect((await post(h, `/api/bots/${bot.id}/coding/approve`)).statusCode).toBe(200);
    let card: { id: string } | undefined;
    for (let i = 0; i < 400 && !card; i++) {
      for (const message of h.store.messages.list(bot.threadId))
        for (const part of message.parts)
          if (part.type === "tool" && part.status === "pending_approval" && part.approval)
            card = part.approval;
      if (!card) await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(card).toBeTruthy();
    await post(h, `/api/approvals/${card!.id}`, { decision: "deny" });
    await until(h, bot.id, (p) => p.status === "done");
  });
});

describe("what each role is told and given", () => {
  it("gives the Developer its four tools plus the two skill tools, and no generic lines about plans, memory or the shell", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    h = await startTeam(team);
    const { bot, project } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    expect(ROLE_TOOLS.developer.toSorted()).toEqual([
      "edit_file",
      "find_skills",
      "finish_card",
      "read_file",
      "use_skill",
      "write_file",
    ]);
    for (const role of ["planner", "developer", "qa"] as const)
      expect(ROLE_TOOLS[role]).not.toContain("update_plan");
    const developer = team.seen.find((s) => s.role === "developer")!;
    expect(developer.tools.toSorted()).toEqual([
      "edit_file",
      "find_skills",
      "finish_card",
      "read_file",
      "use_skill",
      "write_file",
    ]);
    for (const role of ["planner", "developer", "qa"] as const) {
      const system = team.seen.find((s) => s.role === role)!.system;
      expect(system).not.toContain("update_plan");
      expect(system).not.toContain("save it with remember");
      // The team's own rules are still there.
      expect(system).toContain("You are on a small software team");
    }
    expect(developer.system).not.toMatch(/PowerShell|commands run in sh/);
    expect(team.seen.find((s) => s.role === "qa")!.system).toMatch(/This computer runs/);
    // The role bots never send desktop notifications.
    for (const role of ["planner", "developer", "qa"] as const)
      expect(h.store.bots.get(project.roles[role].botId)!.notifications).toBe(false);
  });

  it("offers QA only review_card on a card and only finish_check on the whole project", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const review = turnsOf(team, "qa")[0]!;
    expect(review.tools).toContain("review_card");
    expect(review.tools).not.toContain("finish_check");
    const check = finalChecksOf(team)[0]!;
    expect(check.tools).toContain("finish_check");
    expect(check.tools).not.toContain("review_card");
  });

  it("brings an older team's tool list and notifications in line with the code", async () => {
    const store = freshStore();
    const dataDir = tmp("data");
    const team = codingTeam();
    const first = await boot(store, team.handlers, dataDir);
    const { project } = await makeCoding(first, tmp("out"));
    const developerId = project.roles.developer.botId;
    const old = first.store.bots.get(developerId)!;
    first.store.bots.update(developerId, {
      notifications: true,
      tools: {
        ...old.tools,
        allow: ["list_files", "read_file", "search_files", "update_plan", "write_file"],
      },
    });
    await first.close();
    h = await boot(store, team.handlers, dataDir);
    expect(h.services.coding.get(project.botId)).not.toBeNull();
    const synced = h.store.bots.get(developerId)!;
    expect(synced.tools.allow).toEqual(ROLE_TOOLS.developer);
    expect(synced.notifications).toBe(false);
    await h.close();
    store.close();
    h = undefined;
  });
});

describe("when a model fails", () => {
  it("tries a Developer turn again after a model error instead of ending the project", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      develop: (_card, attempt) => (attempt === 1 ? { failAt: 0 } : {}),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done" || p.status === "error");
    expect(done.status).toBe("done");
    expect(done.log!.map((l) => l.text)).toContainEqual(
      expect.stringContaining("The Developer's model failed on a.txt"),
    );
    const retry = turnsOf(team, "developer")[1]!;
    expect(retry.task).toContain("Your last try stopped with an error");
  });

  it("counts model errors as tries and stops with the error after three", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }], develop: () => ({ failAt: 0 }) });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const failed = await until(h, bot.id, (p) => p.status === "error");
    expect(failed.error).toMatch(/^The Developer couldn't finish “a\.txt” after 3 tries: /);
    expect(turnsOf(team, "developer")).toHaveLength(3);
  });

  it("keeps a verdict QA gave when the model fails afterwards, and a card the Developer finished", async () => {
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      // The Developer writes and finishes (requests 0 and 1), then its closing reply fails.
      develop: () => ({ failAt: 2 }),
      // QA's verdict is recorded on request 0; the reply after it fails.
      review: () => ({ pass: true, failAt: 1 }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    const done = await until(h, bot.id, (p) => p.status === "done" || p.status === "error");
    expect(done.status).toBe("done");
    expect(turnsOf(team, "developer")).toHaveLength(1);
    expect(turnsOf(team, "qa")).toHaveLength(1);
    expect(done.log!.map((l) => l.text)).toContain("Developer finished a.txt");
  });

  it("asks the Planner again after a model error", async () => {
    const team = codingTeam({ plans: [{ fail: true }, { tool: ONE_FILE }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"));
    await type(h, bot, "Make a note");
    const plan = await until(h, bot.id, (p) => p.status === "awaiting_approval" || p.status === "error");
    expect(plan.status).toBe("awaiting_approval");
    expect(turnsOf(team, "planner")).toHaveLength(2);
  });
});

describe("the team's own conversations", () => {
  const pairOf = (harness: TestHarness, roleBotId: string) =>
    harness.store.threads.list().find((t) => t.pair && t.memberIds.includes(roleBotId))!;

  it.each([
    ["Stop", (harness: TestHarness, id: string) => post(harness, `/api/threads/${id}/stop`)],
    [
      "Clear chat",
      (harness: TestHarness, id: string) =>
        harness.app.inject({ method: "DELETE", url: `/api/threads/${id}/messages`, headers: auth }),
    ],
  ])("stops the project properly when %s is pressed in a team thread, and resumes", async (_name, press) => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      develop: (_c, attempt) => (attempt === 1 ? { wait } : {}),
    });
    h = await startTeam(team);
    const { bot, project } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.active?.role === "developer");
    await press(h, pairOf(h, project.roles.developer.botId).id);
    release();
    const stopped = await until(h, bot.id, (p) => p.status === "stopped");
    expect(stopped).toMatchObject({
      active: null,
      note: "Stopped from the team's conversation; press Resume to carry on.",
    });
    expect(stopped.cards[0]!.column).toBe("todo");
    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(200);
    await until(h, bot.id, (p) => p.status === "done");
  });

  it("makes a team thread again if it was deleted or its members were changed", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    const { bot, project } = await makeCoding(h, tmp("out"), { autoApprove: true });
    const planner = pairOf(h, project.roles.planner.botId);
    h.store.threads.delete(planner.id);
    const developer = pairOf(h, project.roles.developer.botId);
    const other = (await post(h, "/api/bots", { name: "Other" })).json().bot;
    h.store.threads.update(developer.id, { memberIds: [...developer.memberIds, other.id] });
    await type(h, bot, "Build a greeter");
    await until(h, bot.id, (p) => p.status === "done");
    const pairs = h.store.threads.list().filter((t) => t.pair && t.memberIds.length === 2);
    expect(pairs.find((t) => t.memberIds.includes(project.roles.planner.botId))!.title).toBe(
      "Alpha ↔ Planner",
    );
    expect(pairs.find((t) => t.memberIds.includes(project.roles.developer.botId))).toBeTruthy();
    // The old thread with three members is no longer the team's: it can be deleted like any group.
    const old = await h.app.inject({ method: "DELETE", url: `/api/threads/${developer.id}`, headers: auth });
    expect(old.statusCode).toBe(204);
  });

  it("refuses to delete a team thread, change its members, duplicate the team or rename its bots", async () => {
    h = await startTeam(codingTeam());
    const { bot, project } = await makeCoding(h, tmp("out"));
    const pair = pairOf(h, project.roles.qa.botId);
    const other = (await post(h, "/api/bots", { name: "Other" })).json().bot;
    const call = (method: "DELETE" | "PATCH" | "POST", url: string, payload?: Record<string, unknown>) =>
      h!.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });

    const deleted = await call("DELETE", `/api/threads/${pair.id}`);
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().message).toContain("goes when you delete the Coding Bot");
    expect(
      (await call("PATCH", `/api/threads/${pair.id}`, { memberIds: [...pair.memberIds, other.id] }))
        .statusCode,
    ).toBe(409);
    expect((await call("PATCH", `/api/threads/${pair.id}`, { title: "Renamed" })).statusCode).toBe(200);
    expect((await call("POST", `/api/bots/${bot.id}/duplicate`)).statusCode).toBe(409);
    expect((await call("POST", `/api/bots/${project.roles.qa.botId}/duplicate`)).statusCode).toBe(409);
    expect((await call("POST", `/api/bots/${other.id}/duplicate`)).statusCode).toBe(201);

    const renamed = await call("PATCH", `/api/bots/${project.roles.qa.botId}`, { name: "Someone" });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json().message).toContain("rename the Coding Bot instead");
    // The same name sent with another change is not a rename.
    expect(
      (await call("PATCH", `/api/bots/${project.roles.qa.botId}`, { name: "Alpha QA", pinned: true }))
        .statusCode,
    ).toBe(200);
    const long = await call("PATCH", `/api/bots/${bot.id}`, { name: "x".repeat(50) });
    expect(long.statusCode).toBe(409);
    expect(long.json().message).toContain("up to 49 characters");
    expect((await call("PATCH", `/api/bots/${bot.id}`, { name: "y".repeat(49) })).statusCode).toBe(200);
    // A group the user made with the Coding Bot in it is theirs to delete.
    const group = (await post(h, "/api/threads", { memberIds: [bot.id, other.id] })).json().thread;
    expect((await call("DELETE", `/api/threads/${group.id}`)).statusCode).toBe(204);
  });
});

describe("no dead ends", () => {
  it("takes a message as a new brief after the Planner failed with no plan", async () => {
    const team = codingTeam({ plans: [{ tool: { nodes: [] } }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"));
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "error");
    team.behave.plans = [{ tool: ONE_FILE }];
    await type(h, bot, "Make a short note instead");
    const plan = await until(h, bot.id, (p) => p.status === "awaiting_approval");
    expect(plan.brief).toBe("Make a short note instead");
  });

  it("turns a message to a finished project into an updated plan that rewrites only what changed", async () => {
    const changed = {
      nodes: [
        { path: "a.txt", purpose: "a note" },
        { path: "README.md", purpose: "how to use it" },
      ],
      edges: [{ files: ["a.txt", "README.md"], description: "the README explains the note" }],
    };
    const team = codingTeam({ plans: [{ tool: ONE_FILE }, { tool: changed }] });
    h = await startTeam(team);
    const out = tmp("out");
    const { bot } = await makeCoding(h, out);
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    await post(h, `/api/bots/${bot.id}/coding/approve`);
    await until(h, bot.id, (p) => p.status === "done");
    const developedBefore = turnsOf(team, "developer").length;

    await type(h, bot, "add a README");
    const updated = await until(h, bot.id, (p) => p.status === "awaiting_approval");
    const asked = turnsOf(team, "planner").at(-1)!.task;
    expect(asked).toContain("The project was built from this plan");
    expect(asked).toContain('"path": "a.txt"');
    expect(asked).toContain("add a README");
    expect(asked).toContain("Keep every file the change doesn't touch exactly as it is");
    // A card per file: the connection stays in the plan, with no card of its own.
    expect(updated.cards.map((c) => [c.title, c.column])).toEqual([
      ["a.txt", "done"],
      ["README.md", "todo"],
    ]);
    expect(updated.edges).toHaveLength(1);
    // The kept card keeps its history; the new ones carry the request.
    expect(updated.cards[0]!.comments.map((c) => c.author)).toContain("developer");
    expect(updated.cards[1]!.comments).toEqual([
      expect.objectContaining({ author: "user", kind: "note", text: "Change asked for: add a README" }),
    ]);
    expect(updated.note).toContain("1 card kept as done");

    await post(h, `/api/bots/${bot.id}/coding/approve`);
    await until(h, bot.id, (p) => p.status === "done");
    const keys = turnsOf(team, "developer")
      .slice(developedBefore)
      .map((s) => /^(?:File|Connection): (.+)$/m.exec(s.task)![1]);
    expect(keys).toEqual(["README.md"]);
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("// README.md\n");
  });

  it("keeps the built files when the updated plan is changed again before it is approved", async () => {
    const withReadme = {
      nodes: [...ONE_FILE.nodes, { path: "README.md", purpose: "how to use it" }],
      edges: [],
    };
    const withLicense = {
      nodes: [...withReadme.nodes, { path: "LICENSE", purpose: "the licence" }],
      edges: [],
    };
    const team = codingTeam({ plans: [{ tool: ONE_FILE }, { tool: withReadme }, { tool: withLicense }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"));
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "awaiting_approval");
    await post(h, `/api/bots/${bot.id}/coding/approve`);
    await until(h, bot.id, (p) => p.status === "done");
    await type(h, bot, "add a README");
    await until(h, bot.id, (p) => p.status === "awaiting_approval" && p.nodes.length === 2);
    await type(h, bot, "and a licence");
    const again = await until(h, bot.id, (p) => p.status === "awaiting_approval" && p.nodes.length === 3);
    const asked = turnsOf(team, "planner").at(-1)!.task;
    expect(asked).toContain("and a licence");
    expect(asked).toContain("Keep every file the change doesn't touch exactly as it is");
    expect(again.cards.map((c) => [c.title, c.column])).toEqual([
      ["a.txt", "done"],
      ["README.md", "todo"],
      ["LICENSE", "todo"],
    ]);
  });

  it("rewrites a file whose purpose the change touched, even though it is already there", async () => {
    const changed = { nodes: [{ path: "a.txt", purpose: "a note with a heading" }], edges: [] };
    const team = codingTeam({ plans: [{ tool: ONE_FILE }, { tool: changed }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    await type(h, bot, "give it a heading");
    await until(h, bot.id, (p) => p.status === "done" && turnsOf(team, "developer").length === 2);
    const fix = turnsOf(team, "developer")[1]!;
    expect(fix.task).toMatch(/The user \(round \d\): Change asked for: give it a heading/);
    expect(fix.task).toContain("What the code in it should do: a note with a heading");
  });

  it("keeps a change asked for when the Planner is stopped, across a restart, and carries on with it on Resume", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const second = { nodes: [...ONE_FILE.nodes, { path: "b.txt", purpose: "b" }], edges: [] };
    const team = codingTeam({ plans: [{ tool: ONE_FILE }, { tool: second, wait }, { tool: second }] });
    const store = freshStore();
    const dataDir = tmp("data");
    const first = await boot(store, team.handlers, dataDir);
    const { bot } = await makeCoding(first, tmp("out"));
    await type(first, bot, "Make a note");
    await until(first, bot.id, (p) => p.status === "awaiting_approval");
    await post(first, `/api/bots/${bot.id}/coding/revise`, { note: "add b.txt" });
    await until(first, bot.id, (p) => p.active?.role === "planner");
    const stopping = post(first, `/api/bots/${bot.id}/coding/stop`);
    release();
    expect((await stopping).json().project.status).toBe("stopped");
    await first.close();

    h = await boot(store, team.handlers, dataDir);
    expect(getProject(h, bot.id).status).toBe("stopped");
    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(200);
    const revised = await until(h, bot.id, (p) => p.status === "awaiting_approval");
    expect(revised.nodes.map((n) => n.path)).toEqual(["a.txt", "b.txt"]);
    expect(turnsOf(team, "planner").at(-1)!.task).toContain("add b.txt");
    await h.close();
    store.close();
    h = undefined;
  });
});

describe("small things", () => {
  it("doesn't leave QA's slow note about a card it has finished", async () => {
    // The pause starts when QA picks the card up, not when the test starts: on a busy machine the setup alone can take
    // longer than the pause, and QA would then never be slow.
    const slowReview = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
    const two = {
      nodes: [
        { path: "a.txt", purpose: "a" },
        { path: "b.txt", purpose: "b" },
      ],
      edges: [],
    };
    const team = codingTeam({
      plans: [{ tool: two }],
      review: (card) => (card.key === "a.txt" ? { pass: true, wait: slowReview() } : { pass: true }),
    });
    h = await startTeam(team);
    h.services.coding.timing.slowSeconds = 0.05;
    h.services.coding.timing.tickMs = 20;
    const published = watch(h);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Two notes");
    await until(h, bot.id, (p) => p.status === "done");
    expect(published.some((p) => p.note?.startsWith("QA is working on a.txt"))).toBe(true);
    const passed = published.find((p) => p.cards[0]?.column === "done")!;
    expect(passed.note ?? "").not.toContain("QA is working on a.txt");
  });

  it("doesn't count the time a turn waits for the shared model as time spent on the card", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      develop: (_c, attempt) => (attempt === 1 ? { wait } : {}),
    });
    h = await startTeam(team);
    const { bot, project } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.active?.role === "developer");
    const pair = h.store.threads
      .list()
      .find((t) => t.pair && t.memberIds.includes(project.roles.developer.botId))!;
    const botId = project.roles.developer.botId;
    // What the turn manager shows while a request waits for a slot on the shared model, then gets it.
    const since = Date.parse(getProject(h, bot.id).active!.since!);
    h.bus.publish({ type: "thread.activity", threadId: pair.id, botId, activity: "queued" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    h.bus.publish({ type: "thread.activity", threadId: pair.id, botId, activity: "thinking" });
    // The running turn is counted from when it got the model, on screen too.
    expect(Date.parse(getProject(h, bot.id).active!.since!) - since).toBeGreaterThanOrEqual(350);
    release();
    const done = await until(h, bot.id, (p) => p.status === "done");
    // The Developer's own turn took over 400 ms, nearly all of it queued.
    expect(done.cards[0]!.work!.seconds).toBeLessThan(0.3);
  });

  it("sets a kind on every comment it writes", async () => {
    const team = codingTeam({
      review: (card, nth) =>
        card.key === "src/util.ts" && nth === 1
          ? { pass: false, comment: "broken" }
          : { pass: true, comment: "fine" },
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Build a greeter");
    const done = await until(h, bot.id, (p) => p.status === "done");
    const kinds = done.cards.flatMap((c) => c.comments.map((m) => m.kind));
    expect(kinds.every((kind) => kind !== undefined)).toBe(true);
    expect(new Set(kinds)).toEqual(new Set(["note", "fail", "pass"]));
  });

  it("doesn't let Resume start a second run while a stopped one is still winding down", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const team = codingTeam({
      plans: [{ tool: ONE_FILE }],
      develop: (_c, attempt) => (attempt === 1 ? { wait } : {}),
    });
    h = await startTeam(team);
    h.services.coding.timing.stopWaitMs = 30;
    const { bot, project } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.active?.role === "developer");
    // The fake model ignores Stop, so the stopped run is still waiting on it when Stop gives up waiting.
    expect((await post(h, `/api/bots/${bot.id}/coding/stop`)).json().project.status).toBe("stopped");
    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pair = h.store.threads
      .list()
      .find((t) => t.pair && t.memberIds.includes(project.roles.developer.botId))!;
    const tasks = () =>
      h!.store.messages
        .list(pair.id)
        .filter((m) => m.botId === bot.id && messageText(m).includes("YOUR CARD"));
    expect(tasks()).toHaveLength(1);
    release();
    await until(h, bot.id, (p) => p.status === "done");
    expect(tasks()).toHaveLength(2);
  });

  it("finishes the whole loop with every guard in place", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    const out = tmp("out");
    mkdirSync(join(out, "src"), { recursive: true });
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Build a greeter");
    const done = await until(h, bot.id, (p) => p.status === "done");
    // A card per file; the connections stay in the plan without cards of their own.
    expect(done.cards).toHaveLength(THREE_FILES.nodes.length);
    expect(done.edges).toHaveLength(THREE_FILES.edges.length);
  });
});

import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkOutputFolder, CodingError } from "./coding-folder";
import { cleanTmp, codingTeam, makeCoding, post, tmp, type, until, useSharedModel } from "./coding-testing";
import { auth, makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const ONE_FILE_DEEP = { nodes: [{ path: "src/a.txt", purpose: "a note" }], edges: [] };

const rules = (over: Partial<Parameters<typeof checkOutputFolder>[1]> = {}) => ({
  dataDir: tmp("data"),
  taken: [] as string[],
  home: tmp("home"),
  ...over,
});
const refused = (input: string, over?: Parameters<typeof rules>[0]) => {
  try {
    checkOutputFolder(input, rules(over));
  } catch (error) {
    expect(error).toBeInstanceOf(CodingError);
    return (error as Error).message;
  }
  throw new Error(`${input} was accepted`);
};

describe("the output folder rules", () => {
  it("creates a folder that isn't there yet, and returns it as an absolute path", () => {
    const base = tmp("base");
    const wanted = join(base, "new", "project");
    expect(checkOutputFolder(`  ${wanted}  `, rules())).toBe(wanted);
    expect(existsSync(wanted)).toBe(true);
    // The write check leaves nothing behind.
    expect(readdirSync(wanted)).toEqual([]);
    // An existing folder's files are left alone.
    writeFileSync(join(wanted, "keep.txt"), "mine");
    expect(checkOutputFolder(wanted, rules())).toBe(wanted);
    expect(readFileSync(join(wanted, "keep.txt"), "utf8")).toBe("mine");
  });

  it("refuses a relative path, an empty one, and a drive root", () => {
    expect(refused("projects/app")).toContain("must be a full path");
    expect(refused("   ")).toContain("Choose an output folder");
    expect(refused(parse(tmpdir()).root)).toContain("drive root");
  });

  it("refuses the home folder, and a folder that holds it", () => {
    const home = tmp("home");
    expect(refused(home, { home })).toContain("your home folder itself");
    expect(refused(tmpdir(), { home })).toContain("holds your home folder");
    // Inside it is fine.
    expect(checkOutputFolder(join(home, "Projects", "app"), rules({ home }))).toBe(
      join(home, "Projects", "app"),
    );
    // The real home folder, with the real default.
    expect(() => checkOutputFolder(homedir(), { dataDir: tmp("data"), taken: [] })).toThrow(
      "your home folder itself",
    );
  });

  it("refuses the app's data folder, anything inside it, and anything around it", () => {
    const dataDir = tmp("data");
    expect(refused(dataDir, { dataDir })).toContain("data folder");
    expect(refused(join(dataDir, "workspaces", "bot_1"), { dataDir })).toContain("data folder");
    expect(refused(tmpdir(), { dataDir, home: join(tmpdir(), "..", "nowhere") })).toContain("data folder");
    // The wrong case on a system that ignores it is the same folder.
    if (process.platform === "win32")
      expect(refused(dataDir.toUpperCase(), { dataDir })).toContain("data folder");
  });

  it("refuses a folder that overlaps another Coding Bot's, in either direction", () => {
    const base = tmp("base");
    const theirs = join(base, "theirs");
    mkdirSync(join(theirs, "sub"), { recursive: true });
    expect(refused(theirs, { taken: [theirs] })).toContain("already writes to");
    expect(refused(join(theirs, "sub"), { taken: [theirs] })).toContain("already writes to");
    expect(refused(base, { taken: [theirs] })).toContain("already writes to");
  });

  it("refuses a folder that is really a file, or can't be made", () => {
    const base = tmp("base");
    const file = join(base, "a-file");
    writeFileSync(file, "x");
    expect(refused(file)).toContain("Couldn't use");
    expect(refused(join(file, "inside"))).toContain("Couldn't use");
  });

  it("refuses network shares and device paths before touching the disk", () => {
    const base = tmp("base");
    const drive = base.slice(0, 2);
    const rest = base.slice(3);
    for (const input of [
      `\\\\localhost\\${drive[0]}$\\${rest}\\app`,
      `\\\\?\\UNC\\localhost\\${drive[0]}$\\${rest}\\app`,
      `\\\\?\\${base}\\device-app`,
      `\\\\.\\${base}\\device-app`,
      "//server/share/app",
      "\\\\server\\share",
    ])
      expect(refused(input), input).toContain("this computer's own drives");
    // Not even created: the refusal comes before any folder is made.
    expect(existsSync(join(base, "device-app"))).toBe(false);
    expect(readdirSync(base)).toEqual([]);
  });

  it("refuses a name ending in a dot or a space, which Windows reads as another folder", () => {
    const home = tmp("home");
    const base = tmp("base");
    // The home folder with a dot after it is the home folder to PowerShell, and a new folder to Node.
    expect(refused(`${home}.`, { home })).toContain("ends in a dot or a space");
    expect(refused(join(`${home}.`, "Projects"), { home })).toContain("ends in a dot or a space");
    expect(refused(join(base, "app ", "inner"))).toContain("ends in a dot or a space");
    expect(refused(join(base, "app. ", "x"))).toContain("ends in a dot or a space");
    expect(refused(join(base, "...", "x"))).toContain("ends in a dot or a space");
    expect(readdirSync(base)).toEqual([]);
    // A dot inside a name, and a ".." step that resolves away, are fine.
    expect(checkOutputFolder(join(base, "my.app"), rules())).toBe(join(base, "my.app"));
    expect(checkOutputFolder(`${base}${sep}other${sep}..${sep}v2.0`, rules())).toBe(join(base, "v2.0"));
  });

  it("refuses the names Windows keeps for devices, in any case and with any extension", () => {
    const base = tmp("base");
    for (const name of ["CON", "nul", "Aux.project", "com1", "LPT9.txt", "prn "])
      expect(refused(join(base, name, "app")), name).toMatch(/keeps for a device|ends in a dot or a space/);
    expect(refused(join(base, "nul.txt"))).toContain("keeps for a device");
    expect(readdirSync(base)).toEqual([]);
    expect(checkOutputFolder(join(base, "console"), rules())).toBe(join(base, "console"));
  });

  it.runIf(process.platform === "win32")("refuses characters a Windows folder name can't have", () => {
    const base = tmp("base");
    for (const name of ["a:b", "what?", "a|b", 'say"hi"', "a*"])
      expect(refused(join(base, name)), name).toContain("characters a folder name can't have");
  });

  it("follows a link: a folder that leads into the data folder is the data folder", () => {
    const dataDir = tmp("data");
    const link = join(tmp("base"), "innocent");
    symlinkSync(dataDir, link, "junction");
    expect(refused(link, { dataDir })).toContain("data folder");
  });
});

describe("the team's working folder", () => {
  const ONE = { nodes: [{ path: "src/a.txt", purpose: "a note" }], edges: [] };

  it("is the output folder for the three roles, and nothing else changes", async () => {
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: codingTeam().handlers });
    const out = tmp("out");
    const { bot, project } = await makeCoding(h, out);
    const { agent } = h.services;
    for (const role of ["planner", "developer", "qa"] as const) {
      expect(agent.workspaceFor(project.roles[role].botId)).toBe(out);
      const route = await h.app.inject({
        url: `/api/bots/${project.roles[role].botId}/workspace`,
        headers: auth,
      });
      expect(route.json().path).toBe(out);
    }
    // The Coding Bot and every other bot keep their own private folder.
    const plain = (await post(h, "/api/bots", { name: "Plain" })).json().bot;
    for (const id of [bot.id, plain.id])
      expect(agent.workspaceFor(id)).toBe(join(h.services.config.dataDir, "workspaces", id));
  });

  it("writes inside it without a card, relative paths land in the project, and commands still ask", async () => {
    const team = codingTeam({ plans: [{ tool: ONE }], review: () => ({ pass: true, command: "echo hi" }) });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const out = tmp("out");
    const cards: { name: string; kind: string }[] = [];
    h.bus.subscribe((e) => {
      if (e.type !== "message.updated") return;
      for (const part of e.message.parts)
        if (part.type === "tool" && part.status === "pending_approval" && part.approval)
          cards.push({ name: part.name, kind: part.approval.kind });
    });
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Make a note");
    // Only QA's command asks: the Developer's write_file into the folder (a relative path) was free.
    const waiting = await until(h, bot.id, (p) => p.active?.role === "qa");
    expect(waiting.cards[0]!.column).toBe("qa");
    for (let i = 0; i < 200 && cards.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 15));
    expect(cards).toEqual([{ name: "Alpha QA · run_command", kind: "terminal" }]);
    expect(readFileSync(join(out, "src", "a.txt"), "utf8")).toBe("// src/a.txt\n");
    // Deny it: QA goes on to its verdict and nothing else asks.
    const pending = h.store.messages
      .list(bot.threadId)
      .flatMap((m) => m.parts)
      .find((part) => part.type === "tool" && part.status === "pending_approval");
    if (pending?.type !== "tool") throw new Error("no card");
    await post(h, `/api/approvals/${pending.approval!.id}`, { decision: "deny" });
    await until(h, bot.id, (p) => p.status === "done");
    expect(readFileSync(join(out, "src", "a.txt"), "utf8")).toBe("// src/a.txt\n");
    expect(cards).toHaveLength(1);
  });

  it("counts a link out of the folder as outside: the write asks first", async () => {
    const elsewhere = tmp("elsewhere");
    const out = tmp("out");
    symlinkSync(elsewhere, join(out, "link"), "junction");
    const team = codingTeam({
      plans: [{ tool: { nodes: [{ path: "link/x.txt", purpose: "sneaks out" }], edges: [] } }],
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Make a file");
    let card: { id: string; summary: string; badges: string[] } | undefined;
    for (let i = 0; i < 400 && !card; i++) {
      for (const message of h.store.messages.list(bot.threadId))
        for (const part of message.parts)
          if (part.type === "tool" && part.status === "pending_approval" && part.approval)
            card = part.approval;
      if (!card) await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(card).toBeTruthy();
    expect(card!.summary).toContain("Write");
    expect(card!.badges).toContain("Outside the bot's folder");
    expect(existsSync(join(elsewhere, "x.txt"))).toBe(false);
    await post(h, `/api/approvals/${card!.id}`, { decision: "deny" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(join(elsewhere, "x.txt"))).toBe(false);
  });

  it("refuses the home folder, the app's data folder and a bot's workspace when a Coding Bot is made", async () => {
    const dataDir = tmp("data");
    h = await makeHarness({ config: { dataDir }, handlers: codingTeam().handlers });
    for (const [folder, message] of [
      [homedir(), "home folder"],
      [dataDir, "data folder"],
      [join(dataDir, "workspaces", "bot_somebody"), "data folder"],
      [parse(tmpdir()).root, "drive root"],
    ] as const) {
      useSharedModel(h);
      const res = await h.app.inject({
        method: "POST",
        url: "/api/coding-bots",
        headers: auth,
        payload: { name: "Alpha", outputFolder: folder, roles: { planner: {}, developer: {}, qa: {} } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain(message);
    }
    expect(h.store.bots.list().filter((bot) => bot.coding)).toEqual([]);
  });
});

describe("deleting a Coding Bot", () => {
  /** A folder with a project in it, as a finished run leaves it, plus something of the user's. */
  const lived = () => {
    const out = tmp("out");
    mkdirSync(join(out, "deep", "er"), { recursive: true });
    writeFileSync(join(out, "keep.txt"), "mine");
    writeFileSync(join(out, "deep", "er", "x.ts"), "x");
    return out;
  };
  const listing = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? [`${e.name}/`, ...listing(join(dir, e.name)).map((n) => `${e.name}/${n}`)] : [e.name],
    );

  it("takes the team, their threads and the project state, and never touches the output folder", async () => {
    h = await makeHarness({
      config: { dataDir: tmp("data") },
      handlers: codingTeam({ plans: [{ tool: ONE_FILE_DEEP }] }).handlers,
    });
    const out = lived();
    const { bot, project } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const before = listing(out);
    expect(before).toContain("src/");

    const res = await h.app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: auth });
    expect(res.statusCode).toBe(204);
    for (const id of [bot.id, ...Object.values(project.roles).map((seat) => seat.botId)])
      expect(h.store.bots.get(id)).toBeNull();
    expect(h.store.threads.list().filter((t) => t.pair)).toEqual([]);
    expect(h.store.threads.list()).toEqual([]);
    expect(h.store.settings.get(`coding:${bot.id}`)).toBeUndefined();
    expect((await h.app.inject({ url: `/api/bots/${bot.id}/coding`, headers: auth })).statusCode).toBe(404);
    // The folder and every file in it, the user's and the team's, are exactly as they were.
    expect(listing(out)).toEqual(before);
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("mine");
  });

  it("stops the work when it is deleted mid-way, writes no state afterwards, and leaves the folder alone", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const team = codingTeam({ plans: [{ tool: ONE_FILE_DEEP }], develop: () => ({ wait }) });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const out = lived();
    const before = listing(out);
    const { bot, project } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.active?.role === "developer");

    const res = await h.app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: auth });
    expect(res.statusCode).toBe(204);
    release();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.store.settings.get(`coding:${bot.id}`)).toBeUndefined();
    expect(h.store.bots.get(project.roles.developer.botId)).toBeNull();
    expect(listing(out)).toEqual(before);
  });

  it("won't delete one of the team on its own", async () => {
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: codingTeam().handlers });
    const { project } = await makeCoding(h, tmp("out"));
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/bots/${project.roles.qa.botId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(409);
    expect(h.store.bots.get(project.roles.qa.botId)).toBeTruthy();
  });
});

import { afterEach, describe, expect, it } from "vitest";

import type { MessagePart } from "@mrog/shared";
import { BADGES } from "@mrog/tools";

import { quickCommandsAllowed, reachesPast, routineCommand, writesToFile } from "./coding-auto-approve";
import { cleanTmp, codingTeam, makeCoding, post, tmp, type, until } from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

/** A Coding Bot's Auto-approve: the plan, and QA's routine commands. */

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const ONE_FILE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };

const start = async (command: string) => {
  const team = codingTeam({ plans: [{ tool: ONE_FILE }], review: () => ({ pass: true, command }) });
  h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
  h.services.coding.timing.retryBackoffMs = [0, 0];
  return team;
};

/** Every run_command call anywhere, as its part. */
const commandParts = () =>
  h!.store.threads
    .list()
    .flatMap((thread) => h!.store.messages.list(thread.id))
    .flatMap((message) => message.parts)
    .filter(
      (part): part is Extract<MessagePart, { type: "tool" }> =>
        part.type === "tool" && part.name.endsWith("run_command"),
    );

const waitForCard = async (threadId: string) => {
  for (let i = 0; i < 400; i++) {
    for (const message of h!.store.messages.list(threadId))
      for (const part of message.parts)
        if (part.type === "tool" && part.status === "pending_approval" && part.approval) return part.approval;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return undefined;
};

const FOLDER = process.platform === "win32" ? "C:\\work\\site" : "/work/site";
const terminal = (summary: string, badges: string[] = []) => ({
  level: "ask" as const,
  kind: "terminal" as const,
  badges,
  summary,
});

describe("which commands Auto-approve covers", () => {
  it("covers routine commands, never ones that can't be undone or reach past the project", () => {
    expect(routineCommand(terminal("node --check a.js"), undefined, FOLDER)).toBe(true);
    for (const badge of [
      BADGES.irreversible,
      BADGES.security,
      BADGES.secrets,
      BADGES.outside,
      BADGES.network,
    ])
      expect(routineCommand(terminal("x", [badge]), undefined, FOLDER)).toBe(false);
    expect(
      routineCommand({ level: "ask", kind: "general", badges: [], summary: "x" }, undefined, FOLDER),
    ).toBe(false);
  });

  it("judges the whole command, not only its first line", () => {
    expect(routineCommand(terminal("node --check a.js\n(in C:\\out)"), undefined, FOLDER)).toBe(true);
    expect(routineCommand(terminal("x"), "node --check a.js\necho hi > a.txt", FOLDER)).toBe(false);
  });

  it("asks before a command that names a secret file or a path outside the project", () => {
    for (const command of [
      "Get-Content .env",
      "type config\\id_rsa",
      "cat ~/.npmrc",
      "Get-Content ..\\other\\notes.txt",
      process.platform === "win32" ? "Get-Content C:\\Users\\me\\secrets.txt" : "cat /etc/passwd",
    ]) {
      expect(reachesPast(command, FOLDER), command).not.toBeNull();
      expect(routineCommand(terminal(command), command, FOLDER), command).toBe(false);
    }
    for (const command of [
      "node --check movies.js",
      `cd ${FOLDER}; npm install`,
      "Select-String -Path index.html -Pattern viewport",
      "Get-Content .env.example",
      "curl https://api.themoviedb.org/3/movie/popular",
    ])
      expect(reachesPast(command, FOLDER), command).toBeNull();
  });

  it("lets a quick check start an app only with Auto-approve on and commands not set to never", () => {
    expect(quickCommandsAllowed(true, "ask")).toBe(true);
    expect(quickCommandsAllowed(true, "always")).toBe(true);
    expect(quickCommandsAllowed(true, "never")).toBe(false);
    expect(quickCommandsAllowed(false, "always")).toBe(false);
  });
});

describe("a command that writes a file", () => {
  it("is one that sends its output into a file, or makes or copies one", () => {
    for (const command of [
      "echo hi > made.txt",
      "echo 'x' >> log.txt",
      'node -e "1">out.js',
      "Get-Content a.js > copy.js",
      "New-Item notes.txt",
      "Copy-Item a.js b.js",
      "Add-Content log.txt hi",
      "node app.js | Tee-Object out.txt",
    ])
      expect(writesToFile(command), command).toBe(true);
    for (const command of [
      "node --check movies.js",
      "npm install 2>&1",
      "node app.js > $null",
      "python app.py > /dev/null",
      "dir > nul",
      'node -e "[1].map((x) => x)"',
      "Get-ChildItem | Where-Object { $_.Length -gt 0 }",
    ])
      expect(writesToFile(command), command).toBe(false);
  });
});

describe("a Coding Bot with Auto-approve on", () => {
  it("runs QA's routine commands without a card", async () => {
    await start("echo hi");
    const { bot } = await makeCoding(h!, tmp("out"), { autoApprove: true });
    await type(h!, bot, "Make a note");
    await until(h!, bot.id, (p) => p.status === "done");
    const runs = commandParts();
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.status).toBe("done");
    // No approval card was shown in the Coding Bot's chat (a helper's card is copied there as "QA · run_command").
    expect(runs.some((run) => run.name.includes(" · "))).toBe(false);
  });

  it("still asks before a command that can't be undone", async () => {
    await start("Remove-Item a.txt");
    const { bot } = await makeCoding(h!, tmp("out"), { autoApprove: true });
    await type(h!, bot, "Make a note");
    const card = await waitForCard(bot.threadId);
    expect(card).toBeTruthy();
    await post(h!, `/api/approvals/${card!.id}`, { decision: "deny" });
    await until(h!, bot.id, (p) => p.status === "done");
  });

  it("still refuses every command when commands are set to never", async () => {
    await start("echo hi");
    const approvals = h!.services.agent.approvals;
    approvals.savePermissions({ ...approvals.permissions(), localExecution: "never" });
    const { bot } = await makeCoding(h!, tmp("out"), { autoApprove: true });
    await type(h!, bot, "Make a note");
    await until(h!, bot.id, (p) => p.status === "done");
    const runs = commandParts();
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.status).toBe("denied");
  });

  it("asks for each command again with Auto-approve off", async () => {
    await start("echo hi");
    const { bot } = await makeCoding(h!, tmp("out"), { autoApprove: false });
    await type(h!, bot, "Make a note");
    await until(h!, bot.id, (p) => p.status === "awaiting_approval");
    await post(h!, `/api/bots/${bot.id}/coding/approve`);
    // Each of QA's commands (its review and its whole-project check) waits for a yes.
    let answered = 0;
    for (let i = 0; i < 5 && h!.services.coding.get(bot.id)?.status !== "done"; i++) {
      const card = await waitForCard(bot.threadId);
      if (!card) break;
      await post(h!, `/api/approvals/${card.id}`, { decision: "allow_once" });
      answered += 1;
    }
    expect(answered).toBeGreaterThan(0);
    await until(h!, bot.id, (p) => p.status === "done");
  });
});

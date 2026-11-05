import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

function scriptedOllama(replies: unknown[][]) {
  const requests: any[] = [];
  return {
    requests,
    handlers: fakeOllama((body) => {
      requests.push(body);
      return ndjson([...(replies.shift() ?? [{ message: { content: "ok" } }]), { done: true }]);
    }),
  };
}

const toolCall = (name: string, args: Record<string, unknown>) => ({
  message: { tool_calls: [{ function: { name, arguments: args } }] },
});

async function setup(replies: unknown[][] = [], botBody: Record<string, unknown> = {}) {
  dataDir = mkdtempSync(join(tmpdir(), "mrog-toollist-"));
  const ollama = scriptedOllama(replies);
  h = await makeHarness({ config: { dataDir }, handlers: ollama.handlers });
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const created = await h.app.inject({
    method: "POST",
    url: "/api/bots",
    headers: auth,
    payload: { name: "Ada", ...botBody },
  });
  return { bot: created.json().bot as Bot, requests: ollama.requests, status: created.statusCode };
}

const send = (bot: Bot, text: string) =>
  h!.app.inject({
    method: "POST",
    url: `/api/threads/${bot.threadId}/messages`,
    headers: auth,
    payload: { text },
  });

const finished = () =>
  nextEvent<Message>(
    h!.bus,
    (e) => e.type === "message.updated" && e.message.status !== "streaming" && e.message,
    8000,
  );

const offered = (request: any): string[] => (request.tools ?? []).map((tool: any) => tool.function.name);
const system = (request: any): string => request.messages[0].content;

describe("what a bot's tool list changes", () => {
  it("offers every tool to a bot without a list", async () => {
    const { bot, requests } = await setup();
    const done = finished();
    await send(bot, "hi");
    await done;
    expect(offered(requests[0])).toEqual(
      expect.arrayContaining(["run_command", "read_file", "fetch_url", "ask_user"]),
    );
    expect(system(requests[0])).not.toMatch(/turned off for you/);
  });

  it("leaves out an excluded tool, and tells the model so", async () => {
    const { bot, requests } = await setup([], {
      tools: { allow: null, exclude: ["run_command", "fetch_url"] },
    });
    const done = finished();
    await send(bot, "hi");
    await done;
    const names = offered(requests[0]);
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("fetch_url");
    expect(names).toContain("read_file");
    expect(system(requests[0])).toContain("turned off for you and can't be used: run_command, fetch_url");
    // The note comes last, so it has the final word over lines that describe tools.
    expect(system(requests[0]).trimEnd().split("\n\n").at(-1)).toContain("This overrides anything above");
  });

  it("offers no tools at all for an empty allow list, and says so", async () => {
    const { bot, requests } = await setup([], { tools: { allow: [], exclude: [] } });
    const done = finished();
    await send(bot, "hi");
    await done;
    expect(requests[0].tools).toBeUndefined();
    expect(system(requests[0])).toContain("You have no tools in this chat");
  });

  it("offers only the allowed tools, and exclude still wins", async () => {
    const { bot, requests } = await setup([], {
      tools: { allow: ["read_file", "write_file", "browser_*"], exclude: ["write_file"] },
    });
    const done = finished();
    await send(bot, "hi");
    await done;
    const names = offered(requests[0]);
    // Allowed by name or by family, minus what is excluded; nothing else.
    expect(names).toContain("read_file");
    expect(names).toContain("browser_open");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("fetch_url");
    expect(names.every((name) => name === "read_file" || name.startsWith("browser_"))).toBe(true);
    expect(system(requests[0])).toContain("You may use only these tools: read_file, write_file, browser_*");
  });

  it("can't be talked into using a tool that is off: a call by name finds nothing to run", async () => {
    const { bot, requests } = await setup(
      [[toolCall("run_command", { command: "echo hi" })], [{ message: { content: "Can't." } }]],
      { tools: { allow: null, exclude: ["run_command"] } },
    );
    const done = finished();
    await send(bot, "run it");
    const reply = await done;
    const call = reply.parts.find((p) => p.type === "tool");
    // No approval card, no command: it never reached the tool.
    expect(call).toMatchObject({
      name: "run_command",
      status: "error",
      result: expect.stringContaining("no tool named"),
    });
    expect(call).not.toHaveProperty("approval");
    expect(requests[1].messages.at(-1).content).toContain("no tool named");
  });

  it("drops the coordinator's 'you can create sub-agents' guidance when delegation is off", async () => {
    const { bot, requests } = await setup([], { isPrimary: true });
    let done = finished();
    await send(bot, "hi");
    await done;
    expect(system(requests[0])).toContain("you CAN create and run sub-agents");

    await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers: auth,
      payload: { tools: { allow: null, exclude: ["delegate"] } },
    });
    done = finished();
    await send(bot, "hello again");
    await done;
    const second = requests.at(-1);
    expect(system(second)).not.toContain("you CAN create and run sub-agents");
    expect(system(second)).not.toContain("Never say you can't create sub-agents");
    expect(offered(second)).not.toContain("delegate");
  });

  it("stops describing the browser to a bot that has no browser", async () => {
    const { bot, requests } = await setup([]);
    expect(h!.services.browser.settings().enabled).toBe(true); // on by default: its guidance is in the prompt
    let done = finished();
    await send(bot, "hi");
    await done;
    const withBrowser = system(requests[0]);
    expect(withBrowser).toContain("Using the web: work like a person would.");

    await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers: auth,
      payload: { tools: { allow: null, exclude: ["browser_open"] } },
    });
    done = finished();
    await send(bot, "again");
    await done;
    const without = system(requests.at(-1));
    // The guidance for using the browser is gone; the one place left that names it is the note saying it is off.
    expect(without).not.toContain("Using the web: work like a person would.");
    expect(without).toContain("turned off for you and can't be used: browser_open");
    expect(without.match(/browser_open/g)).toHaveLength(1);
  });
});

describe("a helper is never wider than its coordinator", () => {
  it("doesn't get a tool its coordinator has switched off, is told so, and the panel says why", async () => {
    const { bot: coordinator, requests } = await setup([], {
      isPrimary: true,
      tools: { allow: null, exclude: ["run_command"] },
    });
    // What spawn_bot does: a temporary helper with no tool list of its own.
    const helper = h!.store.bots.create(
      { name: "Helper", instructions: "Run things" },
      { parentId: coordinator.id, temporary: true, section: "Helpers" },
    );
    expect(helper.tools).toEqual({ allow: null, exclude: [], apps: {} });

    const done = finished();
    await send(helper, "run echo hi");
    await done;
    const names = offered(requests.at(-1));
    expect(names).not.toContain("run_command");
    expect(names).toContain("read_file");
    expect(system(requests.at(-1))).toContain("The bot that made you has limits that apply to you too");

    const res = await h!.app.inject({ method: "GET", url: `/api/bots/${helper.id}/tools`, headers: auth });
    const row = (res.json().tools as any[]).find((tool) => tool.name === "run_command");
    expect(row).toMatchObject({ enabled: false, editable: false, heldBy: expect.stringContaining("Ada") });
  });

  it("follows the coordinator's list as it changes, not a copy made when the helper was created", async () => {
    const { bot: coordinator } = await setup([], { isPrimary: true });
    const helper = h!.store.bots.create(
      { name: "Helper" },
      { parentId: coordinator.id, temporary: true, section: "Helpers" },
    );
    expect(h!.services.agent.allows(helper, "run_command")).toBe(true);
    h!.store.bots.update(coordinator.id, { tools: { allow: null, exclude: ["run_command"], apps: {} } });
    expect(h!.services.agent.allows(helper, "run_command")).toBe(false);
    // A bot the user made, delegated to as a teammate, keeps its own list: that is by design.
    const teammate = h!.store.bots.create({ name: "Teammate" });
    expect(h!.services.agent.allows(teammate, "run_command")).toBe(true);
  });
});

describe("the tool list API", () => {
  it("saves a list and rejects a malformed one", async () => {
    const { bot } = await setup();
    const patch = (tools: unknown) =>
      h!.app.inject({ method: "PATCH", url: `/api/bots/${bot.id}`, headers: auth, payload: { tools } });

    const ok = await patch({ allow: null, exclude: ["run_command"] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().bot.tools).toEqual({ allow: null, exclude: ["run_command"], apps: {} });
    expect(
      (await h!.app.inject({ method: "GET", url: `/api/bots/${bot.id}`, headers: auth })).statusCode,
    ).toBeLessThan(500);
    expect(h!.store.bots.get(bot.id)!.tools.exclude).toEqual(["run_command"]);

    for (const bad of [{ exclude: ["not a name"] }, { exclude: "run_command" }, { allow: [1] }, "none"]) {
      expect((await patch(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(h!.store.bots.get(bot.id)!.tools.exclude).toEqual(["run_command"]);
  });

  it("lists a bot's tools with their group and state, and keeps off a tool that isn't available now", async () => {
    const { bot } = await setup([], {
      tools: { allow: null, exclude: ["run_command", "computer_run", "gmail__*"] },
    });
    const res = await h!.app.inject({ method: "GET", url: `/api/bots/${bot.id}/tools`, headers: auth });
    expect(res.statusCode).toBe(200);
    const tools = res.json().tools as {
      name: string;
      group: string;
      enabled: boolean;
      available: boolean;
      editable: boolean;
    }[];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get("read_file")).toMatchObject({
      group: "files",
      enabled: true,
      available: true,
      editable: true,
    });
    expect(byName.get("run_command")).toMatchObject({
      group: "commands",
      enabled: false,
      available: true,
      editable: true,
    });
    // The computer isn't running, so the tool isn't offered, but it stays in the list so it can be switched back on.
    expect(byName.get("computer_run")).toMatchObject({
      group: "computer",
      enabled: false,
      available: false,
      editable: true,
    });
    // A pattern isn't a tool: it holds its family off without a row of its own.
    expect(byName.has("gmail__*")).toBe(false);
  });

  it("marks tools held off by a pattern or an allow list as not editable from the panel", async () => {
    const { bot } = await setup([], { tools: { allow: ["read_file", "browser_*"], exclude: [] } });
    const res = await h!.app.inject({ method: "GET", url: `/api/bots/${bot.id}/tools`, headers: auth });
    const byName = new Map((res.json().tools as any[]).map((tool) => [tool.name, tool]));
    expect(byName.get("read_file")).toMatchObject({ enabled: true, editable: true });
    expect(byName.get("run_command")).toMatchObject({ enabled: false, editable: false });
  });

  it("404s for a bot that doesn't exist", async () => {
    await setup();
    const res = await h!.app.inject({
      method: "GET",
      url: `/api/bots/bot_${"0".repeat(32)}/tools`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

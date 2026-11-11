import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BOT_TOOLS,
  DEFAULT_RUNTIME_SETTINGS,
  PARTLY_HIDDEN_BADGE,
  type Bot,
  type ConnectorView,
  type Message,
  type MessagePart,
} from "@mrog/shared";

import { classifyTool, exposedNames } from "./connectors";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.restoreAllMocks();
});

const fixture = fileURLToPath(new URL("./fixtures/echo-mcp.mjs", import.meta.url));

async function addEcho(extra: Record<string, unknown> = {}) {
  const res = await h!.app.inject({
    method: "POST",
    url: "/api/connectors",
    headers: auth,
    payload: {
      name: "Echo App",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { ECHO_SUFFIX: "vault:ECHO_SECRET" },
      },
      ...extra,
    },
  });
  return res;
}

describe("connected apps (MCP)", () => {
  it("connects over stdio, lists tools with toggles, and resolves vault secrets into env", async () => {
    h = await makeHarness();
    h.services.vault.set("ECHO_SECRET", "!");
    const res = await addEcho();
    expect(res.statusCode).toBe(201);
    const connector = res.json().connector as ConnectorView;
    expect(connector).toMatchObject({ id: "echo-app", state: "connected", error: null });
    expect(connector.tools.map((t) => t.name)).toEqual(["echo", "fail"]);

    const off = await h.app.inject({
      method: "PATCH",
      url: "/api/connectors/echo-app",
      headers: auth,
      payload: { disabledTools: ["fail"] },
    });
    expect(off.json().connector.tools).toMatchObject([
      { name: "echo", enabled: true },
      { name: "fail", enabled: false },
    ]);
    // query_result comes with any app's tools, to read results too big to show whole.
    expect(h.services.connectors.toolSpecs().map((spec) => spec.name)).toEqual([
      "echo_app__echo",
      "query_result",
    ]);
  }, 20_000);

  it("lets a bot call an app tool behind an approval card, and runs it", async () => {
    let call = 0;
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        call += 1;
        if (call === 1) {
          expect(body.tools.map((t: any) => t.function.name)).toContain("echo_app__echo");
          return ndjson([
            {
              message: {
                tool_calls: [{ function: { name: "echo_app__echo", arguments: { text: "hi", times: 2 } } }],
              },
            },
            { done: true },
          ]);
        }
        return ndjson([{ message: { content: "Done." } }, { done: true }]);
      }),
    });
    h.services.vault.set("ECHO_SECRET", "?");
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    await addEcho();
    const bot = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
    ).json().bot as Bot;

    const card = nextEvent<string>(h.bus, (e) => {
      if (e.type !== "message.updated") return undefined;
      const part = e.message.parts.find((p: MessagePart) => p.type === "tool");
      return part?.type === "tool" && part.approval?.id;
    });
    const done = nextEvent<Message>(
      h.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && e.message,
      15_000,
    );
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "echo" },
    });
    await h.app.inject({
      method: "POST",
      url: `/api/approvals/${await card}`,
      headers: auth,
      payload: { decision: "allow_once" },
    });
    const reply = await done;
    expect(reply.parts.find((p) => p.type === "tool")).toMatchObject({
      status: "done",
      result: "echo: hihi?",
    });
  }, 20_000);

  it("reports a server that won't start, and removes connectors", async () => {
    h = await makeHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/connectors",
      headers: auth,
      payload: {
        name: "Broken",
        transport: { type: "stdio", command: "definitely-not-a-real-command-xyz", args: [], env: {} },
      },
    });
    expect(res.json().connector).toMatchObject({ state: "error", error: expect.any(String) });
    expect(
      (await h.app.inject({ method: "DELETE", url: "/api/connectors/broken", headers: auth })).statusCode,
    ).toBe(204);
    expect((await h.app.inject({ url: "/api/connectors", headers: auth })).json().connectors).toEqual([]);
  }, 20_000);

  it("closes the server a connect opened when a newer connect, a remove or a switch-off beat it", async () => {
    h = await makeHarness();
    h.services.vault.set("ECHO_SECRET", "!");
    await addEcho();
    const manager = h.services.connectors;
    const config = () => manager.configs().find((c) => c.id === "echo-app")!;
    const opened = vi.spyOn(Client.prototype, "connect");
    const closed = vi.spyOn(Client.prototype, "close");

    // Two overlapping reconnects: one server is kept, the other is closed.
    await Promise.all([manager.connect(config()), manager.connect(config())]);
    expect(manager.view(config())).toMatchObject({ state: "connected", tools: [{ name: "echo" }, {}] });

    const connecting = manager.connect(config());
    await manager.update("echo-app", { enabled: false });
    await connecting;
    expect(manager.view(config())).toMatchObject({ state: "off", tools: [] });

    await manager.update("echo-app", { enabled: true });
    const late = manager.connect(config());
    await manager.remove("echo-app");
    await late;
    expect(manager.configs()).toEqual([]);

    // Every server it started is closed again (plus the one from before the spies).
    expect(opened.mock.calls.length).toBeGreaterThan(2);
    expect(closed).toHaveBeenCalledTimes(opened.mock.calls.length + 1);
  }, 30_000);
});

const rawFixture = fileURLToPath(new URL("./fixtures/raw-mcp.mjs", import.meta.url));

/** The raw fixture, answering tools/list the way RAW_MODE says. */
async function addRaw(mode: "paged" | "collide") {
  const res = await h!.app.inject({
    method: "POST",
    url: "/api/connectors",
    headers: auth,
    payload: {
      name: "Raw App",
      transport: { type: "stdio", command: process.execPath, args: [rawFixture], env: { RAW_MODE: mode } },
      askBeforeUse: true,
    },
  });
  return res.json().connector as ConnectorView;
}

const readOnlyBot = {
  id: "bot_r",
  tools: { ...DEFAULT_BOT_TOOLS, apps: { "raw-app": "read" } },
} as unknown as Bot;

const callContext = { signal: new AbortController().signal, botId: "bot_r", threadId: "thr_r" } as never;

describe("what a tool's name says it does", () => {
  const kind = (name: string) => classifyTool({ name });

  it("counts verbs that change things as changes, not reads", () => {
    expect(kind("resolve_incident")).toBe("write");
    expect(kind("check_out")).toBe("write");
    expect(kind("list_and_trash")).toBe("destructive");
  });

  it("knows more ways to destroy: trash, discard, rm, del, prune, flush, revert, withdraw, refund", () => {
    for (const name of [
      "trash_message",
      "rm_file",
      "discard_draft",
      "deleteitem",
      "del_row",
      "prune_branches",
      "flush_cache",
      "revert_commit",
      "withdraw_offer",
      "refund_order",
    ])
      expect(kind(name), name).toBe("destructive");
  });

  it("still reads what only looks, and does not mistake a word for a longer one", () => {
    for (const name of ["get_file", "list_messages", "search", "get_archived_items", "list_delivery_status"])
      expect(kind(name), name).toBe("read");
  });
});

describe("tools an app lists", () => {
  it("follows the app's pages of tools", async () => {
    h = await makeHarness();
    const connector = await addRaw("paged");
    expect(connector.tools.map((tool) => tool.name)).toEqual([
      "alpha_one",
      "alpha_two",
      "beta_one",
      "gamma_one",
      "gamma_two",
    ]);
  }, 20_000);

  it("gives tools whose cleaned-up names collide different names, and checks each by its own", async () => {
    h = await makeHarness();
    await addRaw("collide");
    const manager = h.services.connectors;
    const specs = manager.toolSpecs().filter((spec) => spec.name !== "query_result");
    expect(specs).toHaveLength(2);
    const [first, second] = specs.map((spec) => spec.name);
    expect(first).not.toBe(second);
    expect(first!.length).toBeLessThanOrEqual(64);
    expect(manager.describe(first!)).toMatchObject({ tool: "list_items", kind: "read" });
    expect(manager.describe(second!)).toMatchObject({ tool: "list.items", kind: "destructive" });
    // A read-only grant lets the read through and blocks the one that changes things.
    expect(manager.gate(readOnlyBot, first!)).toBeNull();
    expect(manager.gate(readOnlyBot, second!)).toContain("read-only access");
    // And the one that runs is the one that was checked.
    expect(await specs[1]!.run({}, callContext)).toBe("ran list.items");
  }, 20_000);

  it("names colliding tools the same way whatever order the app lists them in, within 64 characters", () => {
    const tool = (name: string) => ({ name, inputSchema: {} });
    const forward = exposedNames("app", [tool("list_items"), tool("list.items"), tool("other")]);
    const backward = exposedNames("app", [tool("other"), tool("list.items"), tool("list_items")]);
    expect(Object.fromEntries(backward)).toEqual(Object.fromEntries(forward));
    expect(new Set(forward.values()).size).toBe(3);
    expect(forward.get("other")).toBe("app__other");

    // The same long prefix cut at 64 characters.
    const long = "x".repeat(60);
    const cut = exposedNames("app", [tool(`${long}_a`), tool(`${long}_b`)]);
    expect(new Set(cut.values()).size).toBe(2);
    for (const name of cut.values()) expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe("an app that goes away", () => {
  it("is marked as an error with its tools withdrawn when its server exits", async () => {
    h = await makeHarness();
    await addEcho();
    const manager = h.services.connectors;
    const changes: string[] = [];
    h.bus.subscribe((event) => {
      if (event.type === "data.changed") changes.push(event.keys.join());
    });
    expect(manager.toolSpecs().length).toBeGreaterThan(0);
    const pid = (manager as any).live.get("echo-app").client.transport.pid as number;
    const before = changes.length;
    process.kill(pid);
    await vi.waitFor(() => expect(manager.view(manager.configs()[0]!).state).toBe("error"), {
      timeout: 10_000,
    });
    expect(manager.view(manager.configs()[0]!)).toMatchObject({
      error: expect.stringContaining("Echo App"),
      tools: [],
    });
    expect(manager.toolSpecs()).toEqual([]);
    expect(changes.length).toBeGreaterThan(before);
  }, 30_000);

  it("is not an error when switched off, and a newer connection is not undone by the old one closing", async () => {
    h = await makeHarness();
    await addEcho();
    const manager = h.services.connectors;
    await manager.update("echo-app", { enabled: false });
    expect(manager.view(manager.configs()[0]!)).toMatchObject({ state: "off", error: null });

    await manager.update("echo-app", { enabled: true });
    const old = (manager as any).live.get("echo-app").client as Client;
    // Keep the old connection's close handler from before the reconnect.
    const onclose = old.onclose!;
    await manager.connect(manager.configs()[0]!);
    expect((manager as any).live.get("echo-app").client).not.toBe(old);
    onclose();
    expect(manager.view(manager.configs()[0]!)).toMatchObject({ state: "connected", error: null });
  }, 30_000);

  it("is marked as gone when a call finds its web session ended", async () => {
    h = await makeHarness();
    await addEcho();
    const manager = h.services.connectors;
    const echo = manager.toolSpecs().find((spec) => spec.name === "echo_app__echo")!;
    vi.spyOn(Client.prototype, "callTool").mockRejectedValue(
      Object.assign(new Error("Error POSTing to endpoint"), { code: 404 }),
    );
    await expect(echo.run({ text: "x" }, callContext)).rejects.toThrow("Error POSTing");
    expect(manager.view(manager.configs()[0]!)).toMatchObject({ state: "error", tools: [] });
  }, 20_000);
});

describe("the approval card for an app's tool", () => {
  const riskOf = async (args: Record<string, unknown>) => {
    h = await makeHarness();
    await addEcho();
    const spec = h.services.connectors.toolSpecs().find((candidate) => candidate.name === "echo_app__echo")!;
    return (await spec.risk(args, {} as never)) as { summary: string; badges: string[] };
  };

  it("shows everything the bot sent, including what comes after the first 200 characters", async () => {
    const risk = await riskOf({ text: "x".repeat(300), bcc: "attacker@evil.com" });
    expect(risk.summary).toContain("attacker@evil.com");
    expect(risk.summary).not.toContain("not shown");
    expect(risk.badges).not.toContain(PARTLY_HIDDEN_BADGE);
  }, 20_000);

  it("says how much it left out of a very long call, and marks the card", async () => {
    const risk = await riskOf({ text: "y".repeat(5_000), bcc: "attacker@evil.com" });
    expect(risk.summary).toMatch(/\(\d+ more characters not shown\)\)$/);
    expect(risk.summary).not.toContain("attacker@evil.com");
    expect(risk.summary.length).toBeLessThan(2_200);
    expect(risk.badges).toContain(PARTLY_HIDDEN_BADGE);
  }, 20_000);
});

describe("removing and signing in", () => {
  it("keeps an app added while another one was being removed", async () => {
    h = await makeHarness();
    await addEcho();
    const manager = h.services.connectors;
    const disconnect = manager.disconnect.bind(manager);
    vi.spyOn(manager, "disconnect").mockImplementation(async (id) => {
      await disconnect(id);
      const other = { ...manager.configs()[0]!, id: "other", name: "Other", enabled: false };
      h!.store.settings.set("connectors", [...manager.configs(), other]);
    });
    expect(await manager.remove("echo-app")).toBe(true);
    expect(manager.configs().map((config) => config.id)).toEqual(["other"]);
  }, 20_000);

  it("answers a sign-in return with a repeated parameter instead of failing", async () => {
    h = await makeHarness();
    const res = await h.app.inject({ url: "/oauth/callback?error=a&error=b&code=x&code=y&state=s&state=t" });
    expect(res.statusCode).toBe(400);
  });
});

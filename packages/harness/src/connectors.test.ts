import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RUNTIME_SETTINGS,
  type Bot,
  type ConnectorView,
  type Message,
  type MessagePart,
} from "@mrog/shared";

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

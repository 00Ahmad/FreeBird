import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, setAppAccess, type Bot, type Message } from "@mrog/shared";

import { classifyTool } from "./connectors";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

const fixture = fileURLToPath(new URL("./fixtures/mail-mcp.mjs", import.meta.url));

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("what a connected app's tool does", () => {
  const kind = (name: string, annotations?: Record<string, boolean>) => classifyTool({ name, annotations });

  it("takes the server's word when it fits the name", () => {
    expect(kind("list_messages", { readOnlyHint: true })).toBe("read");
    expect(kind("label_message", { readOnlyHint: false, destructiveHint: false })).toBe("write");
    expect(kind("delete_message", { destructiveHint: true })).toBe("destructive");
  });

  it("never believes a 'read-only' claim the name contradicts", () => {
    expect(kind("delete_file", { readOnlyHint: true })).toBe("destructive");
    expect(kind("send_email", { readOnlyHint: true })).toBe("write");
    expect(kind("purgeTrash", { readOnlyHint: true })).toBe("destructive");
    // Nor a "not destructive" one.
    expect(kind("remove_user", { readOnlyHint: false, destructiveHint: false })).toBe("destructive");
  });

  it("treats a tool that says it changes things as permanent unless it says otherwise, as the protocol does", () => {
    expect(kind("update_doc", { readOnlyHint: false })).toBe("destructive");
  });

  it("goes by the name when there are no annotations: only a plain read is read-only", () => {
    expect(kind("get_profile")).toBe("read");
    expect(kind("searchMessages")).toBe("read");
    expect(kind("send_message")).toBe("write");
    expect(kind("createIssue")).toBe("write");
    expect(kind("delete-file")).toBe("destructive");
    // A read word anywhere but first doesn't make it a read; an unclear name counts as changing things.
    expect(kind("message_list_update")).toBe("write");
    expect(kind("weather")).toBe("write");
    // A word that merely contains a verb is not that verb.
    expect(kind("get_deleted_items")).toBe("read");
  });
});

describe("a bot's access to a connected app", () => {
  async function setup() {
    const requests: any[] = [];
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        requests.push(body);
        return ndjson([{ message: { content: "ok" } }, { done: true }]);
      }),
    });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/connectors",
      headers: auth,
      payload: {
        name: "Mail",
        transport: { type: "stdio", command: process.execPath, args: [fixture], env: {} },
        askBeforeUse: false,
      },
    });
    expect(res.json().connector.state).toBe("connected");
    const bot = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
    ).json().bot as Bot;
    return { bot, requests };
  }
  const offered = (request: any): string[] => (request.tools ?? []).map((tool: any) => tool.function.name);
  const turn = async (bot: Bot) => {
    const done = nextEvent<Message>(
      h!.bus,
      (e) => e.type === "message.updated" && e.message.status !== "streaming" && e.message,
      8000,
    );
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "check my mail" },
    });
    await done;
  };
  const setAccess = (bot: Bot, access: "off" | "read" | "full") =>
    h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers: auth,
      payload: { tools: setAppAccess(h!.store.bots.get(bot.id)!.tools, "mail", access) },
    });

  it("offers every app tool by default, as before", async () => {
    const { bot, requests } = await setup();
    await turn(bot);
    expect(offered(requests.at(-1))).toEqual(
      expect.arrayContaining(["mail__send_message", "mail__delete_message"]),
    );
  }, 20_000);

  it("with read-only access offers only tools that read, and tells the bot", async () => {
    const { bot, requests } = await setup();
    expect((await setAccess(bot, "read")).statusCode).toBe(200);
    await turn(bot);
    const names = offered(requests.at(-1)).filter((name) => name.startsWith("mail__"));
    expect(names.toSorted()).toEqual(
      ["mail__get_profile", "mail__list_messages", "mail__search_messages", "mail__whoami"].toSorted(),
    );
    expect(requests.at(-1).messages[0].content).toContain("You may only look things up in Mail");
  }, 20_000);

  it("with no access offers none of the app's tools", async () => {
    const { bot, requests } = await setup();
    await setAccess(bot, "off");
    await turn(bot);
    expect(offered(requests.at(-1)).some((name) => name.startsWith("mail__"))).toBe(false);
  }, 20_000);

  it("shows each app tool in the Details panel with what it does, and why it is off", async () => {
    const { bot } = await setup();
    await setAccess(bot, "read");
    const tools = (
      await h!.app.inject({ method: "GET", url: `/api/bots/${bot.id}/tools`, headers: auth })
    ).json().tools as any[];
    const row = (name: string) => tools.find((tool) => tool.name === `mail__${name}`);
    expect(row("list_messages")).toMatchObject({
      enabled: true,
      app: { id: "mail", name: "Mail", kind: "read" },
    });
    expect(row("send_message")).toMatchObject({
      enabled: false,
      editable: false,
      heldBy: expect.stringContaining("read-only access to Mail"),
      app: { kind: "write" },
    });
    expect(row("purge_trash")).toMatchObject({ enabled: false, app: { kind: "destructive" } });
  }, 20_000);

  it("always asks before a tool that can't be undone, even in an app set not to ask", async () => {
    const { bot } = await setup();
    const spec = (name: string) =>
      h!.services.connectors.toolSpecs().find((candidate) => candidate.name === `mail__${name}`)!;
    const ctx = {} as never;
    expect(await spec("delete_message").risk({ id: "1" }, ctx)).toMatchObject({
      level: "ask",
      badges: expect.arrayContaining(["This can't be undone"]),
    });
    expect(await spec("purge_trash").risk({}, ctx)).toMatchObject({ level: "ask" });
    // The app is set not to ask, so ordinary changes and reads go ahead.
    expect(await spec("send_message").risk({ to: "x" }, ctx)).toMatchObject({ level: "safe", outward: true });
    expect(await spec("list_messages").risk({}, ctx)).toMatchObject({ level: "safe", outward: false });
    void bot;
  }, 20_000);

  it("never loosens an app the user set to ask: a 'read-only' tool still asks", async () => {
    const { bot } = await setup();
    await h!.app.inject({
      method: "PATCH",
      url: "/api/connectors/mail",
      headers: auth,
      payload: { askBeforeUse: true },
    });
    const list = h!.services.connectors
      .toolSpecs()
      .find((candidate) => candidate.name === "mail__list_messages")!;
    expect(await list.risk({}, {} as never)).toMatchObject({ level: "ask" });
    void bot;
  }, 20_000);

  it("keeps a helper to its coordinator's access, however wide its own", async () => {
    const { bot } = await setup();
    await setAccess(bot, "read");
    const coordinator = h!.store.bots.get(bot.id)!;
    const helper = h!.store.bots.create(
      { name: "Helper" },
      { parentId: coordinator.id, temporary: true, section: "Helpers" },
    );
    expect(h!.services.agent.allows(helper, "mail__list_messages")).toBe(true);
    expect(h!.services.agent.allows(helper, "mail__send_message")).toBe(false);
    expect(h!.services.agent.heldBy(helper, "mail__send_message")).toContain("Ada");
  }, 20_000);

  it("rejects an unknown access level", async () => {
    const { bot } = await setup();
    const res = await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers: auth,
      payload: { tools: { allow: null, exclude: [], apps: { mail: "some" } } },
    });
    expect(res.statusCode).toBe(400);
  }, 20_000);
});

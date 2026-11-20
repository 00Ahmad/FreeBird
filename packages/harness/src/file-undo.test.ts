import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message, type MessagePart } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  dataDir = undefined;
});

type ToolPart = Extract<MessagePart, { type: "tool" }>;

async function start(replies: unknown[][]) {
  const requests: any[] = [];
  dataDir = mkdtempSync(join(tmpdir(), "mrog-undo-"));
  h = await makeHarness({
    config: { dataDir },
    handlers: fakeOllama((body) => {
      requests.push(body);
      return ndjson([...(replies.shift() ?? [{ message: { content: "ok" } }]), { done: true }]);
    }),
  });
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  h.store.settings.set("agent", { maxSteps: 25, selfCheck: false, planning: false });
  const bot = (
    await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
  ).json().bot as Bot;
  return { bot, requests, workspace: h.services.agent.workspaceFor(bot.id) };
}

const say = async (bot: Bot, text: string) => {
  const done = nextEvent<Message>(
    h!.bus,
    (e) =>
      e.type === "message.updated" && e.message.botId === bot.id && e.message.status === "done" && e.message,
  );
  await h!.app.inject({
    method: "POST",
    url: `/api/threads/${bot.threadId}/messages`,
    headers: auth,
    payload: { text },
  });
  return done;
};

const write = (path: string, content: string) => [
  { message: { tool_calls: [{ function: { name: "write_file", arguments: { path, content } } }] } },
];

describe("undoing a bot's file change from the chat", () => {
  it("puts the file back, marks the card, and tells the bot in its next turn", async () => {
    const { bot, requests, workspace } = await start([
      write("notes.txt", "rewritten by the bot"),
      [{ message: { content: "Saved." } }],
      [{ message: { content: "OK." } }],
    ]);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "notes.txt"), "my own notes");

    const reply = await say(bot, "tidy notes.txt");
    const card = reply.parts.find((p): p is ToolPart => p.type === "tool")!;
    expect(card.undo?.id).toMatch(/^fv_/);
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("rewritten by the bot");

    const undone = await h!.app.inject({
      method: "POST",
      url: `/api/file-versions/${card.undo!.id}/undo`,
      headers: auth,
      payload: {},
    });
    expect(undone.statusCode).toBe(200);
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("my own notes");
    const saved = h!.store.messages.get(reply.id)!.parts.find((p): p is ToolPart => p.type === "tool")!;
    expect(saved.undo).toEqual({ id: card.undo!.id, undone: true });

    // A second undo is refused; the bot hears about the undo in its next turn.
    const again = await h!.app.inject({
      method: "POST",
      url: `/api/file-versions/${card.undo!.id}/undo`,
      headers: auth,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    await say(bot, "what's in notes.txt now?");
    const replayed = requests.at(-1).messages.find((m: any) => m.role === "tool");
    expect(replayed.content).toContain("The user undid this change afterwards");
  });

  it("removes a file the bot created, and refuses a path-like id", async () => {
    const { bot, workspace } = await start([write("new.txt", "hello"), [{ message: { content: "Done." } }]]);
    const reply = await say(bot, "make new.txt");
    const card = reply.parts.find((p): p is ToolPart => p.type === "tool")!;
    expect(existsSync(join(workspace, "new.txt"))).toBe(true);
    // While its reply is still being written, the reply's next save would overwrite the mark: refused for now.
    h!.services.turns.partHooks.set(reply.id, { parts: [], publish: () => {} });
    const busy = await h!.app.inject({
      method: "POST",
      url: `/api/file-versions/${card.undo!.id}/undo`,
      headers: auth,
      payload: {},
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().message).toMatch(/Wait for the reply to finish/);
    expect(existsSync(join(workspace, "new.txt"))).toBe(true);
    h!.services.turns.partHooks.delete(reply.id);
    await h!.app.inject({
      method: "POST",
      url: `/api/file-versions/${card.undo!.id}/undo`,
      headers: auth,
      payload: {},
    });
    expect(existsSync(join(workspace, "new.txt"))).toBe(false);
    const bad = await h!.app.inject({
      method: "POST",
      url: "/api/file-versions/..%2F..%2Fx/undo",
      headers: auth,
      payload: {},
    });
    expect(bad.statusCode).toBe(404);
  });
});

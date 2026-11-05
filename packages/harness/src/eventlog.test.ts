import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message } from "@mrog/shared";

import { EventBus } from "./bus";
import { EventLog, redact, serialize } from "./eventlog";
import { auth, makeHarness, nextEvent, type TestHarness } from "./testing";

const TOKEN = "f".repeat(64);
const T1 = `thr_${"1".repeat(32)}`;
const T2 = `thr_${"2".repeat(32)}`;

let dir: string;
let logDir: string;
let h: TestHarness | undefined;
const logs: EventLog[] = [];
afterEach(async () => {
  await Promise.all(logs.splice(0).map((log) => log.close()));
  await h?.close();
  h = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function open(options: Partial<ConstructorParameters<typeof EventLog>[1]> = {}, bus = new EventBus()) {
  dir = mkdtempSync(join(tmpdir(), "mrog-eventlog-"));
  logDir = join(dir, "logs");
  const log = new EventLog(bus, { dir: logDir, token: TOKEN, ...options });
  logs.push(log);
  log.start();
  return { bus, log };
}

const message = (threadId: string, text: string, over: object = {}) =>
  ({
    id: `msg_${"a".repeat(32)}`,
    threadId,
    role: "bot",
    botId: null,
    moderator: false,
    parts: [{ type: "text", text }],
    status: "done",
    model: null,
    usage: null,
    replyToId: null,
    reactions: [],
    createdAt: new Date().toISOString(),
    ...over,
  }) as never;

const lines = (file: string) =>
  readFileSync(join(logDir, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);

describe("what goes in the log", () => {
  it("keeps durable events, one file per chat, and leaves out streaming noise", async () => {
    const { bus, log } = open();
    bus.publish({ type: "message.created", message: message(T1, "hello") });
    bus.publish({ type: "message.updated", message: message(T2, "other chat") });
    bus.publish({
      type: "message.delta",
      threadId: T1 as never,
      messageId: "m" as never,
      partIndex: 0,
      kind: "text",
      text: "he",
    });
    bus.publish({ type: "thread.activity", threadId: T1 as never, botId: null, activity: "working" });
    bus.publish({ type: "heartbeat" });
    bus.publish({ type: "data.changed", keys: ["models"] });
    await log.flush();

    expect(readdirSync(logDir).toSorted()).toEqual(
      [`${T1}.ndjson`, `${T2}.ndjson`, "_app.ndjson"].toSorted(),
    );
    expect(lines(`${T1}.ndjson`).map((e) => e.type)).toEqual(["message.created"]);
    expect(lines(`${T2}.ndjson`).map((e) => e.type)).toEqual(["message.updated"]);
    expect(lines("_app.ndjson").map((e) => e.type)).toEqual(["data.changed"]);
    expect(lines(`${T1}.ndjson`)[0]).toMatchObject({
      id: expect.stringMatching(/^evt_/),
      at: expect.any(String),
    });
  });

  it("never lets a chat id choose where a file goes", async () => {
    const { bus, log } = open();
    bus.publish({ type: "data.changed", keys: ["x"], threadId: "../../outside" as never });
    bus.publish({ type: "message.created", message: message("..\\..\\outside", "x") });
    await log.flush();
    expect(readdirSync(logDir)).toEqual(["_app.ndjson"]);
    expect(existsSync(join(dir, "outside.ndjson"))).toBe(false);
  });

  it("redacts keys and tokens, and always writes lines that are still valid JSON", async () => {
    const { bus, log } = open();
    // Made-up keys in the real formats, put together here so the source never holds one: secret scanners (GitHub's
    // push protection, say) would otherwise take them for leaked keys.
    const secrets = [
      ["sk", "ant", "api03", "A".repeat(28)].join("-"),
      `${"ghp"}_${"A".repeat(36)}`,
      `${"AKIA"}${"ABCDEFGHIJKLMNOP"}`,
      "hunter2-very-secret",
      ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghijklmnop"].join("."),
    ];
    const keyBlock = (edge: string) => `-----${edge} RSA ${"PRIVATE"} KEY-----`;
    bus.publish({
      type: "message.updated",
      message: message(T1, "", {
        parts: [
          { type: "text", text: `my key is ${secrets[0]} and ${secrets[1]} and ${secrets[2]}` },
          { type: "text", text: `Authorization: Bearer ${"Z".repeat(30)} and ${secrets[4]}` },
          { type: "text", text: `harness token ${TOKEN}` },
          // A tool call whose arguments carry a password, as the model wrote it.
          {
            type: "tool",
            callId: "c",
            name: "http",
            args: { password: secrets[3], note: "hi" },
            status: "done",
            result: `{"api_key":"abc12345"}`,
          },
          { type: "text", text: `${keyBlock("BEGIN")}\nMIIEow\n${keyBlock("END")}` },
        ],
      }),
    });
    await log.flush();
    const raw = readFileSync(join(logDir, `${T1}.ndjson`), "utf8");
    for (const secret of [...secrets, TOKEN, "Z".repeat(30), "abc12345", "MIIEow"])
      expect(raw).not.toContain(secret);
    // Valid JSON, and the ordinary text around the secrets is still there.
    const [event] = lines(`${T1}.ndjson`);
    expect(event!.message.parts[0].text).toContain("my key is [redacted]");
    expect(event!.message.parts[3].args).toMatchObject({ password: "[redacted]", note: "hi" });
  });

  it("leaves out pictures and other bulky data, and cuts very long text", () => {
    const base64 = "A".repeat(200_000);
    const event = {
      id: `evt_${"0".repeat(32)}`,
      at: new Date().toISOString(),
      type: "message.updated",
      message: message(T1, "x".repeat(80_000), {
        parts: [
          { type: "image", mediaType: "image/png", data: base64 },
          { type: "text", text: "x".repeat(80_000) },
        ],
      }),
    } as never;
    const line = serialize(event, TOKEN);
    expect(line.length).toBeLessThan(60_000);
    expect(line).not.toContain(base64.slice(0, 600));
    expect(line).toContain("200000 characters left out");
    expect(line).toContain("30000 more characters left out");
  });

  it("redacts a token only when it is long enough to be one", () => {
    expect(redact("abc token abc", "abc")).toBe("abc token abc");
    expect(redact(`x ${TOKEN} y`, TOKEN)).toBe("x [redacted] y");
  });
});

describe("keeping the log in check", () => {
  it("rotates a file that reaches the size limit, keeping one older half", async () => {
    const { bus, log } = open({ maxFileBytes: 4_000 });
    for (let i = 0; i < 40; i++)
      bus.publish({ type: "message.created", message: message(T1, `line number ${i} ${"y".repeat(150)}`) });
    await log.flush();
    const names = readdirSync(logDir).toSorted();
    expect(names).toEqual([`${T1}.ndjson`, `${T1}.ndjson.1`]);
    for (const name of names) expect(readFileSync(join(logDir, name)).length).toBeLessThanOrEqual(4_000);
    // The newest event is in the live file.
    expect(lines(`${T1}.ndjson`).at(-1)!.message.parts[0].text).toContain("line number 39");
  });

  it("drops events instead of holding the app up when the writer falls behind, and says so", async () => {
    const { bus, log } = open({ maxQueueLines: 5 });
    const started = Date.now();
    for (let i = 0; i < 500; i++) bus.publish({ type: "message.created", message: message(T1, `n${i}`) });
    // Publishing is synchronous and must not wait for the disk.
    expect(Date.now() - started).toBeLessThan(500);
    await log.flush();
    const kept = lines(`${T1}.ndjson`);
    expect(kept.length).toBeLessThan(500);
    const note = lines("_app.ndjson").find((e) => e.type === "log.dropped");
    expect(note?.count).toBe(500 - kept.length);
  });

  it("stops a failing disk from becoming the app's problem", async () => {
    const { bus, log } = open();
    await log.flush(); // the folder is made in the background at start
    // A file where the log folder should be: every write fails.
    rmSync(logDir, { recursive: true, force: true });
    writeFileSync(logDir, "not a folder");
    expect(() => bus.publish({ type: "message.created", message: message(T1, "hi") })).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
  });
});

describe("the log goes when the chat goes", () => {
  it("deletes a chat's log on Clear chat, writes after it normally, and does it in order with queued lines", async () => {
    const { bus, log } = open();
    bus.publish({ type: "message.created", message: message(T1, "before") });
    // Straight away, before the writer has had a turn: lines still waiting must not reach the disk.
    bus.publish({ type: "data.changed", keys: ["messages"], threadId: T1 as never });
    await log.flush();
    expect(existsSync(join(logDir, `${T1}.ndjson`))).toBe(false);

    bus.publish({ type: "message.created", message: message(T1, "after") });
    await log.flush();
    expect(lines(`${T1}.ndjson`).map((e) => e.message.parts[0].text)).toEqual(["after"]);
  });

  it("deletes a deleted chat's log and records nothing more for it", async () => {
    const { bus, log } = open();
    bus.publish({ type: "message.created", message: message(T1, "hello") });
    bus.publish({ type: "message.created", message: message(T2, "keep") });
    await log.flush();
    expect(existsSync(join(logDir, `${T1}.ndjson`))).toBe(true);

    bus.publish({ type: "thread.deleted", threadId: T1 as never });
    // A late event from a turn that was still winding down.
    bus.publish({ type: "message.updated", message: message(T1, "late") });
    await log.flush();
    expect(existsSync(join(logDir, `${T1}.ndjson`))).toBe(false);
    expect(existsSync(join(logDir, `${T2}.ndjson`))).toBe(true);
  });

  it("removes the rotated half too", async () => {
    const { bus, log } = open({ maxFileBytes: 1_500 });
    for (let i = 0; i < 20; i++)
      bus.publish({ type: "message.created", message: message(T1, `n${i} ${"z".repeat(120)}`) });
    await log.flush();
    expect(existsSync(join(logDir, `${T1}.ndjson.1`))).toBe(true);
    bus.publish({ type: "thread.deleted", threadId: T1 as never });
    await log.flush();
    expect(readdirSync(logDir)).toEqual([]);
  });

  it("clears logs of chats that no longer exist when it starts, and keeps the rest", async () => {
    dir = mkdtempSync(join(tmpdir(), "mrog-eventlog-"));
    logDir = join(dir, "logs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(logDir, { recursive: true });
    for (const name of [`${T1}.ndjson`, `${T1}.ndjson.1`, `${T2}.ndjson`, "_app.ndjson", "notes.txt"])
      writeFileSync(join(logDir, name), "{}\n");
    const log = new EventLog(new EventBus(), { dir: logDir, token: TOKEN, threadIds: () => [T2] });
    logs.push(log);
    log.start();
    await log.flush();
    expect(readdirSync(logDir).toSorted()).toEqual([`${T2}.ndjson`, "_app.ndjson", "notes.txt"].toSorted());
  });
});

describe("in a real conversation", () => {
  it("records a turn's messages for its chat, without the streamed text", async () => {
    dir = mkdtempSync(join(tmpdir(), "mrog-eventlog-"));
    h = await makeHarness({ config: { dataDir: dir } });
    logDir = join(dir, "logs");
    const log = new EventLog(h.bus, { dir: logDir, token: TOKEN });
    logs.push(log);
    log.start();
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const bot = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
    ).json().bot as Bot;
    const done = nextEvent<Message>(
      h.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && e.message,
      8000,
    );
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "hi there" },
    });
    await done;
    await log.flush();

    const events = lines(`${bot.threadId}.ndjson`);
    const types = new Set(events.map((e) => e.type));
    expect(types).toContain("message.created");
    expect(types).toContain("message.updated");
    expect(types).not.toContain("message.delta");
    expect(types).not.toContain("thread.activity");
    expect(events.some((e) => e.message?.parts?.some((p: any) => p.text === "Hi!"))).toBe(true);

    // Clear chat removes it.
    await h.app.inject({ method: "DELETE", url: `/api/threads/${bot.threadId}/messages`, headers: auth });
    await log.flush();
    expect(existsSync(join(logDir, `${bot.threadId}.ndjson`))).toBe(false);
  });
});

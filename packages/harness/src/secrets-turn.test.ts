import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message, type MessagePart } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
let dataDir = "";
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// The command starts a real process, which can be slow while the machine is busy.
const SLOW = 15_000;

const call = (name: string, args: Record<string, unknown>) => ({
  message: { tool_calls: [{ function: { name, arguments: args } }] },
});

describe("secrets granted in the middle of a turn", () => {
  it("reach a command the same turn runs next", async () => {
    // Prints how long the variable is (or "none"), so the test sees whether it arrived without printing it.
    const probe = `node -e "console.log(process.env.API_TOKEN ? process.env.API_TOKEN.length : 'none')"`;
    const replies = [
      [call("request_secret", { name: "API_TOKEN", reason: "To call the API" })],
      [call("run_command", { command: probe, secrets: ["API_TOKEN"] })],
      [{ message: { content: "Done." } }],
    ];
    dataDir = mkdtempSync(join(tmpdir(), "mrog-secrets-"));
    h = await makeHarness({
      config: { dataDir },
      handlers: fakeOllama(() =>
        ndjson([...(replies.shift() ?? [{ message: { content: "ok" } }]), { done: true }]),
      ),
    });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const bot = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
    ).json().bot as Bot;

    const secretCard = nextEvent<Extract<MessagePart, { type: "secret" }>>(
      h.bus,
      (e) => {
        if (e.type !== "message.updated") return undefined;
        const part = e.message.parts.find((p: MessagePart) => p.type === "secret");
        return part?.type === "secret" && !part.saved && part;
      },
      SLOW,
    );
    const commandCard = nextEvent<string>(
      h.bus,
      (e) => {
        if (e.type !== "message.updated") return undefined;
        const part = e.message.parts.find(
          (p: MessagePart) => p.type === "tool" && p.status === "pending_approval",
        );
        return part?.type === "tool" ? part.approval?.id : undefined;
      },
      SLOW,
    );
    const done = nextEvent<Message>(
      h.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && e.message,
      SLOW,
    );
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "call the api" },
    });

    const card = await secretCard;
    await h.app.inject({
      method: "POST",
      url: `/api/secret-requests/${card.requestId}`,
      headers: auth,
      payload: { name: "API_TOKEN", value: "tok-0123456789" },
    });
    // Running a command with secrets always asks first.
    await h.app.inject({
      method: "POST",
      url: `/api/approvals/${await commandCard}`,
      headers: auth,
      payload: { decision: "allow_once" },
    });
    const reply = await done;

    const run = reply.parts.find((p) => p.type === "tool" && p.name === "run_command");
    expect(run).toMatchObject({ status: "done" });
    // Not "You haven't been given API_TOKEN": the value (14 characters) arrived, and was not shown.
    expect(run?.type === "tool" ? run.result : "").toMatch(/^14/);
    expect(JSON.stringify(reply)).not.toContain("tok-0123456789");
  });
});

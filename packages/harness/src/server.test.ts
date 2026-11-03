import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { HarnessEvent, type Bot } from "@mrog/shared";

import type { EventBus, HarnessConfig } from "./index";
import { auth, makeHarness, type TestHarness } from "./testing";

let harness: TestHarness | undefined;
let app: FastifyInstance;
let bus: EventBus;

async function setup(over: Partial<HarnessConfig> = {}) {
  harness = await makeHarness({ config: over });
  ({ app, bus } = harness);
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("access control", () => {
  it("serves health without a token", async () => {
    await setup();
    const res = await app.inject({ url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: "FreeBird" });
  });

  it("rejects API calls without the right token", async () => {
    await setup();
    expect((await app.inject({ url: "/api/bots" })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/api/bots", headers: { authorization: "Bearer nope" } })).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: "/api/bots", headers: auth })).statusCode).toBe(200);
  });

  it("checks the token on the route that matched, however the path is spelled", async () => {
    await setup();
    for (const url of ["/%61pi/bots", "/api/%62ots", "/%61%70%69/bots?x=1"]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: "/%61pi/bots", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/healthz" })).statusCode).toBe(401);
  });

  it("serves the built UI without a token", async () => {
    const uiDist = mkdtempSync(join(tmpdir(), "mrog-ui-"));
    try {
      mkdirSync(join(uiDist, "assets"));
      writeFileSync(join(uiDist, "index.html"), "<!doctype html><title>FreeBird</title>");
      writeFileSync(join(uiDist, "assets", "app.js"), "console.log(1)");
      await setup({ uiDist });
      const page = await app.inject({ url: "/" });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("FreeBird");
      expect((await app.inject({ url: "/assets/app.js" })).statusCode).toBe(200);
      expect((await app.inject({ url: "/settings" })).body).toContain("FreeBird");
      expect((await app.inject({ url: "/%61pi/bots" })).statusCode).toBe(401);
    } finally {
      await harness?.close();
      harness = undefined;
      rmSync(uiDist, { recursive: true, force: true });
    }
  });

  it("rejects non-loopback Host headers (DNS rebinding)", async () => {
    await setup();
    const res = await app.inject({ url: "/api/health", headers: { host: "evil.example:8790" } });
    expect(res.statusCode).toBe(403);
  });

  it("allows only configured CORS origins", async () => {
    await setup();
    const ok = await app.inject({ url: "/api/health", headers: { origin: "http://127.0.0.1:5173" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    const other = await app.inject({ url: "/api/health", headers: { origin: "https://evil.example" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("bots API", () => {
  it("creates, lists, updates and deletes, publishing events", async () => {
    await setup();
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.type));

    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: auth,
      payload: { name: "Inbox" },
    });
    expect(created.statusCode).toBe(201);
    const bot = created.json().bot as Bot;

    const list = await app.inject({ url: "/api/bots", headers: auth });
    expect(list.json().bots).toHaveLength(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers: auth,
      payload: { pinned: true },
    });
    expect(patched.json().bot.pinned).toBe(true);

    expect(
      (await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: auth })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: auth })).statusCode,
    ).toBe(404);
    expect(seen).toEqual(["bot.created", "thread.created", "bot.updated", "bot.deleted", "thread.deleted"]);
  });

  it("returns validation issues for bad input", async () => {
    await setup();
    const res = await app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request", issues: [{ path: "name" }] });

    const badId = await app.inject({
      method: "PATCH",
      url: "/api/bots/nope",
      headers: auth,
      payload: { pinned: true },
    });
    expect(badId.statusCode).toBe(400);
  });

  it("publishes an update for the demoted primary bot", async () => {
    await setup();
    const first = (
      await app.inject({
        method: "POST",
        url: "/api/bots",
        headers: auth,
        payload: { name: "A", isPrimary: true },
      })
    ).json().bot as Bot;
    const events: HarnessEvent[] = [];
    bus.subscribe((event) => events.push(event));
    await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: auth,
      payload: { name: "B", isPrimary: true },
    });
    const demoted = events.find((e) => e.type === "bot.updated");
    expect(demoted?.type === "bot.updated" && demoted.bot.id === first.id && !demoted.bot.isPrimary).toBe(
      true,
    );
  });
});

describe("secrets API", () => {
  it("stores values but only ever returns names", async () => {
    await setup();
    const put = await app.inject({
      method: "PUT",
      url: "/api/secrets/OPENAI_API_KEY",
      headers: auth,
      payload: { value: "sk-secret" },
    });
    expect(put.statusCode).toBe(204);
    const list = await app.inject({ url: "/api/secrets", headers: auth });
    expect(list.json()).toEqual({ names: ["OPENAI_API_KEY"] });
    expect(list.body).not.toContain("sk-secret");

    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/secrets/bad-name",
          headers: auth,
          payload: { value: "x" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/secrets/OPENAI_API_KEY", headers: auth })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/secrets/OPENAI_API_KEY", headers: auth })).statusCode,
    ).toBe(404);
  });
});

/** Reads SSE frames from a live server until `until` matches or the timeout passes. */
async function readEvents(
  url: string,
  headers: Record<string, string>,
  until: (events: HarnessEvent[]) => boolean,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  const res = await fetch(url, { headers, signal: controller.signal });
  const events: HarnessEvent[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(HarnessEvent.parse(JSON.parse(data.slice(6))));
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { status: res.status, contentType: res.headers.get("content-type"), events };
}

describe("event stream", () => {
  it("says hello, then streams live events and heartbeats", async () => {
    await setup({ heartbeatMs: 50 });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    setTimeout(
      () => void app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Live" } }),
      100,
    );

    const result = await readEvents(
      `${url}/api/events`,
      auth,
      (events) => events.some((e) => e.type === "bot.created") && events.some((e) => e.type === "heartbeat"),
    );
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/event-stream");
    expect(result.events[0]?.type).toBe("stream.hello");
    expect(result.events.map((e) => e.type)).toEqual(expect.arrayContaining(["bot.created", "heartbeat"]));
  });

  it("replays missed events after Last-Event-ID, or asks for a resync", async () => {
    await setup();
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const first = bus.publish({ type: "bot.deleted", botId: "bot_" + "1".repeat(32) });
    bus.publish({ type: "bot.deleted", botId: "bot_" + "2".repeat(32) });

    const replay = await readEvents(`${url}/api/events`, { ...auth, "last-event-id": first.id }, (events) =>
      events.some((e) => e.type === "bot.deleted"),
    );
    const replayed = replay.events.filter((e) => e.type === "bot.deleted");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.type === "bot.deleted" && replayed[0].botId).toBe("bot_" + "2".repeat(32));

    const stale = await readEvents(
      `${url}/api/events`,
      { ...auth, "last-event-id": "evt_" + "f".repeat(32) },
      (events) => events.some((e) => e.type === "stream.resync"),
    );
    expect(stale.events.map((e) => e.type)).toContain("stream.resync");
  });

  it("requires the token", async () => {
    await setup();
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const res = await fetch(`${url}/api/events`);
    expect(res.status).toBe(401);
  });
});

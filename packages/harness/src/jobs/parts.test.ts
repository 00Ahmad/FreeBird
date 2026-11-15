import { describe, expect, it } from "vitest";

import { openStore } from "@mrog/store";
import type { JobProject } from "@mrog/shared";

import { EventBus } from "../bus";
import { asksForScan, countIn } from "./chat";
import { createHandoffs } from "./handoff";
import { apiReader } from "./readers/api";
import { textReader } from "./readers/text";
import type { ReadContext } from "./readers/types";
import { createJobState, settingsKey } from "./state";

const context = { botId: "b", signal: new AbortController().signal, why: "" } as unknown as ReadContext;
const html = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, {
    status: 200,
    headers: { "content-type": "text/html" },
  });

describe("the text reader", () => {
  it("reads a page as text, with its links resolved", async () => {
    const fetchImpl = (async () =>
      html('<h1>Backend Engineer</h1><a href="/jobs/2">Designer</a>')) as unknown as typeof fetch;
    const page = (await textReader(fetchImpl).read("https://93.184.216.34/jobs/1", context))!;
    expect(page.reader).toBe("text");
    expect(page.text).toContain("Backend Engineer");
    expect(page.links).toEqual([{ text: "Designer", url: "https://93.184.216.34/jobs/2" }]);
  });

  it("never reaches this computer or the local network", async () => {
    const fetchImpl = (async () => html("secret")) as unknown as typeof fetch;
    await expect(textReader(fetchImpl).read("http://127.0.0.1/admin", context)).rejects.toThrow(/Refused/);
  });

  it("marks a page built by JavaScript, and a missing one", async () => {
    const shell = `<script>${"x".repeat(5000)}</script><div id="app"></div>`;
    const built = (await textReader((async () => html(shell)) as unknown as typeof fetch).read(
      "https://93.184.216.34/",
      context,
    ))!;
    expect(built.scriptRendered).toBe(true);
    const gone = (await textReader(
      (async () =>
        new Response("Not here", {
          status: 404,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    ).read("https://93.184.216.34/x", context))!;
    expect(gone.status).toBe(404);
    expect(gone.text).not.toMatch(/Note:/);
  });
});

describe("the job-system reader", () => {
  it("asks the public job list and keeps the posting's own address", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return Response.json({
        title: "Backend Engineer",
        company_name: "Acme",
        content: "&lt;p&gt;Hi&lt;/p&gt;",
      });
    }) as unknown as typeof fetch;
    const page = (await apiReader(fetchImpl).read("https://boards.greenhouse.io/acme/jobs/7", context))!;
    expect(asked).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme/jobs/7"]);
    expect(page).toMatchObject({
      url: "https://boards.greenhouse.io/acme/jobs/7",
      reader: "api",
      title: "Backend Engineer",
    });
  });

  it("isn't used for other addresses", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    expect(await apiReader(fetchImpl).read("https://acme.com/careers", context)).toBeNull();
  });
});

describe("asking for a scan in chat", () => {
  it("reads the number of jobs", () => {
    expect(countIn("find 12 jobs")).toBe(12);
    expect(countIn("ten please")).toBe(10);
    expect(countIn("51")).toBeNull();
    expect(countIn("0")).toBeNull();
    expect(countIn("some")).toBeNull();
    expect(asksForScan("Can you search for jobs?")).toBe(true);
    expect(asksForScan("I like Python")).toBe(false);
  });
});

describe("waiting for you", () => {
  it("skips the page after the time limit", async () => {
    const handoffs = createHandoffs(() => 20);
    expect(await handoffs.wait("b", new AbortController().signal)).toBe("timeout");
    expect(handoffs.isWaiting("b")).toBe(false);
  });

  it("ends when the scan is stopped", async () => {
    const handoffs = createHandoffs(() => 60_000);
    const controller = new AbortController();
    const waiting = handoffs.wait("b", controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    expect(handoffs.answer("b", "continue")).toBe(false);
  });
});

describe("the saved state", () => {
  it("comes back ready after the app closed during a scan", () => {
    const store = openStore(":memory:");
    const saved = {
      botId: "bot_1",
      status: "waiting_for_you",
      handoff: { url: "https://x.example/jobs/1", reason: "CAPTCHA", since: new Date().toISOString() },
      active: { role: "checker", url: null, since: new Date().toISOString() },
      askingCount: false,
      scan: {
        number: 1,
        target: 5,
        found: 2,
        pagesRead: 4,
        visualPages: 0,
        searchRounds: 1,
        startedAt: new Date().toISOString(),
        endedAt: null,
        stopReason: null,
      },
      log: [],
    } as unknown as JobProject;
    store.settings.set(settingsKey("bot_1"), saved);
    const project = createJobState({ store, bus: new EventBus() }).load("bot_1")!;
    expect(project).toMatchObject({ status: "ready", handoff: null, active: null });
    expect(project.scan).toMatchObject({ found: 2, stopReason: "The app closed during the scan." });
    store.close();
  });
});

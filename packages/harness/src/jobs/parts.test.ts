import { describe, expect, it } from "vitest";

import { emptyProfile } from "@mrog/jobs";
import { openStore } from "@mrog/store";
import type { JobProject } from "@mrog/shared";

import { EventBus } from "../bus";
import { asksForScan, countIn } from "./chat";
import { scanIntent } from "./scan-words";
import { createHandoffs } from "./handoff";
import { apiReader } from "./readers/api";
import { textReader } from "./readers/text";
import type { ReadContext } from "./readers/types";
import { createJobState, restoreProject, settingsKey } from "./state";

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
    // A bare answer counts when the bot has just asked how many.
    expect(countIn("ten please", { asked: true })).toBe(10);
    expect(countIn("let's do 15", { asked: true })).toBe(15);
    expect(countIn("51")).toBeNull();
    expect(countIn("0")).toBeNull();
    expect(countIn("some")).toBeNull();
    expect(asksForScan("Can you search for jobs?")).toBe(true);
    expect(asksForScan("I like Python")).toBe(false);
  });

  it("doesn't take a salary, a size or a range for the number, nor a profile change for a scan", () => {
    // Before: these started a 40-job, a 50-lead and a 20-lead scan.
    expect(countIn("find jobs paying 40,000")).toBeNull();
    expect(countIn("find jobs paying £40")).toBeNull();
    expect(countIn("find clients with 50 staff", { max: 50 })).toBeNull();
    // A number then a comma is a count; a comma then digits is an amount.
    expect(countIn("10, only tenders", { asked: true, max: 50 })).toBe(10);
    expect(countIn("40,000", { asked: true, max: 50 })).toBeNull();
    expect(countIn("look for companies with 20 to 100 employees", { max: 50 })).toBeNull();
    expect(countIn("make my salary 50k", { asked: true })).toBeNull();
    expect(countIn("find me 5 new leads", { max: 50 })).toBe(5);
    expect(scanIntent("find jobs paying 40,000")).toBe("unsure");
    expect(scanIntent("Change my search to include Canada")).toBe("unsure");
    expect(scanIntent("find clients with 50 staff")).toBe("unsure");
    expect(scanIntent("Can you search for jobs?")).toBe("scan");
    expect(scanIntent("I like Python")).toBe("none");
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
    const seat = (n: number) => ({ botId: `bot_${String(n).repeat(32)}`, model: null });
    const saved = {
      ...savedBase(),
      botId: `bot_${"a".repeat(32)}`,
      roles: { interviewer: seat(1), searcher: seat(2), checker: seat(3), visual: seat(4) },
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
    store.settings.set(settingsKey(saved.botId), saved);
    const project = createJobState({ store, bus: new EventBus() }).load(saved.botId)!;
    expect(project).toMatchObject({ status: "ready", handoff: null, active: null });
    expect(project.scan).toMatchObject({ found: 2, stopReason: "The app closed during the scan." });
    store.close();
  });

  it("fills in fields added since a project was saved, and keeps what it can of one that doesn't parse", () => {
    const now = new Date().toISOString();
    const seat = (n: number) => ({ botId: `bot_${String(n).repeat(32)}`, model: null });
    const roles = { interviewer: seat(1), searcher: seat(2), checker: seat(3), visual: seat(4) };
    // Saved before scans counted weaker matches: `weaker` is missing, and `+= 1` on it gave NaN.
    const old = {
      ...savedBase(),
      roles,
      status: "ready",
      scan: {
        number: 1,
        target: 5,
        found: 2,
        pagesRead: 4,
        visualPages: 0,
        searchRounds: 1,
        startedAt: now,
        endedAt: now,
        stopReason: "done",
      },
    };
    expect(restoreProject(old, now)?.scan?.weaker).toBe(0);

    // A project another version saved, with a field this one can't read: the profile and the board are kept.
    const card = {
      id: "c1",
      url: "https://x.example/1",
      site: "x.example",
      readBy: "text",
      foundAt: now,
      scan: 1,
      column: "applied",
      facts: [],
      summary: "",
      match: [],
      score: 80,
      warnings: [],
      company: [],
      reaction: null,
      reason: null,
    };
    const odd = {
      ...old,
      profile: { ...emptyProfile(), titles: ["Backend Engineer"], workplace: ["remote"] },
      cards: [card, { broken: true }],
      siteNotes: "not a list",
      seen: ["u:x.example/1"],
    };
    const restored = restoreProject(odd, now)!;
    expect(restored.profile.titles).toEqual(["Backend Engineer"]);
    expect(restored.cards.map((c) => c.id)).toEqual(["c1"]);
    expect(restored.seen).toEqual(["u:x.example/1"]);
    expect(restored.status).toBe("ready");
    expect(restoreProject({ botId: "bot_1" }, now)).toBeNull();
  });
});

/** The fields every saved project has, empty. */
function savedBase() {
  const now = new Date().toISOString();
  return {
    botId: `bot_${"a".repeat(32)}`,
    profile: emptyProfile(),
    cards: [],
    seen: [],
    siteNotes: [],
    suggestions: [],
    scan: null,
    lastTarget: 10,
    askingCount: false,
    active: null,
    handoff: null,
    log: [],
    note: null,
    error: null,
    startedAt: now,
  };
}

describe("the Visual helper", async () => {
  const { visualReader } = await import("./readers/visual");
  const { Halt } = await import("./run-role");

  async function setup(vision: boolean, run: (signal: AbortSignal) => Promise<unknown>) {
    const store = openStore(":memory:");
    const state = createJobState({ store, bus: new EventBus() });
    const seat = (n: number) => ({ botId: `bot_${String(n).repeat(32)}`, model: null });
    const project = state.adopt({
      ...savedBase(),
      status: "scanning",
      roles: { interviewer: seat(1), searcher: seat(2), checker: seat(3), visual: seat(4) },
      scan: {
        number: 1,
        target: 5,
        found: 0,
        weaker: 0,
        pagesRead: 0,
        visualPages: 0,
        searchRounds: 0,
        startedAt: new Date().toISOString(),
        endedAt: null,
        stopReason: null,
      },
    } as unknown as JobProject);
    const browser = {
      goto: async () => ({}),
      snapshot: async () => ({
        url: "https://x.example/jobs",
        title: "Jobs",
        text: "Jobs",
        humanCheck: false,
      }),
      links: async () => [],
    } as never;
    const roles = {
      run: (_b: string, _r: string, _t: string, signal: AbortSignal) => run(signal),
      captureOf: () => undefined,
    } as never;
    const models = {
      catalog: { info: async () => ({ capabilities: vision ? ["completion", "vision"] : ["completion"] }) },
      runtime: { settings: { sharedModel: "ollama:blind:1b" } },
    } as never;
    const reader = visualReader(browser, state, roles, models, () => 30);
    const ctx = { botId: project.botId, signal: new AbortController().signal, phase: {} as never, why: "" };
    return { reader, state, project, ctx, store };
  }

  it("is skipped, and said once per scan, when its model can't see pictures", async () => {
    const { reader, state, project, ctx, store } = await setup(false, async () => ({
      text: "Done",
      capture: {},
    }));
    expect(await reader.read("https://x.example/jobs", ctx)).toBeNull();
    expect(await reader.read("https://x.example/jobs/2", ctx)).toBeNull();
    const said = state.need(project.botId).log.filter((l) => l.text.includes("can't see pictures"));
    expect(said).toHaveLength(1);
    expect(state.need(project.botId).scan?.visualPages).toBe(0);
    state.flush();
    store.close();
  });

  it("counts every try, and gives up a page that takes too long", async () => {
    const hang = (signal: AbortSignal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Halt())));
    const { reader, state, project, ctx, store } = await setup(true, hang);
    await expect(reader.read("https://x.example/jobs", ctx)).rejects.toThrow(/took more than/);
    // Before: a try that failed wasn't counted, and one that hung had no limit.
    expect(state.need(project.botId).scan?.visualPages).toBe(1);
    state.flush();
    store.close();
  });
});

describe("saving a project", () => {
  it("saves and publishes at most every so often, and always the last change", async () => {
    const { SAVE_EVERY_MS } = await import("./state");
    const store = openStore(":memory:");
    const bus = new EventBus();
    let published = 0;
    bus.subscribe((e) => void (e.type === "job.updated" && (published += 1)));
    const state = createJobState({ store, bus });
    const seat = (n: number) => ({ botId: `bot_${String(n).repeat(32)}`, model: null });
    const project = state.adopt({
      ...savedBase(),
      status: "ready",
      roles: { interviewer: seat(1), searcher: seat(2), checker: seat(3), visual: seat(4) },
    } as unknown as JobProject);
    published = 0;
    for (let i = 0; i < 20; i++) state.change(project.botId, (p) => state.logLine(p, `line ${i}`));
    // Changes are in memory at once; before, each of the 20 was a save of the whole project.
    expect(state.need(project.botId).log.at(-1)?.text).toBe("line 19");
    expect(published).toBeLessThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, SAVE_EVERY_MS + 50));
    // Right after the project was made: one save, after the wait, for all 20 changes.
    expect(published).toBe(1);
    const saved = store.settings.get<JobProject>(settingsKey(project.botId));
    expect(saved?.log.at(-1)?.text).toBe("line 19");
    state.flush();
    store.close();
  });
});

describe("a Checker's task in its thread", async () => {
  const { checkTask, keptTask, KEPT_PAGE_CHARS } = await import("./roles/checker");
  it("keeps the start of the page and the address once checked, not the whole page", () => {
    const task = checkTask(
      {
        url: "https://x.example/jobs/1",
        title: "Backend Engineer",
        text: `Backend Engineer. ${"x".repeat(5000)}`,
      },
      [],
    );
    const kept = keptTask(task);
    expect(kept).toContain("ADDRESS: https://x.example/jobs/1");
    expect(kept).toContain("the rest of the page was left out once it was checked");
    expect(kept).toContain("--- end of page text ---");
    expect(kept.length).toBeLessThan(task.length - 4000);
    expect(kept.length).toBeGreaterThan(KEPT_PAGE_CHARS);
    // A short page is kept as it was.
    const short = checkTask({ url: "https://x.example/jobs/2", title: "T", text: "Short page." }, []);
    expect(keptTask(short)).toBe(short);
  });
});

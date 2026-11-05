import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserContext } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BROWSER_SETTINGS, type Bot, type BrowserSettings } from "@mrog/shared";

import { BrowserManager, MAX_OPEN_PROFILES, PROFILES_DIR } from "./browser";
import { auth, makeHarness, type TestHarness } from "./testing";

type Handler = (...args: unknown[]) => void;

/** A stand-in for a launched Edge: just enough of a persistent context for profiles and tabs (no real pages). */
function fakeBrowsers() {
  const launched: { dir: string; closed: boolean; context: BrowserContext }[] = [];
  const launch = async (_settings: BrowserSettings, dir: string) => {
    // The real browser makes its profile folder on first start.
    mkdirSync(dir, { recursive: true });
    const handlers = new Map<string, Handler[]>();
    const on = (map: Map<string, Handler[]>) => (event: string, handler: Handler) =>
      void map.set(event, [...(map.get(event) ?? []), handler]);
    const emit = (map: Map<string, Handler[]>, event: string, ...args: unknown[]) =>
      (map.get(event) ?? []).forEach((handler) => handler(...args));
    const pages: { closed: boolean }[] = [];
    const record = { dir, closed: false, context: undefined as unknown as BrowserContext };
    const context = {
      pages: () => pages.filter((page) => !page.closed),
      newPage: async () => {
        const events = new Map<string, Handler[]>();
        const page = {
          closed: false,
          isClosed: () => page.closed,
          url: () => "about:blank",
          title: async () => "",
          setDefaultTimeout: () => {},
          bringToFront: async () => {},
          // In-page scripts (a human check, say) find nothing on the stand-in's blank page.
          evaluate: async () => false,
          on: on(events),
          off: () => {},
          once: on(events),
          context: () => context,
          close: async () => {
            if (page.closed) return;
            page.closed = true;
            emit(events, "close");
          },
        };
        pages.push(page);
        return page;
      },
      on: on(handlers),
      // No DevTools here: the local-network guard is skipped (it's tested with the real browser).
      newCDPSession: async () => {
        throw new Error("no devtools in the stand-in");
      },
      close: async () => {
        if (record.closed) return;
        record.closed = true;
        for (const page of pages) await (page as unknown as { close(): Promise<void> }).close();
        emit(handlers, "close");
      },
    };
    record.context = context as unknown as BrowserContext;
    launched.push(record);
    return record.context;
  };
  return { launched, launch, running: () => launched.filter((browser) => !browser.closed) };
}

let h: TestHarness | undefined;
let dataDir = "";
const MINUTE = 60_000;
/** Moves the clock on (only Date: timers still run, so the harness works as usual). */
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(async () => {
  vi.useRealTimers();
  await h?.close();
  h = undefined;
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function setup(saved?: Partial<BrowserSettings>, { legacy = false } = {}) {
  dataDir = mkdtempSync(join(tmpdir(), "mrog-profiles-"));
  // An install from before per-bot profiles: the shared profile folder is already there.
  if (legacy) mkdirSync(join(dataDir, "browser"));
  const browsers = fakeBrowsers();
  let manager!: BrowserManager;
  h = await makeHarness({
    config: { dataDir },
    // Before the routes are made: everything that reaches the browser (tools, routes, bot deletion) uses this one.
    setup: (services) => {
      manager = new BrowserManager(services, browsers.launch);
      (services as { browser: BrowserManager }).browser = manager;
    },
  });
  if (saved) h.store.settings.set("browser", { ...DEFAULT_BROWSER_SETTINGS, show: false, ...saved });
  return { manager, browsers };
}

const handoff = (manager: BrowserManager, bot: Bot, signal: AbortSignal) => {
  const tool = manager.tools(bot).find((spec) => spec.name === "browser_handoff")!;
  return tool.run(
    { reason: "Sign in" },
    {
      workspace: ".",
      botId: bot.id,
      botName: bot.name,
      threadId: bot.threadId,
      signal,
      // The user hasn't answered yet: the bot waits with its tab.
      ask: () =>
        new Promise<string>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("stopped"))),
        ),
    },
  );
};

describe("browser profiles", () => {
  it("gives each bot its own profile on a new install, and keeps an existing install on the shared one", async () => {
    const fresh = await setup();
    expect(fresh.manager.settings().profiles).toBe("per-bot");
    await h!.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    const old = await setup(undefined, { legacy: true });
    expect(old.manager.settings().profiles).toBe("shared");
    // The user's own choice always wins.
    h!.store.settings.set("browser", { ...DEFAULT_BROWSER_SETTINGS, profiles: "per-bot" });
    expect(old.manager.settings().profiles).toBe("per-bot");
  });

  it("opens each bot's tab in its own profile folder, and a helper's in the profile of the bot that made it", async () => {
    const { manager, browsers } = await setup({ profiles: "per-bot" });
    const ada = h!.store.bots.create({ name: "Ada" });
    const bea = h!.store.bots.create({ name: "Bea" });
    const helper = h!.store.bots.create(
      { name: "Scout" },
      { parentId: ada.id, temporary: true, section: "Helpers" },
    );

    await manager.open(ada.id);
    await manager.open(bea.id);
    await manager.open(helper.id);
    expect(browsers.launched.map((browser) => browser.dir)).toEqual([
      join(dataDir, PROFILES_DIR, ada.id),
      join(dataDir, PROFILES_DIR, bea.id),
    ]);
    const status = await manager.status();
    expect(status.open.toSorted()).toEqual([ada.id, bea.id].toSorted());
    expect(status.tabs.map((tab) => tab.botName).toSorted()).toEqual(["Ada", "Bea", "Scout"]);
    // Nothing is written to the shared profile's folder.
    expect(existsSync(join(dataDir, "browser"))).toBe(false);
  });

  it("uses one profile for every bot when shared", async () => {
    const { manager, browsers } = await setup({ profiles: "shared" });
    for (const name of ["Ada", "Bea", "Cy", "Dee"]) await manager.open(h!.store.bots.create({ name }).id);
    expect(browsers.launched.map((browser) => browser.dir)).toEqual([join(dataDir, "browser")]);
    expect((await manager.status()).tabs).toHaveLength(4);
  });

  it(`runs at most ${MAX_OPEN_PROFILES} bots' browsers, closing the idle one used longest ago`, async () => {
    const { manager, browsers } = await setup({ profiles: "per-bot" });
    const bots = ["Ada", "Bea", "Cy", "Dee"].map((name) => h!.store.bots.create({ name }));
    for (const bot of bots.slice(0, 3)) {
      await manager.open(bot.id);
      later(1000);
    }
    later(3 * MINUTE);
    // Ada's was used again, so Bea's is the one used longest ago.
    await manager.open(bots[0]!.id);
    await manager.open(bots[3]!.id);
    expect(browsers.running().map((browser) => browser.dir)).toEqual(
      [bots[0]!, bots[2]!, bots[3]!].map((bot) => join(dataDir, PROFILES_DIR, bot.id)),
    );
    expect((await manager.status()).tabs.map((tab) => tab.botName).toSorted()).toEqual(["Ada", "Cy", "Dee"]);
    // Bea's tab comes back (in her own profile, with her sign-ins) when she needs it again.
    later(3 * MINUTE);
    await manager.open(bots[1]!.id);
    expect(browsers.running()).toHaveLength(MAX_OPEN_PROFILES);
    expect(browsers.launched.filter((browser) => browser.dir.endsWith(bots[1]!.id))).toHaveLength(2);
  });

  it("never closes a browser that's in use: the next bot is told to wait instead", async () => {
    // With the window shown, a handoff brings the bot's tab to the front, so the user sees it.
    const { manager, browsers } = await setup({ profiles: "per-bot", show: true });
    const bots = ["Ada", "Bea", "Cy", "Dee"].map((name) => h!.store.bots.create({ name }));
    const stop = new AbortController();
    // Three bots each wait for the user in their own tab.
    const waiting = bots.slice(0, 3).map((bot) => handoff(manager, bot, stop.signal).catch(() => "stopped"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(browsers.running()).toHaveLength(3);
    // However long the user takes, a bot waiting for them keeps its browser.
    later(30 * MINUTE);
    await expect(manager.open(bots[3]!.id)).rejects.toThrow("the most that run at once");
    expect(browsers.running()).toHaveLength(3);
    stop.abort();
    await Promise.all(waiting);
    // Stop answers the chat at once; the tab is let go of a moment later.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Once they're done (and a while has passed), there's room again.
    later(3 * MINUTE);
    await manager.open(bots[3]!.id);
    expect(browsers.running().map((browser) => browser.dir)).toContain(
      join(dataDir, PROFILES_DIR, bots[3]!.id),
    );
  });

  it("keeps a bot's browser between its tool calls: a bot that just acted isn't closed for another", async () => {
    const { manager, browsers } = await setup({ profiles: "per-bot" });
    const bots = ["Ada", "Bea", "Cy", "Dee"].map((name) => h!.store.bots.create({ name }));
    // Ada reads a page and goes back to thinking (her model is busy, the browser isn't).
    const read = manager.tools(bots[0]!).find((spec) => spec.name === "browser_back")!;
    await read
      .run(
        {},
        {
          workspace: ".",
          botId: bots[0]!.id,
          botName: "Ada",
          threadId: bots[0]!.threadId,
          signal: new AbortController().signal,
          ask: async () => "",
        },
      )
      .catch(() => {}); // the stand-in has no pages to go back on; the tab is opened all the same
    later(30_000);
    await manager.open(bots[1]!.id);
    await manager.open(bots[2]!.id);
    later(30_000);
    // A fourth bot is told to wait rather than taking Ada's browser mid-task.
    await expect(manager.open(bots[3]!.id)).rejects.toThrow("the most that run at once");
    expect(browsers.running().map((browser) => browser.dir)).toContain(
      join(dataDir, PROFILES_DIR, bots[0]!.id),
    );
  });

  it("gives the bots of one race or cluster one browser between them, deleted with it", async () => {
    const { manager, browsers } = await setup({ profiles: "per-bot" });
    const host = h!.store.bots.create({ name: "Host" });
    const cluster = host.threadId;
    const racers = ["One", "Two", "Three", "Four", "Five"].map((name) =>
      h!.store.bots.create({ name }, undefined, cluster),
    );
    for (const racer of racers) await manager.open(racer.id);
    expect(browsers.launched.map((browser) => browser.dir)).toEqual([join(dataDir, PROFILES_DIR, cluster)]);
    expect((await manager.status()).tabs).toHaveLength(5);
    h!.services.bus.publish({ type: "thread.deleted", threadId: cluster });
    await expect.poll(() => existsSync(join(dataDir, PROFILES_DIR, cluster))).toBe(false);
    expect(browsers.running()).toHaveLength(0);
  });

  it("deletes, at start, profile folders whose bot or cluster is gone", async () => {
    const { manager } = await setup({ profiles: "per-bot" });
    const ada = h!.store.bots.create({ name: "Ada" });
    for (const key of [ada.id, "bot_gone", ada.threadId])
      mkdirSync(join(dataDir, PROFILES_DIR, key), { recursive: true });
    await manager.sweepProfiles();
    expect(existsSync(join(dataDir, PROFILES_DIR, ada.id))).toBe(true);
    expect(existsSync(join(dataDir, PROFILES_DIR, ada.threadId))).toBe(true);
    expect(existsSync(join(dataDir, PROFILES_DIR, "bot_gone"))).toBe(false);
  });

  it("closes everything when switching between shared and per-bot profiles", async () => {
    const { manager, browsers } = await setup({ profiles: "per-bot" });
    await manager.open(h!.store.bots.create({ name: "Ada" }).id);
    await manager.saveSettings({ ...manager.settings(), profiles: "shared" });
    expect(browsers.running()).toHaveLength(0);
    expect((await manager.status()).tabs).toHaveLength(0);
  });

  it("deletes a bot's profile with the bot, but not when one of its helpers goes", async () => {
    const { manager, browsers } = await setup({ profiles: "per-bot" });
    const ada = h!.store.bots.create({ name: "Ada" });
    const helper = h!.store.bots.create(
      { name: "Scout" },
      { parentId: ada.id, temporary: true, section: "Helpers" },
    );
    await manager.open(helper.id);
    const dir = join(dataDir, PROFILES_DIR, ada.id);
    expect(existsSync(dir)).toBe(true);

    await manager.forget(helper.id);
    expect(existsSync(dir)).toBe(true);
    expect(browsers.running()).toHaveLength(1);

    const res = await h!.app.inject({ method: "DELETE", url: `/api/bots/${ada.id}`, headers: auth });
    expect(res.statusCode).toBeLessThan(300);
    await expect.poll(() => existsSync(dir)).toBe(false);
    expect(browsers.running()).toHaveLength(0);
  });

  it("opens a bot's own browser from the app so the user can sign in for it", async () => {
    await setup({ profiles: "per-bot" });
    const ada = h!.store.bots.create({ name: "Ada" });
    const nobody = await h!.app.inject({
      method: "POST",
      url: "/api/browser/open",
      headers: auth,
      payload: {},
    });
    expect(nobody.statusCode).toBe(502);
    expect(nobody.json().message).toContain("Browser panel");
    const open = await h!.app.inject({
      method: "POST",
      url: "/api/browser/open",
      headers: auth,
      payload: { botId: ada.id },
    });
    expect(open.statusCode).toBe(200);
    expect(open.json().status).toMatchObject({ open: [ada.id], tabs: [{ botId: ada.id }] });
    const unknown = await h!.app.inject({
      method: "POST",
      url: "/api/browser/open",
      headers: auth,
      payload: { botId: "bot_none" },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

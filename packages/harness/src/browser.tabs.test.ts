import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserContext, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from "@mrog/shared";

import { BrowserManager } from "./browser";
import { makeHarness, type TestHarness } from "./testing";

type Handler = (...args: unknown[]) => void;

/**
 * A stand-in for a launched Edge. Like a real persistent profile it starts with one blank tab, and `failNewPage`
 * makes the next new tab fail to open.
 */
function fakeBrowser() {
  const state = { failNewPage: 0 };
  const launch = async (_settings: BrowserSettings, dir: string) => {
    mkdirSync(dir, { recursive: true });
    const listeners = new Map<string, Handler[]>();
    const pages: { closed: boolean }[] = [];
    const makePage = () => {
      const events = new Map<string, Handler[]>();
      const page = {
        closed: false,
        isClosed: () => page.closed,
        url: () => "about:blank",
        setDefaultTimeout: () => {},
        bringToFront: async () => {},
        on: (event: string, handler: Handler) =>
          void events.set(event, [...(events.get(event) ?? []), handler]),
        close: async () => {
          page.closed = true;
        },
      };
      pages.push(page);
      return page;
    };
    makePage();
    const context = {
      pages: () => pages.filter((page) => !page.closed),
      newPage: async () => {
        // Opening a tab takes a moment.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (state.failNewPage > 0) {
          state.failNewPage -= 1;
          throw new Error("no new tab");
        }
        return makePage();
      },
      on: (event: string, handler: Handler) =>
        void listeners.set(event, [...(listeners.get(event) ?? []), handler]),
      newCDPSession: async () => {
        throw new Error("no devtools in the stand-in");
      },
      close: async () => {},
    };
    return context as unknown as BrowserContext;
  };
  return { launch, state };
}

let h: TestHarness | undefined;
let dataDir = "";
afterEach(async () => {
  await h?.close();
  h = undefined;
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), "mrog-tabs-"));
  const browser = fakeBrowser();
  let manager!: BrowserManager;
  h = await makeHarness({
    config: { dataDir },
    setup: (services) => {
      manager = new BrowserManager(services, browser.launch);
      (services as { browser: BrowserManager }).browser = manager;
    },
  });
  // One browser for every bot, so all of them wait on the same start.
  h.store.settings.set("browser", { ...DEFAULT_BROWSER_SETTINGS, show: false, profiles: "shared" });
  const pages = () => (manager as unknown as { pages: Map<string, Page> }).pages;
  return { manager, browser, pages };
}

describe("tabs of one browser profile", () => {
  it("gives bots that start together a tab each, never the same one", async () => {
    const { manager, pages } = await setup();
    const bots = ["Ada", "Bea", "Cy"].map((name) => h!.store.bots.create({ name }));

    await Promise.all(bots.map((bot) => manager.open(bot.id)));

    const tabs = bots.map((bot) => pages().get(bot.id));
    expect(tabs.every(Boolean)).toBe(true);
    expect(new Set(tabs).size).toBe(3);
  });

  it("opens one tab for a bot asking twice at once, and frees the line when a tab fails to open", async () => {
    const { manager, browser, pages } = await setup();
    const [ada, bea, cy] = ["Ada", "Bea", "Cy"].map((name) => h!.store.bots.create({ name }));
    // Ada takes the profile's blank tab; the first new tab after it (Bea's) fails to open.
    browser.state.failNewPage = 1;

    const results = await Promise.allSettled([
      manager.open(ada!.id),
      manager.open(ada!.id),
      manager.open(bea!.id),
      manager.open(cy!.id),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(pages().get(ada!.id)).toBeDefined();
    expect(pages().get(cy!.id)).not.toBe(pages().get(ada!.id));
    expect(new Set(pages().values()).size).toBe(2);
    // The failed bot is not stuck: it gets a tab of its own when it asks again.
    await manager.open(bea!.id);
    expect(new Set(pages().values()).size).toBe(3);
  });
});

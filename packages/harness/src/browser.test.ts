import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_BROWSER_SETTINGS, type Bot } from "@mrog/shared";
import { createToolHost } from "@mrog/tools";

import {
  formatResults,
  formatScreenMap,
  formatSnapshot,
  isSecretField,
  MARKS_SCRIPT,
  relevant,
  SECRET_FIELD,
  takesTyping,
  type PageElement,
  type PageSnapshot,
} from "./browser";
import { shop } from "./fixtures/shop";
import { auth, makeHarness, type TestHarness } from "./testing";
import { clickRisk, enterRisk, spaceRisk, typeRisk, VISUAL_TOOL_NAMES, visualTools } from "./visual";

describe("browser output", () => {
  const snapshot: PageSnapshot = {
    url: "https://shop.example/",
    title: "Shop",
    text: "a".repeat(5000),
    elements: [{ ref: 1, kind: "input:search", label: "Search products" }],
    more: 3,
    humanCheck: false,
  };

  it("hands page text over in parts with numbered elements", () => {
    const first = formatSnapshot(snapshot);
    expect(first).toContain("part 1 of 2; browser_read with part=2 for more");
    expect(first).toContain('[1] input:search "Search products"');
    expect(first).toContain("3 more further down");
    expect(formatSnapshot(snapshot, 2)).toContain("part 2 of 2)");
  });

  it("tells the bot to hand human checks to the user", () => {
    expect(formatSnapshot({ ...snapshot, humanCheck: true })).toContain("Call browser_handoff");
  });

  it("lists search results with their addresses", () => {
    const text = formatResults("phones", [{ title: "A", url: "https://a.example/", snippet: "about A" }]);
    expect(text).toContain("1. A\n   https://a.example/\n   about A");
    expect(formatResults("x", [])).toBe('No results for "x".');
  });

  it("maps the screen's controls by area, top to bottom", () => {
    const map = formatScreenMap([
      { ref: 3, kind: "link", label: "Second result", area: "main", x: 100, y: 400 },
      { ref: 1, kind: "search box", label: "Search", area: "top", x: 300, y: 10 },
      { ref: 2, kind: "link", label: "First result", area: "main", x: 100, y: 200 },
    ]);
    expect(map).toBe(
      'Screen map (controls on screen now; numbers match the boxes):\nTop bar: [1] search box "Search"\nMain area: [2] link "First result" · [3] link "Second result"',
    );
    expect(formatScreenMap([])).toContain("nothing on screen");
  });

  it("treats unrelated results as no results", () => {
    const r = (title: string) => ({ title, url: "https://x.example/", snippet: "" });
    expect(relevant("gsmarena vivo y19s specs", [r("vivo Y19s - Full specifications"), r("Other")])).toBe(
      true,
    );
    expect(relevant("gsmarena vivo y19s specs", [r("TikTok trends"), r("Facebook help")])).toBe(false);
    expect(relevant("anything", [])).toBe(false);
  });
});

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

describe.skipIf(!existsSync(EDGE))("browser (real Edge, hidden window)", () => {
  let h: TestHarness;
  let server: Server;
  let base = "";
  let bot: Bot;
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-browser-"));

  beforeAll(async () => {
    server = shop();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    h = await makeHarness({ config: { dataDir } });
    // One real Edge for every bot here; per-bot profiles are tested below with a stand-in browser.
    h.store.settings.set("browser", { ...DEFAULT_BROWSER_SETTINGS, show: false, profiles: "shared" });
    bot = h.store.bots.create({ name: "Shopper" });
  }, 30_000);

  afterAll(async () => {
    await h.services.browser.close();
    await h.close();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const tool = (name: string) => h.services.browser.tools(bot).find((spec) => spec.name === name)!;
  const ctx = {
    workspace: ".",
    botId: "b",
    botName: "Shopper",
    threadId: "t",
    signal: new AbortController().signal,
    ask: async () => "done",
  };
  const run = async (name: string, args: Record<string, unknown>) => {
    const spec = tool(name);
    return spec.run(spec.args.parse(args), ctx) as Promise<string>;
  };
  const refOf = (text: string, label: string) =>
    Number(new RegExp(`\\[(\\d+)\\] [^\\n]*${label}`).exec(text)?.[1]);

  it("searches a shop with its own search box and reads listings built by JavaScript", async () => {
    const home = await run("browser_open", { url: base });
    expect(home).toContain('input:search "Search products"');
    const results = await run("browser_type", {
      ref: refOf(home, "Search products"),
      text: "phone",
      submit: true,
    });
    expect(results).toContain("Nova 5 4GB/128GB Rs. 29,999");
    const product = await run("browser_click", { ref: refOf(results, "Pixelto A2") });
    expect(product).toContain(`Address: ${base}/p/2`);
    expect(product).toContain("Price: Rs. 34,500");
    // Clicking "Buy now" would act on the site: it asks first.
    const buy = refOf(product, "Buy now");
    expect(await tool("browser_click").risk({ ref: buy }, ctx)).toMatchObject({ level: "ask" });
    // A number that isn't on the page isn't asked about: the click is refused at once, so no card holds the bot.
    expect(await tool("browser_click").risk({ ref: 999 }, ctx)).toMatchObject({ level: "safe" });
    await expect(run("browser_click", { ref: 999 })).rejects.toThrow("There's no [999] on the page now");
    const back = await run("browser_back", {});
    expect(back).toContain("Nova 5");
  }, 60_000);

  it("refuses to type passwords and flags human checks", async () => {
    const login = await run("browser_open", { url: `${base}/login` });
    const host = createToolHost(h.services.browser.tools(bot), ctx, async () => "allow");
    const outcome = await host.execute(
      { id: "c1", name: "browser_type", arguments: { ref: refOf(login, "input:password"), text: "hunter2" } },
      ctx.signal,
    );
    expect(outcome).toMatchObject({ status: "error" });
    expect(outcome.result).toContain("don't type passwords");
    expect(await run("browser_open", { url: `${base}/check` })).toContain("human check");
    // Clicking on a human-check page is the user's job.
    await expect(run("browser_click", { ref: 1 })).rejects.toThrow("human check");
    const home = await run("browser_open", { url: base });
    const notBox = await host.execute(
      { id: "c2", name: "browser_type", arguments: { ref: refOf(home, "Sign in"), text: "x" } },
      ctx.signal,
    );
    expect(notBox.result).toContain("isn't a text box");
  }, 60_000);

  it("asks before opening pages on this computer, and takes screenshots", async () => {
    expect(await tool("browser_open").risk({ url: base }, ctx)).toMatchObject({ level: "ask" });
    expect(await tool("browser_open").risk({ url: "https://example.com" }, ctx)).toMatchObject({
      level: "safe",
    });
    const shot = (await tool("browser_screenshot").run({}, ctx)) as { images: { data: string }[] };
    expect(shot.images[0]?.data.length).toBeGreaterThan(1000);
    expect((await h.services.browser.status()).tabs).toHaveLength(1);
  }, 60_000);

  it("keeps the tab off local addresses nobody approved, even through a redirect", async () => {
    const { createServer } = await import("node:http");
    const redirect = createServer((_request, response) => {
      response.writeHead(302, { location: "http://127.0.0.2:9/" }).end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    try {
      const approved = `http://127.0.0.1:${(redirect.address() as AddressInfo).port}/`;
      await expect(run("browser_open", { url: approved })).rejects.toThrow("local network");
    } finally {
      redirect.close();
    }
  }, 60_000);

  it("keeps a bot's tab for one chat at a time", async () => {
    await run("browser_open", { url: base });
    const elsewhere = { ...ctx, threadId: "another-chat" };
    await expect(tool("browser_read").run({}, elsewhere)).rejects.toThrow("another chat");
    expect(await run("browser_read", {})).toContain("Search products");
  }, 60_000);

  it("signs in with a saved login without the password reaching the bot", async () => {
    expect(tool("browser_sign_in")).toBeUndefined();
    h.services.vaultService.add({
      kind: "login",
      website: base,
      username: "ada@example.com",
      password: "s3cret-pw",
    });
    const signIn = tool("browser_sign_in");
    expect(signIn.description).toContain(base);
    const login = await run("browser_open", { url: `${base}/login` });
    const args = {
      username_ref: refOf(login, "Email"),
      password_ref: refOf(login, "Password"),
      submit: true,
    };
    expect(signIn.risk(args, ctx)).toMatchObject({
      level: "ask",
      summary: expect.stringContaining("127.0.0.1"),
    });
    const after = (await signIn.run(signIn.args.parse(args), ctx)) as string;
    expect(after).toContain("Signed in as ada@example.com");
    expect(after).toContain("Password length 9");
    expect(after).not.toContain("s3cret");
    // The wrong boxes are refused rather than filled.
    await run("browser_open", { url: `${base}/login` });
    await expect(
      signIn.run({ username_ref: args.password_ref, password_ref: args.username_ref, submit: false }, ctx),
    ).rejects.toThrow("isn't a password box");
  }, 60_000);

  it("shows a bot's tab live and lets the user act in it", async () => {
    const view = await h.app.inject({
      method: "GET",
      url: `/api/browser/tabs/${bot.id}/view`,
      headers: auth,
    });
    expect(view.statusCode).toBe(200);
    expect(view.headers["content-type"]).toBe("image/jpeg");
    expect(
      (await h.app.inject({ method: "GET", url: "/api/browser/tabs/bot_none/view", headers: auth }))
        .statusCode,
    ).toBe(404);
    await run("browser_open", { url: base });
    // Click the search box in the picture (it's at the top left), type, press Enter: the shop searches.
    const click = await h.app.inject({
      method: "POST",
      url: `/api/browser/tabs/${bot.id}/click`,
      headers: auth,
      payload: { x: 0.03, y: 0.02 },
    });
    expect(click.statusCode).toBe(204);
    await h.app.inject({
      method: "POST",
      url: `/api/browser/tabs/${bot.id}/type`,
      headers: auth,
      payload: { text: "phone", key: "Enter" },
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await run("browser_read", {})).toContain("Nova 5");
    // The user goes to a sign-in page from the panel's address field.
    const go = await h.app.inject({
      method: "POST",
      url: `/api/browser/tabs/${bot.id}/go`,
      headers: auth,
      payload: { url: `${base}/login` },
    });
    expect(go.statusCode).toBe(204);
    expect(await run("browser_read", {})).toContain(`Address: ${base}/login`);
    const bad = await h.app.inject({
      method: "POST",
      url: `/api/browser/tabs/${bot.id}/go`,
      headers: auth,
      payload: { url: "file:///C:/Windows/win.ini" },
    });
    expect(bad.statusCode).toBe(409);
  }, 60_000);

  it("gives a Visual Bot only screen tools, and works the shop by looking", async () => {
    const eyes = h.store.bots.create({ name: "Looker", visual: true });
    const thread = h.store.threads.get(eyes.threadId)!;
    const names = h.services.turns.extensions.tools!(eyes, thread, "m", new AbortController().signal, {
      delegated: false,
    })!
      .definitions()
      .map((d) => d.name);
    expect(names).toContain("screen_click");
    for (const textual of ["fetch_url", "web_search", "browser_read", "browser_open", "run_command"]) {
      expect(names).not.toContain(textual);
    }

    const visual = (name: string) => h.services.browser.tools(eyes).find((spec) => spec.name === name)!;
    const act = async (name: string, args: Record<string, unknown>) => {
      const spec = visual(name);
      return (await spec.run(spec.args.parse(spec.prepare ? spec.prepare(args) : args), ctx)) as {
        text: string;
        images: { data: string }[];
      };
    };
    // Which box the picture shows a label in (what the model would read off the screenshot).
    const boxOf = (label: string) => {
      for (let ref = 1; ref < 100; ref++) {
        if (h.services.browser.mark(eyes.id, ref)?.label.includes(label)) return ref;
      }
      throw new Error(`no box for ${label}`);
    };

    const home = await act("screen_go_to", { address: base });
    expect(home.images).toHaveLength(1);
    expect(home.text).toContain('search box "Search products"');
    expect(home.text).toContain(`Address bar: ${base}/`);
    expect(home.text).not.toContain("Sign in (");
    await act("screen_click", { box: boxOf("Search products") });
    // Enter in a search box only searches, so it doesn't ask.
    expect(await visual("screen_type").risk({ text: "phone", enter: true }, ctx)).toMatchObject({
      level: "safe",
    });
    const results = await act("screen_type", { text: "phone", enter: true });
    expect(results.text).toContain("/search?q=phone");
    expect(results.text).toContain('link "Pixelto A2 6GB/128GB"');
    expect(results.text).not.toContain("/p/2");
    const product = await act("screen_click", { box: boxOf("Pixelto") });
    expect(product.text).toContain(`Address bar: ${base}/p/2`);
    // "Buy now" asks first; clicking somewhere by position works too.
    expect(await visual("screen_click").risk({ box: boxOf("Buy now") }, ctx)).toMatchObject({ level: "ask" });
    // Clicking "Buy now" by its position asks just the same.
    const buy = h.services.browser.mark(eyes.id, boxOf("Buy now"))!;
    const middle = { x: buy.x! + buy.w! / 2, y: buy.y! + buy.h! / 2 };
    expect(await visual("screen_click_at").risk(middle, ctx)).toMatchObject({ level: "ask" });
    expect((await act("screen_click_at", { x: 20, y: 20 })).images).toHaveLength(1);
    // A point sent as one string still works.
    expect((await act("screen_click_at", { x: "20, 20" })).images).toHaveLength(1);

    await act("screen_go_to", { address: `${base}/login` });
    // Enter in a form field may submit it, so it asks.
    await act("screen_click", { box: boxOf("Email") });
    expect(await visual("screen_press").risk({ key: "Enter" }, ctx)).toMatchObject({ level: "ask" });
    await act("screen_click", { box: boxOf("Password") });
    await expect(act("screen_type", { text: "hunter2" })).rejects.toThrow("don't type passwords");
  }, 90_000);

  it("watches a short clip, streams the tab live, and keeps Visual Bots' moves quick", async () => {
    const eyes = h.store.bots.create({ name: "Watcher", visual: true });
    const thread = h.store.threads.get(eyes.threadId)!;
    expect(h.services.turns.extensions.turnOptions!(eyes, thread, { delegated: false }).think).toBe(false);
    expect(h.services.turns.extensions.turnOptions!(bot, thread, { delegated: false }).think).toBeUndefined();

    const watch = h.services.browser.tools(eyes).find((spec) => spec.name === "screen_watch")!;
    await h.services.browser.goTo(eyes.id, base);
    const started = Date.now();
    const clip = (await watch.run(watch.args.parse({ seconds: 1, frames: 3 }), ctx)) as {
      text: string;
      images: unknown[];
    };
    expect(clip.images).toHaveLength(3);
    expect(clip.text).toContain("0.0s, 0.5s, 1.0s");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    const frames: Buffer[] = [];
    const stop = new AbortController();
    const streaming = h.services.browser.screencast(eyes.id, (jpeg) => void frames.push(jpeg), stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await h.services.browser.scrollView(eyes.id, "down");
    await new Promise((resolve) => setTimeout(resolve, 800));
    stop.abort();
    await streaming;
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]!.subarray(0, 2).toString("hex")).toBe("ffd8");
  }, 90_000);

  it("doesn't take a box for a search box because of what was typed into it", async () => {
    const page = await run("browser_open", { url: `${base}/compose` });
    const typed = await run("browser_type", {
      ref: refOf(page, "Write a reply"),
      text: "search results attached",
      submit: false,
    });
    const enter = (label: string) =>
      tool("browser_type").risk({ ref: refOf(typed, label), text: "x", submit: true }, ctx);
    expect(await enter("search results attached")).toMatchObject({ level: "ask" });
    expect(await enter("Search mail")).toMatchObject({ level: "safe" });
    // An icon-only button has no name to judge it by.
    const unnamed = Number(/\[(\d+)\] button ""/.exec(typed)?.[1]);
    expect(await tool("browser_click").risk({ ref: unnamed }, ctx)).toMatchObject({ level: "ask" });
  }, 60_000);

  it("follows a link to a new tab in the bot's own tab, and doesn't wait for popups that never come", async () => {
    const page = await run("browser_open", { url: `${base}/compose` });
    const started = Date.now();
    const starred = await run("browser_click", { ref: refOf(page, "Star") });
    expect(starred).toContain('button "Starred"');
    expect(Date.now() - started).toBeLessThan(1800);
    const opened = await run("browser_click", { ref: refOf(starred, "Open in a new tab") });
    expect(opened).toContain(`Address: ${base}/p/1`);
    expect((await h.services.browser.status()).tabs.filter((tab) => tab.botId === bot.id)).toHaveLength(1);
  }, 60_000);

  it("keeps a page's own requests off local addresses nobody approved", async () => {
    const { createServer } = await import("node:http");
    let hits = 0;
    const device = createServer((_request, response) => {
      hits += 1;
      response.end("ok");
    });
    await new Promise<void>((resolve) => device.listen(0, "127.0.0.1", resolve));
    try {
      const target = `http://127.0.0.1:${(device.address() as AddressInfo).port}/admin`;
      await run("browser_open", { url: `${base}/probe?to=${encodeURIComponent(target)}` });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await run("browser_read", {})).toContain("Page: blocked");
      expect(hits).toBe(0);
    } finally {
      device.close();
    }
  }, 60_000);

  it("reads further parts of a page without numbering it again", async () => {
    const first = await run("browser_open", { url: `${base}/long` });
    expect(first).toContain("part 1 of 4");
    // The page keeps adding buttons; part 2 still lists the numbers part 1 gave.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await run("browser_read", { part: 2 });
    expect(second).toContain("part 2 of 4");
    const listed = (text: string) => text.slice(text.indexOf("--- Things"));
    expect(listed(second)).toBe(listed(first));
    expect(listed(await run("browser_read", {}))).not.toBe(listed(first));
  }, 60_000);

  it("won't let a Visual Bot's click land on something that asks, hidden under a harmless box", async () => {
    const eyes = h.store.bots.create({ name: "Clicker", visual: true });
    const visual = (name: string) => h.services.browser.tools(eyes).find((spec) => spec.name === name)!;
    const act = async (name: string, args: Record<string, unknown>) => {
      const spec = visual(name);
      return spec.run(spec.args.parse(spec.prepare ? spec.prepare(args) : args), ctx);
    };
    const boxOf = (label: string) =>
      Array.from({ length: 100 }, (_, ref) => h.services.browser.mark(eyes.id, ref)).find((mark) =>
        mark?.label.includes(label),
      )!;
    const title = async () =>
      (await h.services.browser.status()).tabs.find((t) => t.botId === eyes.id)?.title;

    await act("screen_go_to", { address: `${base}/covered` });
    const next = boxOf("Next page");
    // Judged by the box the bot chose: harmless.
    expect(await visual("screen_click").risk({ box: next.ref }, ctx)).toMatchObject({ level: "safe" });
    // But a "Subscribe now" layer is on top, and that is what the click would hit.
    await expect(act("screen_click", { box: next.ref })).rejects.toThrow("covered by “Subscribe now”");
    const middle = { x: next.x! + next.w! / 2, y: next.y! + next.h! / 2 };
    await expect(act("screen_click_at", middle)).rejects.toThrow("covered by “Subscribe now”");
    expect(await title()).not.toBe("subscribed");
    // A checkbox is named by its label, not its value ("on"), so ticking an agreement asks.
    expect(boxOf("Keep me posted").kind).toBe("checkbox");
    expect(await visual("screen_click").risk({ box: boxOf("I agree").ref }, ctx)).toMatchObject({
      level: "ask",
    });
    // A checkbox drawn over its own input still gets the click.
    await act("screen_click", { box: boxOf("Keep me posted").ref });
    expect(await title()).toBe("kept");
    // A layer that is no control (like YouTube's preview over a thumbnail) doesn't stop the click.
    await act("screen_go_to", { address: `${base}/covered?layer=plain` });
    await act("screen_click", { box: boxOf("Next page").ref });
    // Without the layer, the same click goes through.
    await act("screen_go_to", { address: `${base}/covered?layer=off` });
    await act("screen_click", { box: boxOf("Next page").ref });
    expect(await title()).toBe("next clicked");
  }, 90_000);

  it("blends in as an ordinary browser by default, and says it's automated when that's switched off", async () => {
    const who = async () => /webdriver=\S+ agent=[^\n]+/.exec(await run("browser_read", {}))?.[0] ?? "";
    await run("browser_open", { url: `${base}/whoami` });
    const blended = await who();
    expect(blended).toContain("webdriver=false");
    expect(blended).not.toContain("Headless");
    await h.services.browser.saveSettings({ ...h.services.browser.settings(), blendIn: false });
    try {
      await run("browser_open", { url: `${base}/whoami` });
      const plain = await who();
      expect(plain).toContain("webdriver=true");
      expect(plain).toContain("Headless");
    } finally {
      await h.services.browser.saveSettings({ ...h.services.browser.settings(), blendIn: true });
    }
  }, 90_000);

  it("types over what a box holds instead of adding to it, and says what the box holds now", async () => {
    const eyes = h.store.bots.create({ name: "Writer", visual: true });
    const visual = (name: string) => h.services.browser.tools(eyes).find((spec) => spec.name === name)!;
    const act = async (name: string, args: Record<string, unknown>) => {
      const spec = visual(name);
      return (await spec.run(spec.args.parse(args), ctx)) as { text: string };
    };
    const box = (label: string) =>
      Array.from({ length: 100 }, (_, ref) => h.services.browser.mark(eyes.id, ref)).find((mark) =>
        mark?.label.includes(label),
      )!;

    const page = await act("screen_go_to", { address: `${base}/prefilled` });
    // The map tells the box's name apart from what's in it: the last search is still there.
    expect(page.text).toContain('search box "Search" holding "vivo y19s"');
    await act("screen_click", { box: box("Search").ref });
    const typed = await act("screen_type", { text: "pixel phone" });
    expect(typed.text).toContain("The box now holds “pixel phone”.");
    // A second try at the same text doesn't run the two together.
    await act("screen_type", { text: "pixel phone" });
    expect(box("Search").holds).toBe("pixel phone");
    // A rich-text box (as in mail and chat composers) gets a box, and is typed over the same way.
    expect(box("Note")).toMatchObject({ kind: "text box", holds: "Old note" });
    await act("screen_click", { box: box("Note").ref });
    expect((await act("screen_type", { text: "new note" })).text).toContain("The box now holds “new note”.");
    // Typing with nothing selected doesn't hold the bot on a card about Enter: it's told to click a box first.
    await act("screen_go_to", { address: `${base}/outlet` });
    expect(await visual("screen_type").risk({ text: "phone", enter: true }, ctx)).toMatchObject({
      level: "safe",
    });
    await expect(act("screen_type", { text: "phone", enter: true })).rejects.toThrow(
      "Click the text box first",
    );
  }, 90_000);

  it("draws each box's number level with its own box, so a tight list doesn't pair numbers with the wrong row", async () => {
    const eyes = h.store.bots.create({ name: "Counter", visual: true });
    await h.services.browser.goTo(eyes.id, `${base}/outlet/phones?page=2`);
    const page = (
      h.services.browser as unknown as { pages: Map<string, import("playwright-core").Page> }
    ).pages.get(eyes.id)!;
    await page.evaluate(MARKS_SCRIPT);
    // In-page code as a string, like the app's own scripts (the tests are typed for Node, not the page).
    const placed = (await page.evaluate(`[...document.querySelectorAll("#mrog-marks > div")].map((frame) => {
      const box = frame.getBoundingClientRect();
      const tag = frame.firstElementChild.getBoundingClientRect();
      return { number: frame.textContent, top: box.top, bottom: box.bottom, tagTop: tag.top };
    })`)) as { number: string; top: number; bottom: number; tagTop: number }[];
    expect(placed.length).toBeGreaterThan(4);
    for (const mark of placed) {
      // Level with its own box (within the frame's border), never on the row above.
      expect(mark.tagTop, `number ${mark.number}`).toBeGreaterThanOrEqual(mark.top - 3);
      expect(mark.tagTop, `number ${mark.number}`).toBeLessThan(mark.bottom);
    }
  }, 60_000);

  it("tells a bot plainly that a guessed address doesn't exist, instead of the browser's own error", async () => {
    const eyes = h.store.bots.create({ name: "Guesser", visual: true });
    const go = h.services.browser.tools(eyes).find((spec) => spec.name === "screen_go_to")!;
    const error = await go
      .run(go.args.parse(go.prepare!({ address: `${base}/outlet/phones/pixelto-a2` })), ctx)
      .catch((caught: Error) => caught);
    expect(String(error)).toContain("doesn't exist on the site");
    expect(String(error)).not.toMatch(/ERR_|Call log/);
    // And the outlet doesn't mind a trailing slash.
    const home = (await go.run(go.args.parse(go.prepare!({ address: `${base}/outlet/` })), ctx)) as {
      text: string;
    };
    expect(home.text).toContain('link "Phones"');
  }, 60_000);

  it("carries on by itself once the user has solved a check, with nobody replying", async () => {
    await run("browser_open", { url: `${base}/solvable` });
    const asked: string[] = [];
    const waiting = {
      ...ctx,
      // Nobody types anything: the card is only settled by the check going away.
      ask: (question: string, choices?: { until?: Promise<string> }) => {
        asked.push(question);
        return choices?.until ?? new Promise<string>(() => {});
      },
    };
    const started = Date.now();
    const handoff = tool("browser_handoff");
    const result = (await handoff.run({ reason: "Solve the check" }, waiting)) as string;
    expect(asked[0]).toContain("carries on by itself");
    expect(result).toContain("The user solved the check");
    expect(result).toContain("Plenty of results");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it("doesn't take an ordinary page for a human check", async () => {
    const eyes = h.store.bots.create({ name: "Reader", visual: true });
    const visual = (name: string) => h.services.browser.tools(eyes).find((spec) => spec.name === name)!;
    const act = async (name: string, args: Record<string, unknown>) => {
      const spec = visual(name);
      return (await spec.run(spec.args.parse(spec.prepare ? spec.prepare(args) : args), ctx)) as {
        text: string;
      };
    };
    const page = await act("screen_go_to", { address: `${base}/article` });
    expect(page.text).not.toContain("human check");
    const more = Array.from({ length: 100 }, (_, ref) => h.services.browser.mark(eyes.id, ref)).find((mark) =>
      mark?.label.includes("Read more"),
    )!;
    await act("screen_click", { box: more.ref });
    // A real challenge page still counts.
    expect((await act("screen_go_to", { address: `${base}/check` })).text).toContain("human check");
  }, 90_000);

  it("judges Enter and Space by what has focus now, however it got there", async () => {
    const eyes = h.store.bots.create({ name: "Typist", visual: true });
    const visual = (name: string) => h.services.browser.tools(eyes).find((spec) => spec.name === name)!;
    const act = async (name: string, args: Record<string, unknown>) => {
      const spec = visual(name);
      return spec.run(spec.args.parse(spec.prepare ? spec.prepare(args) : args), ctx);
    };
    const boxes = () =>
      Array.from({ length: 100 }, (_, ref) => h.services.browser.mark(eyes.id, ref)).filter(Boolean);
    const boxOf = (label: string) => boxes().find((mark) => mark!.label.includes(label))!.ref;
    const press = (key: string) => visual("screen_press").risk({ key }, ctx);

    await act("screen_go_to", { address: `${base}/compose` });
    await act("screen_click", { box: boxOf("Search mail") });
    expect(await press("Enter")).toMatchObject({ level: "safe" });
    // Tab moves on to the reply box, then to Send: Enter and Space there send, so they ask.
    await act("screen_press", { key: "Tab" });
    expect(await press("Enter")).toMatchObject({ level: "ask" });
    expect(await press("Space")).toMatchObject({ level: "safe" });
    await act("screen_press", { key: "Tab" });
    expect(await press("Enter")).toMatchObject({ level: "ask", summary: expect.stringContaining("Send") });
    expect(await press("Space")).toMatchObject({ level: "ask" });
    // A button with no name, and a spot with nothing marked, can't be judged: they ask.
    const icon = boxes().find((mark) => mark!.kind === "button" && !mark!.label)!;
    expect(await visual("screen_click").risk({ box: icon.ref }, ctx)).toMatchObject({ level: "ask" });
    expect(await visual("screen_click_at").risk({ x: 1200, y: 800 }, ctx)).toMatchObject({ level: "ask" });
  }, 90_000);

  it("asks before typed text with a line break in it, and won't type at a button or tick box", async () => {
    const eyes = h.store.bots.create({ name: "Newline", visual: true });
    const visual = (name: string) => h.services.browser.tools(eyes).find((spec) => spec.name === name)!;
    const act = async (name: string, args: Record<string, unknown>) => {
      const spec = visual(name);
      return (await spec.run(spec.args.parse(spec.prepare ? spec.prepare(args) : args), ctx)) as {
        text: string;
      };
    };
    const boxOf = (label: string) =>
      Array.from({ length: 100 }, (_, ref) => h.services.browser.mark(eyes.id, ref)).find((mark) =>
        mark?.label.includes(label),
      )!.ref;
    const page = () =>
      (h.services.browser as unknown as { pages: Map<string, import("playwright-core").Page> }).pages.get(
        eyes.id,
      )!;

    await act("screen_go_to", { address: `${base}/form` });
    await act("screen_click", { box: boxOf("Note") });
    // A line break is an Enter press, so it asks like `enter` does; plain text doesn't.
    expect(await visual("screen_type").risk({ text: "hello\n" }, ctx)).toMatchObject({ level: "ask" });
    expect(await visual("screen_type").risk({ text: "line\r\nbreak" }, ctx)).toMatchObject({ level: "ask" });
    expect(await visual("screen_type").risk({ text: "hello" }, ctx)).toMatchObject({ level: "safe" });

    // Tab to the tick box, then to "Pay now": typing a space there would tick or press it, so nothing is typed.
    await act("screen_press", { key: "Tab" });
    await expect(act("screen_type", { text: " " })).rejects.toThrow("not a text box");
    expect(await page().isChecked("#gift")).toBe(false);
    await act("screen_press", { key: "Tab" });
    await expect(act("screen_type", { text: " " })).rejects.toThrow("not a text box");
    await expect(act("screen_type", { text: "hi\n" })).rejects.toThrow("not a text box");
    expect(page().url()).not.toContain("/sent");

    // Where the text box has the keys, the approved line break is the Enter that sends the form.
    await act("screen_go_to", { address: `${base}/form` });
    await act("screen_click", { box: boxOf("Note") });
    const sent = await act("screen_type", { text: "hello\n" });
    expect(sent.text).toContain("/sent?note=hello");
    expect(sent.text).not.toContain("The box now holds");
  }, 90_000);

  it("fills a one-line box with browser_type without a line break sending the form, and refuses card boxes", async () => {
    const form = await run("browser_open", { url: `${base}/form` });
    const filled = await run("browser_type", { ref: refOf(form, "Note"), text: "hello\nworld" });
    expect(filled).toContain(`Address: ${base}/form`);
    expect(filled).not.toContain("/sent");
    // A card number in a plain text box is refused like a password box is.
    const pay = await run("browser_open", { url: `${base}/pay` });
    expect(pay).not.toMatch(/4242|5555|hunter2/);
    for (const label of ["Card number", "Billing card", "Account password"])
      await expect(run("browser_type", { ref: refOf(pay, label), text: "1" })).rejects.toThrow(
        "don't type passwords or card numbers",
      );
  }, 60_000);

  it("keeps card numbers and passwords out of the screen map and the picture, even in plain text boxes", async () => {
    const eyes = h.store.bots.create({ name: "Payer", visual: true });
    const look = h.services.browser.tools(eyes).find((spec) => spec.name === "screen_look")!;
    const goTo = h.services.browser.tools(eyes).find((spec) => spec.name === "screen_go_to")!;
    const page = () =>
      (h.services.browser as unknown as { pages: Map<string, import("playwright-core").Page> }).pages.get(
        eyes.id,
      )!;

    const opened = (await goTo.run(goTo.args.parse({ address: `${base}/pay` }), ctx)) as { text: string };
    for (const secret of ["4242", "5555", "hunter2"]) expect(opened.text).not.toContain(secret);
    // An ordinary box still tells what it holds.
    expect(opened.text).toContain('holding "Ada Lovelace"');

    // The picture has them covered; the boxes keep their values and carry no marks afterwards.
    const direct = async () => (await page().screenshot({ type: "jpeg", quality: 60 })).toString("base64");
    const bare = await direct();
    expect(await direct()).toBe(bare);
    const seen = (await look.run(look.args.parse({ marks: false }), ctx)) as {
      images: { data: string }[];
    };
    expect(seen.images[0]!.data).not.toBe(bare);
    expect(await page().inputValue("#card")).toBe("4242 4242 4242 4242");
    expect(await page().inputValue("#pass")).toBe("hunter2");
    expect(await page().locator("[data-mrog-secret]").count()).toBe(0);
    expect(await direct()).toBe(bare);
  }, 60_000);
});

describe("a Visual Bot's tools", () => {
  it("are listed by exact name, so an app's `screen__…` tools can't pass for them", () => {
    const bot = { id: "bot_x", name: "Eyes", visual: true } as Bot;
    const names = visualTools({} as never, bot, ["shop.example"]).map((spec) => spec.name);
    expect(names.toSorted()).toEqual([...VISUAL_TOOL_NAMES].toSorted());
  });
});

describe("judging clicks and keys", () => {
  const control = (label: string, kind = "button"): PageElement => ({ ref: 1, kind, label });

  it("asks before clicks that may act, in other languages too, and before unnamed or unknown controls", () => {
    for (const label of [
      "Move to trash",
      "Discard draft",
      "Deactivate account",
      "Save changes",
      "Reply",
      "Share",
      "Place bid",
      "Accept all",
      "Jetzt kaufen",
      "Supprimer",
      "Enviar mensaje",
      "Löschen",
      "购买",
      "🗑",
    ]) {
      expect(clickRisk(control(label), `Click “${label}”`).level, label).toBe("ask");
    }
    for (const label of ["Next page", "Reviews", "Sort by price", "Close", "Results", "×"]) {
      expect(clickRisk(control(label), "Click").level, label).toBe("safe");
    }
    expect(clickRisk(control(""), "Click").level).toBe("ask");
    expect(clickRisk(control("", "input:submit"), "Click").level).toBe("ask");
    expect(clickRisk(control("Новости", "link"), "Click").level).toBe("safe");
    expect(clickRisk(undefined, "Click").level).toBe("ask");
  });

  it("judges Enter and Space by the focused control", () => {
    const search = { ...control("search results", "text box"), search: true };
    expect(enterRisk(search, "Enter").level).toBe("safe");
    expect(enterRisk(control("search results attached", "text box"), "Enter").level).toBe("ask");
    expect(enterRisk(control("Send"), "Enter").level).toBe("ask");
    expect(enterRisk(control("Next page", "link"), "Enter").level).toBe("safe");
    expect(enterRisk(undefined, "Enter").level).toBe("ask");
    expect(spaceRisk(control("Send"), "Space").level).toBe("ask");
    expect(spaceRisk(control("I agree", "checkbox"), "Space").level).toBe("ask");
    expect(spaceRisk(control("Write a reply", "text box"), "Space").level).toBe("safe");
    expect(spaceRisk(undefined, "Space").level).toBe("safe");
  });

  it("judges a line break in typed text exactly like Enter", () => {
    const search = { ...control("search results", "text box"), search: true };
    const message = control("Write a reply", "text box");
    // Free only in a real search box; anywhere else a line break may send or submit, so it asks.
    for (const text of ["hello\n", "hello\r", "a\r\nb", "\n"]) {
      expect(typeRisk(search, text, false).level, JSON.stringify(text)).toBe("safe");
      expect(typeRisk(message, text, false).level, JSON.stringify(text)).toBe("ask");
      expect(typeRisk(message, text, false)).toEqual(
        expect.objectContaining({ summary: expect.stringContaining("press Enter") }),
      );
      expect(typeRisk(control("Send"), text, false).level, JSON.stringify(text)).toBe("safe");
    }
    expect(typeRisk(message, "hello", false).level).toBe("safe");
    expect(typeRisk(message, "hello", true).level).toBe("ask");
    expect(typeRisk(search, "hello", true).level).toBe("safe");
    // With nothing to type into selected, the typing is refused before any key: nothing to ask about.
    expect(typeRisk(undefined, "a\nb", false).level).toBe("safe");
    expect(typeRisk(control("Pay now", "button"), " ", true).level).toBe("safe");
  });

  it("types only into boxes for text, so Space and Enter can't press a button or tick a box", () => {
    const target = (tag: string, type = "", multiline = false) => ({ tag, type, multiline });
    for (const type of ["text", "search", "email", "url", "tel", "number"])
      expect(takesTyping(target("INPUT", type)), type).toBe(true);
    expect(takesTyping(target("TEXTAREA", "", true))).toBe(true);
    expect(takesTyping(target("DIV", "", true))).toBe(true);
    for (const type of ["submit", "button", "reset", "image", "checkbox", "radio", "file", "range", "color"])
      expect(takesTyping(target("INPUT", type)), type).toBe(false);
    for (const tag of ["BUTTON", "A", "SELECT", "SUMMARY", "BODY"])
      expect(takesTyping(target(tag)), tag).toBe(false);
    expect(takesTyping(null)).toBe(false);
  });

  it("knows a password or card box by type, autocomplete token, or what the site calls it", () => {
    // Each case is [type, autocomplete, name/id/placeholder/label]; the page script must agree with this side.
    const secret: [string, string, string][] = [
      ["password", "", ""],
      ["PASSWORD", "", ""],
      ["text", "current-password", ""],
      ["text", "new-password", "Choose one"],
      ["text", "billing cc-number", ""],
      ["text", "cc-csc", ""],
      ["text", "section-pay cc-exp", ""],
      ["text", "", "cardNumber"],
      ["text", "", "card_number"],
      ["text", "", "Card no."],
      ["text", "", "ccnum"],
      ["tel", "", "cvv"],
      ["text", "", "card_cvc"],
      ["text", "", "Security code"],
      ["text", "", "Credit card"],
    ];
    const notSecret: [string, string, string][] = [
      ["text", "", ""],
      ["text", "off", "q"],
      ["email", "email", "Email"],
      ["text", "name", "Name on card"],
      ["text", "x-cc-number", ""],
      ["text", "new-passwords", ""],
      ["text", "", "discard number"],
      ["text", "", "card-notes"],
      ["text", "", "Search products"],
      ["text", "", "Account number"],
      ["checkbox", "", "Remember my card"],
    ];
    const inPage = new Function(`return ${SECRET_FIELD}`)() as (el: unknown) => boolean;
    const field = (type: string, autocomplete: string, hint: string) => ({
      matches: () => true,
      getAttribute: (name: string) => ({ type, autocomplete, "aria-label": hint })[name] || null,
    });
    for (const [type, autocomplete, hint] of secret) {
      const said = JSON.stringify([type, autocomplete, hint]);
      expect(isSecretField(type, autocomplete, hint), said).toBe(true);
      expect(inPage(field(type, autocomplete, hint)), said).toBe(true);
    }
    for (const [type, autocomplete, hint] of notSecret) {
      const said = JSON.stringify([type, autocomplete, hint]);
      expect(isSecretField(type, autocomplete, hint), said).toBe(false);
      expect(inPage(field(type, autocomplete, hint)), said).toBe(false);
    }
    // Only boxes count: a link or button with such a word in its name is no field.
    expect(inPage({ matches: () => false, getAttribute: () => "card number" })).toBe(false);
  });
});

describe("search APIs and a busy tab", () => {
  it("stops waiting for a search server when the chat stops, and refuses another chat during a handoff", async () => {
    const harness = await makeHarness({
      handlers: { "searx.example/search": () => new Promise<Response>(() => {}) },
    });
    try {
      harness.store.settings.set("browser", {
        ...DEFAULT_BROWSER_SETTINGS,
        show: false,
        search: "searxng",
        searxngUrl: "http://searx.example",
      });
      const bot = harness.store.bots.create({ name: "Finder" });
      const tool = (name: string) => harness.services.browser.tools(bot).find((spec) => spec.name === name)!;
      const context = (threadId: string, signal: AbortSignal, ask = async () => "done") => ({
        workspace: ".",
        botId: bot.id,
        botName: bot.name,
        threadId,
        signal,
        ask,
      });

      const stop = new AbortController();
      const search = tool("web_search").run({ query: "anything" }, context("chat-1", stop.signal));
      setTimeout(() => stop.abort(), 100);
      await expect(search).rejects.toThrow();

      // Chat 1 hands the tab to the user; chat 2 is told at once instead of queueing behind it.
      const handoff = new AbortController();
      const waiting = tool("browser_handoff").run(
        { reason: "Solve the check" },
        context(
          "chat-1",
          handoff.signal,
          () =>
            new Promise<string>((_resolve, reject) =>
              handoff.signal.addEventListener("abort", () => reject(new Error("stopped"))),
            ),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const started = Date.now();
      await expect(
        tool("web_search").run({ query: "x" }, context("chat-2", new AbortController().signal)),
      ).rejects.toThrow("another chat");
      expect(Date.now() - started).toBeLessThan(1000);
      handoff.abort();
      await expect(waiting).rejects.toThrow();
    } finally {
      await harness.close();
    }
  });
});

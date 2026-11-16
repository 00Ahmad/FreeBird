import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_BROWSER_SETTINGS, type Bot } from "@mrog/shared";

import { secretFileReason } from "../coding-paths";
import { makeHarness, type TestHarness } from "../testing";
import { answers, printedUrl, startApp, waitForServer, waitForWindow } from "./launch";
import { servedPath, serveFolder } from "./serve";
import { VisualSession } from "./session";
import { visualQaTools } from "./tools";

const folder = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "mrog-vqa-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

describe("serving a project's pages", () => {
  const dir = folder({
    "index.html": "<h1>hi</h1>",
    "js/app.js": "1",
    ".env": "KEY=1",
    "keys/server.pem": "x",
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("serves files inside the folder only, never hidden or secret ones", () => {
    expect(servedPath(dir, "/", secretFileReason)).toBe(join(dir, "index.html"));
    expect(servedPath(dir, "/js/app.js?v=1", secretFileReason)).toBe(join(dir, "js", "app.js"));
    expect(servedPath(dir, "/../outside.txt", secretFileReason)).toBeNull();
    expect(servedPath(dir, "/%2e%2e/outside.txt", secretFileReason)).toBeNull();
    expect(servedPath(dir, "/js%5c..%5c..%5cx", secretFileReason)).toBeNull();
    expect(servedPath(dir, "/.env", secretFileReason)).toBeNull();
    expect(servedPath(dir, "/keys/server.pem", secretFileReason)).toBeNull();
    expect(servedPath(dir, "/C:/Windows/win.ini", secretFileReason)).toBeNull();
  });

  it("answers on 127.0.0.1 with the right type, and 404 for the rest", async () => {
    const served = await serveFolder(dir, secretFileReason);
    try {
      expect(served.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const page = await fetch(`${served.origin}/`);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toBe("<h1>hi</h1>");
      expect((await fetch(`${served.origin}/js/app.js`)).headers.get("content-type")).toContain("javascript");
      expect((await fetch(`${served.origin}/.env`)).status).toBe(404);
      expect((await fetch(`${served.origin}/nope.js`)).status).toBe(404);
      expect((await fetch(`${served.origin}/`, { method: "POST" })).status).toBe(405);
    } finally {
      await served.close();
    }
  });
});

describe("starting an app in the background", () => {
  const dir = folder({
    "server.js": `require("node:http").createServer((q, r) => r.end("ok")).listen(0, "127.0.0.1", function () { console.log("Local: http://localhost:" + this.address().port + "/"); });`,
    "crash.js": `console.log("starting"); throw new TypeError("boom in crash.js");`,
    "stays.js": `setInterval(() => {}, 1000);`,
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the address a dev server prints", () => {
    expect(printedUrl("\u001b[32m  ➜  Local:   http://localhost:5173/\n")).toBe("http://localhost:5173/");
    expect(printedUrl(" * Running on http://0.0.0.0:5000 (Press CTRL+C)")).toBe("http://127.0.0.1:5000");
    expect(printedUrl("visit https://example.com")).toBeNull();
  });

  it("waits for a server to answer on the address it prints, then stops it", async () => {
    const app = startApp("node server.js", dir);
    try {
      const ready = await waitForServer(app, {
        port: null,
        timeoutMs: 20_000,
        signal: new AbortController().signal,
      });
      expect(ready.url).toMatch(/^http:\/\/localhost:\d+\/$/);
      expect(await answers(ready.url!.replace("localhost", "127.0.0.1"))).toBe(true);
    } finally {
      await app.stop();
    }
  }, 30_000);

  it("reports an app that crashes on start, with what it printed", async () => {
    const app = startApp("node crash.js", dir);
    const ready = await waitForServer(app, {
      port: null,
      timeoutMs: 20_000,
      signal: new AbortController().signal,
    });
    expect(ready).toMatchObject({ url: null, exited: true });
    expect(app.exitCode()).not.toBe(0);
    expect(app.output()).toContain("boom in crash.js");
  }, 30_000);

  it("tells a desktop app that stays open from one that stops", async () => {
    const stays = startApp("node stays.js", dir);
    expect(await waitForWindow(stays, 1500, new AbortController().signal)).toBe(true);
    await stays.stop();
    const crash = startApp("node crash.js", dir);
    expect(await waitForWindow(crash, 15_000, new AbortController().signal)).toBe(false);
  }, 30_000);
});

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

/** A page that looks fine in its code but is broken in use: the user's complaint about QA. */
const BROKEN = {
  "index.html": `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>
<h1>Tasks</h1>
<input id="task" placeholder="New task">
<button id="add">Add</button>
<button id="clear">Clear</button>
<div style="position:relative"><button id="save">Save</button><div id="banner" style="position:absolute;inset:-4px;background:#fff8">Cookie banner</div></div>
<ul id="list"></ul>
<script src="js/app.js"></script>
<script src="js/missing.js"></script>
</body></html>`,
  "style.css": "body { font-family: sans-serif; }",
  // Wires "Clear" only; "Add" is looked up by the wrong id, so the script also throws.
  "js/app.js": `document.getElementById("clear").addEventListener("click", () => { document.getElementById("list").innerHTML = ""; });
document.getElementById("add-button").addEventListener("click", () => {});`,
};

/** A framework-style page: one listener on the root handles every button (it must not count as broken). */
const DELEGATED = {
  "index.html": `<!doctype html><html><body><div id="root"><button>One</button><button>Two</button></div>
<label style="position:relative;display:inline-block;padding-left:28px">Done<input type="checkbox" style="position:absolute;opacity:0;left:0"><span style="position:absolute;top:0;left:0;width:20px;height:20px;background:#ccc"></span></label>
<label style="position:relative;display:inline-block;padding-left:28px">Starred<input type="checkbox" style="position:absolute;left:0;top:0"><span style="position:absolute;top:0;left:0;width:22px;height:22px;background:#fc0"></span></label>
<input type="checkbox" style="width:0;height:0">
<script>document.getElementById("root").addEventListener("click", (e) => { e.target.textContent += "!"; });</script></body></html>`,
};

describe.skipIf(!existsSync(EDGE))("Visual QA in a real browser (Edge, hidden)", () => {
  let h: TestHarness;
  let qa: Bot;
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-vqa-browser-"));
  const dirs: string[] = [];

  beforeAll(async () => {
    h = await makeHarness({ config: { dataDir } });
    h.store.settings.set("browser", { ...DEFAULT_BROWSER_SETTINGS, show: false, profiles: "shared" });
    qa = h.store.bots.create({ name: "QA" });
  }, 30_000);

  afterAll(async () => {
    await h.services.browser.close();
    await h.close();
    for (const dir of [dataDir, ...dirs]) rmSync(dir, { recursive: true, force: true });
  });

  const session = (files: Record<string, string>) => {
    const dir = folder(files);
    dirs.push(dir);
    const planned = Object.keys(files);
    return new VisualSession({
      browser: h.services.browser,
      botId: qa.id,
      outputFolder: dir,
      planned,
      run: { kind: "page", entry: "index.html" },
      read: (path) => (files as Record<string, string>)[path] ?? null,
      refuse: secretFileReason,
    });
  };

  it("finds the dead button, the covered one, the missing script and the script error without a model", async () => {
    const check = session(BROKEN);
    try {
      const result = await check.start(new AbortController().signal);
      expect(result.images.length).toBe(1);
      const problems = check.auto.map((finding) => `${finding.file}: ${finding.problem}`).join("\n");
      expect(problems).toContain("“Add” does nothing when clicked");
      expect(problems).not.toContain("“Clear” does nothing");
      expect(problems).toMatch(/“Save” can't be clicked: “Cookie banner” lies on top of it/);
      expect(problems).toContain("/js/missing.js, which isn't there (HTTP 404)");
      expect(problems).toMatch(/js\/app\.js: The page shows an error in the browser console: TypeError/);
      expect(result.text).toContain("The automatic checks found problems");
    } finally {
      await check.stop();
    }
    // Stopped: the server is gone and QA's tab is closed.
    expect(h.services.browser.addressOf(qa.id)).toBeNull();
  }, 60_000);

  it("opens the address a server prints, not another app already on its usual port", async () => {
    const other = createServer((_, response) => response.end("someone else's app"));
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    const busy = (other.address() as AddressInfo).port;
    const files = {
      "server.js": `require("node:http").createServer((q, r) => r.end("<button onclick='1'>Mine</button>")).listen(0, "127.0.0.1", function () { console.log("Listening on http://127.0.0.1:" + this.address().port); });`,
    };
    const dir = folder(files);
    dirs.push(dir);
    const check = new VisualSession({
      browser: h.services.browser,
      botId: qa.id,
      outputFolder: dir,
      planned: ["server.js"],
      run: {
        kind: "server",
        command: "node server.js",
        install: null,
        main: "server.js",
        port: busy,
        framework: "Node",
      },
      read: (path) => (files as Record<string, string>)[path] ?? null,
      refuse: secretFileReason,
    });
    try {
      const result = await check.start(new AbortController().signal);
      expect(check.origin).not.toBe(`http://127.0.0.1:${busy}`);
      expect(result.text).toContain("Mine");
    } finally {
      await check.stop();
      other.close();
    }
  }, 60_000);

  it("says which program is missing instead of blaming the code", async () => {
    const dir = folder({ "app.py": "import tkinter" });
    dirs.push(dir);
    const check = new VisualSession({
      browser: h.services.browser,
      botId: qa.id,
      outputFolder: dir,
      planned: ["app.py"],
      run: {
        kind: "desktop",
        command: "no-such-program-xyz app.py",
        install: null,
        main: "app.py",
        framework: "tkinter",
      },
      read: () => null,
      refuse: secretFileReason,
    });
    try {
      const result = await check.start(new AbortController().signal);
      expect(check.missing).toBe("no-such-program-xyz");
      expect(check.auto).toEqual([]);
      expect(result.text).toContain("isn't installed on this computer");
    } finally {
      await check.stop();
    }
  }, 60_000);

  it("counts a handler on a parent (as frameworks do) as handling the buttons, and leaves styled checkboxes alone", async () => {
    const check = session(DELEGATED);
    try {
      await check.start(new AbortController().signal);
      expect(check.auto).toEqual([]);
    } finally {
      await check.stop();
    }
  }, 60_000);

  it("lets QA click anything on the app without asking, inspect a control, and read the console", async () => {
    const check = session(BROKEN);
    const tools = visualQaTools(h.services.browser, qa, check, "C:/out");
    const tool = (name: string) => tools.find((spec) => spec.name === name)!;
    const ctx = {
      workspace: ".",
      botId: qa.id,
      botName: "QA",
      threadId: "t",
      signal: new AbortController().signal,
      ask: async () => "done",
    };
    try {
      expect(await tool("screen_click").run({ box: 1 }, ctx)).toContain("call app_start first");
      expect(await tool("app_start").risk({}, ctx)).toMatchObject({ level: "safe" });
      const opened = (await tool("app_start").run({}, ctx)) as { text: string };
      const box = (label: string) =>
        Number(new RegExp(`\\[(\\d+)\\] [^\\]]*"${label}"`).exec(opened.text)?.[1]);
      expect(box("Clear")).toBeGreaterThan(0);
      // "Clear" would ask on any other site; on the app under test it doesn't.
      expect(await tool("screen_click").risk({ box: box("Clear") }, ctx)).toMatchObject({ level: "safe" });
      const inspected = (await tool("app_inspect").run({ box: box("Add") }, ctx)) as string;
      expect(inspected).toContain("A click on it is handled (on it or on something around it): no");
      expect(await tool("app_console").run({}, ctx)).toContain("no new errors");
    } finally {
      await check.stop();
    }
  }, 60_000);
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_BROWSER_SETTINGS, type Bot } from "@mrog/shared";

import { secretFileReason } from "../coding-paths";
import { makeHarness, type TestHarness } from "../testing";
import { quickVisualCheck } from "./quick";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

/** A to-do page: the list fills itself, "Add" adds what was typed, and "Clear" is broken (it throws). */
const TODO = {
  "index.html": `<!doctype html><html><body>
<p id="status">Loading</p>
<ul id="list"></ul>
<input id="task"><button id="add">Add</button><button id="clear">Clear</button>
<script src="app.js"></script></body></html>`,
  "app.js": `document.addEventListener("DOMContentLoaded", () => {
  const list = document.getElementById("list");
  const add = (text) => { const li = document.createElement("li"); li.textContent = text; list.appendChild(li); };
  setTimeout(() => { add("First"); document.getElementById("status").textContent = "Ready"; }, 200);
  document.getElementById("add").addEventListener("click", () => add(document.getElementById("task").value));
  document.getElementById("clear").addEventListener("click", () => { throw new TypeError("list.empty is not a function"); });
});`,
};

describe.skipIf(!existsSync(EDGE))("the plan's done checks, in a real browser", () => {
  let h: TestHarness;
  let qa: Bot;
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-done-browser-"));
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

  const check = (
    checks: string[],
    site: Record<string, string> = TODO,
    signal = new AbortController().signal,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "mrog-done-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(site)) writeFileSync(join(dir, path), text);
    const files = { files: Object.keys(site), read: (path: string) => site[path] ?? null };
    return quickVisualCheck({
      browser: h.services.browser,
      qaBotId: qa.id,
      outputFolder: dir,
      files,
      run: { kind: "page", entry: "index.html" },
      refuse: secretFileReason,
      signal,
      done: [{ file: "app.js", checks }],
    });
  };

  it("passes the checks the page meets, waiting for what it fills in by itself", async () => {
    const result = await check([
      "#list has items",
      '#status contains "ready"',
      'type #task "Buy milk" then click #add -> #list contains "Buy milk"',
    ]);
    expect(result.error).toBeNull();
    expect(result.findings.filter((finding) => finding.problem.includes("plan's check"))).toEqual([]);
    expect(result.mismatches).toBeUndefined();
  }, 60_000);

  it("sends back a check that fails, with what the console said, and only notes one naming an element the page lacks", async () => {
    const result = await check(["click #clear -> #list changes", "#missing has items"]);
    const failed = result.findings.filter((finding) => finding.problem.includes("plan's check"));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.file).toBe("app.js");
    expect(failed[0]!.problem).toContain(
      "“click #clear -> #list changes” fails: clicking #clear didn't change #list",
    );
    expect(failed[0]!.problem).toContain("list.empty is not a function");
    expect(result.mismatches).toEqual(["“#missing has items” (app.js): the page has no #missing"]);
  }, 60_000);

  it("starts each check from nothing: what an earlier check saved in the browser is gone", async () => {
    // A list that saves itself and comes back on load: the second check would pass on the first one's item.
    const saving = {
      "index.html": `<!doctype html><html><body><ul id="list"></ul><input id="task"><button id="add">Add</button>
<script src="app.js"></script></body></html>`,
      "app.js": `document.addEventListener("DOMContentLoaded", () => {
  const list = document.getElementById("list");
  const saved = JSON.parse(localStorage.getItem("tasks") || "[]");
  const show = () => { list.textContent = ""; for (const t of saved) { const li = document.createElement("li"); li.textContent = t; list.appendChild(li); } };
  show();
  document.getElementById("add").addEventListener("click", () => {
    saved.push(document.getElementById("task").value);
    localStorage.setItem("tasks", JSON.stringify(saved));
    show();
  });
});`,
    };
    const result = await check(
      ['type #task "Buy milk" then click #add -> #list contains "Buy milk"', '#list contains "Buy milk"'],
      saving,
    );
    const failed = result.findings.filter((finding) => finding.problem.includes("plan's check"));
    expect(failed.map((finding) => finding.problem)).toEqual([
      expect.stringContaining('“#list contains "Buy milk"” fails: #list didn\'t show “Buy milk”'),
    ]);
  }, 60_000);

  it("stops when the project is stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(check(["#list has items"], TODO, stop.signal)).rejects.toThrow();
  }, 60_000);
});

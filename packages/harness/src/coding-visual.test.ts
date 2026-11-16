import { existsSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BROWSER_SETTINGS } from "@mrog/shared";

import {
  cleanTmp,
  codingTeam,
  finalChecksOf,
  makeCoding,
  THREE_FILES,
  tmp,
  type,
  until,
  visualChecksOf,
} from "./coding-testing";
import { auth, makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.services.browser.close();
  await h?.close();
  h = undefined;
  cleanTmp();
});

const startTeam = (team: ReturnType<typeof codingTeam>) =>
  makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });

/** Visual QA opens pages in the app's browser: hidden, in one profile, like the browser tests. */
const hiddenBrowser = (target: TestHarness) =>
  target.store.settings.set("browser", { ...DEFAULT_BROWSER_SETTINGS, show: false, profiles: "shared" });

const PAGE = {
  nodes: [
    { path: "index.html", purpose: "the task list page" },
    { path: "app.js", purpose: "adds tasks to the list" },
  ],
  edges: [{ files: ["index.html", "app.js"], description: "the page loads the script" }],
};

describe("Visual QA in the Coding Bot loop", () => {
  it("is off unless switched on, and then nothing extra runs", async () => {
    const team = codingTeam({ plans: [{ tool: PAGE }] });
    h = await startTeam(team);
    const { bot, project } = await makeCoding(h, tmp("out"), { autoApprove: true });
    expect(project.visualQa).toBe(false);
    await type(h, bot, "A task list");
    await until(h, bot.id, (p) => p.status === "done");
    expect(visualChecksOf(team)).toEqual([]);
  });

  it("runs after the check of the whole project, on top of it, and sends what QA saw back", async () => {
    const team = codingTeam({
      plans: [{ tool: PAGE }],
      visualCheck: (nth) =>
        nth === 1
          ? {
              ok: false,
              problems: [{ file: "app.js", comment: "Typed a task and clicked Add: the list stayed empty." }],
            }
          : { ok: true },
    });
    h = await startTeam(team);
    hiddenBrowser(h);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, visualQa: true });
    await type(h, bot, "A task list");
    const done = await until(h, bot.id, (p) => p.status === "done", 60_000);

    // Every check of the whole project came before its Visual QA, and each round had both.
    expect(finalChecksOf(team)).toHaveLength(2);
    const visual = visualChecksOf(team);
    expect(visual).toHaveLength(2);
    const firstVisual = team.seen.indexOf(visual[0]!);
    expect(team.seen.indexOf(finalChecksOf(team)[0]!)).toBeLessThan(firstVisual);
    expect(visual[0]!.task).toContain("How it runs: a web page, opened at index.html");
    expect(visual[0]!.tools).toEqual(
      expect.arrayContaining([
        "app_start",
        "screen_click",
        "app_console",
        "app_inspect",
        "finish_visual_check",
      ]),
    );
    expect(visual[0]!.tools).not.toContain("finish_check");
    expect(visual[0]!.tools).not.toContain("review_card");

    const script = done.cards.find((c) => c.title === "app.js")!;
    const said = script.comments.find((c) => c.author === "qa" && c.text.startsWith("Visual QA:"))!;
    expect(said).toMatchObject({
      kind: "fail",
      text: "Visual QA: Typed a task and clicked Add: the list stayed empty.",
    });
    const log = done.log!.map((l) => l.text);
    expect(log).toContain("Visual QA: a web page, opened at index.html (FreeBird serves the folder itself)");
    expect(log).toContain("Visual QA: all good");
  }, 90_000);

  it("doesn't take a verdict on an app QA never opened", async () => {
    const team = codingTeam({ plans: [{ tool: PAGE }], visualCheck: () => ({ start: false, ok: true }) });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, visualQa: true });
    await type(h, bot, "A task list");
    const failed = await until(h, bot.id, (p) => p.status === "error", 30_000);
    expect(visualChecksOf(team)).toHaveLength(3);
    expect(failed.error).toContain("Visual QA never got the app open after 3 tries");
    expect(failed.log!.map((l) => l.text)).toContain(
      "QA gave a Visual QA verdict without starting the app (or its start command was denied)",
    );
  }, 40_000);

  it("stops with why, instead of passing, when the browser can't open the app", async () => {
    const team = codingTeam({ plans: [{ tool: PAGE }], visualCheck: () => ({ ok: true }) });
    h = await startTeam(team);
    h.services.browser.goTo = async () => {
      throw new Error("No browser was found.");
    };
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, visualQa: true });
    await type(h, bot, "A task list");
    const failed = await until(h, bot.id, (p) => p.status === "error", 30_000);
    expect(visualChecksOf(team)).toHaveLength(1);
    expect(failed.error).toBe(
      "Visual QA couldn't open the app in the browser: No browser was found. Check Settings → Browser & search, or turn Visual QA off, then Resume.",
    );
    expect(failed.log!.map((l) => l.text)).not.toContain("Visual QA: all good");
  }, 40_000);

  it("skips a project with nothing to open", async () => {
    const team = codingTeam({ plans: [{ tool: THREE_FILES }] });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, visualQa: true });
    await type(h, bot, "Some helpers");
    const done = await until(h, bot.id, (p) => p.status === "done");
    expect(visualChecksOf(team)).toEqual([]);
    expect(done.log!.map((l) => l.text)).toContain(
      "Visual QA: the project has nothing with a screen to open, so there was nothing to test",
    );
  });

  it("can be switched on and off from the settings", async () => {
    const team = codingTeam();
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"));
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}/coding/settings`,
      headers: auth,
      payload: { visualQa: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ project: { visualQa: true, autoApprove: false } });
    expect(h.services.coding.get(bot.id)!.log!.at(-1)!.text).toBe("You turned Visual QA on");
  });
});

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const BROKEN_PAGE = `<!doctype html><html><body><input id="task"><button id="add">Add</button><ul id="list"></ul><script src="app.js"></script></body></html>`;
// Every id it uses is on the page, so the code checks pass, but the click handler is on the list, not the button:
// the classic "QA said all good" bug that only using the page shows.
const BROKEN_SCRIPT = `document.getElementById("list").addEventListener("click", () => {\n  const li = document.createElement("li");\n  li.textContent = document.getElementById("task").value;\n  document.getElementById("list").append(li);\n});\n`;
const FIXED_SCRIPT = `document.getElementById("add").addEventListener("click", () => {\n  const li = document.createElement("li");\n  li.textContent = document.getElementById("task").value;\n  document.getElementById("list").append(li);\n});\n`;

describe.skipIf(!existsSync(EDGE))("Visual QA in the loop, in a real browser", () => {
  it("catches a button that does nothing even when QA says all good, and passes once it is fixed", async () => {
    const team = codingTeam({
      plans: [{ tool: PAGE }],
      develop: (card, attempt) =>
        card.kind === "file"
          ? { write: card.key === "index.html" ? BROKEN_PAGE : BROKEN_SCRIPT }
          : attempt > 1
            ? { extras: [{ path: "app.js", content: FIXED_SCRIPT }] }
            : {},
      // QA never spots it itself: only the automatic part of Visual QA does.
      visualCheck: () => ({ ok: true }),
    });
    h = await startTeam(team);
    h.store.settings.set("browser", { ...DEFAULT_BROWSER_SETTINGS, show: false, profiles: "shared" });
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, visualQa: true });
    await type(h, bot, "A task list");
    const done = await until(h, bot.id, (p) => p.status === "done", 90_000);

    const connection = done.cards.find((c) => c.title === "index.html ↔ app.js")!;
    const found = connection.comments.find((c) => c.text.includes("does nothing when clicked"))!;
    expect(found).toMatchObject({ author: "qa", kind: "check" });
    expect(found.text).toContain("Visual QA: “Add” does nothing when clicked");
    expect(visualChecksOf(team).length).toBe(2);
    // The first Visual QA turn was told what the automatic checks found.
    expect(team.seen.find((s) => s.visual && s.lastTool.includes("does nothing"))).toBeDefined();
  }, 120_000);
});

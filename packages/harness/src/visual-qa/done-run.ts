import type { Page } from "playwright-core";

import { parseDoneCheck, selectorsOf, type DoneCheck } from "@mrog/shared";
import type { Finding } from "@mrog/visual-qa";

/**
 * Runs the plan's "done when" checks on the open page: each from a freshly loaded page, waiting a few seconds for it
 * to come true. A check that fails goes back to its file. A check whose element the page doesn't have at all is a
 * mismatch between the plan and the page, not a failure: it is only noted, since the Developer may have named the
 * element differently for a good reason and sending it back would go round in circles.
 */

export interface DoneFile {
  /** The planned file whose checks these are. */
  file: string;
  checks: string[];
}

export interface DoneResult {
  findings: Finding[];
  /** Checks that couldn't run because an element they name isn't on the page. */
  mismatches: string[];
}

/** How long a check waits to come true, and the most checks one run tries. */
export const DONE_WAIT_MS = 5000;
export const MAX_DONE_RUN = 12;

/*
 * What runs in the page, as script text (the harness has no DOM types, like ./page-checks). Selectors and text go in
 * as JSON strings, so nothing the plan says can break out of them.
 */
const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const element = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;

/** The element's text and an input's value, with case and spacing ignored; null when it isn't there. */
const textOf = (selector: string) =>
  `((el) => el ? ((el.innerText || el.textContent || "") + " " + (el.value ?? "")).replace(/\\s+/g, " ").trim().toLowerCase() : null)(${element(selector)})`;

const containsScript = (selector: string, text: string) =>
  `(${textOf(selector)} ?? "").includes(${JSON.stringify(norm(text))})`;

const hasItemsScript = (selector: string) => `((el) => !!el && el.children.length > 0)(${element(selector)})`;

/** What the element holds now, to tell whether a click changed it. */
const snapshotScript = (selector: string) =>
  `((el) => el ? el.innerHTML + "\\u0000" + (el.value ?? "") : null)(${element(selector)})`;

const changedScript = (selector: string, before: string | null) =>
  `((now) => now !== null && now !== ${JSON.stringify(before)})(${snapshotScript(selector)})`;

/** Runs one check on a page already loaded; why it failed, or null when it passed. */
async function runCheck(page: Page, check: DoneCheck, wait: number): Promise<string | null> {
  const options = { timeout: wait, polling: 100 } as const;
  const seconds = Math.round(wait / 1000);
  try {
    switch (check.kind) {
      case "has-items":
        await page.waitForFunction(hasItemsScript(check.target), undefined, options);
        return null;
      case "contains":
        await page.waitForFunction(containsScript(check.target, check.text), undefined, options);
        return null;
      case "click-changes": {
        // Let the page settle first, so what it fills in by itself isn't taken for the click's change.
        await page.waitForTimeout(300);
        const before = (await page.evaluate(snapshotScript(check.target))) as string | null;
        await page.click(check.click, { timeout: wait });
        await page.waitForFunction(changedScript(check.target, before), undefined, options);
        return null;
      }
      case "type-click-contains":
        await page.fill(check.input, check.typed, { timeout: wait });
        await page.click(check.click, { timeout: wait });
        await page.waitForFunction(containsScript(check.target, check.text), undefined, options);
        return null;
    }
  } catch (error) {
    const message = (error as Error).message.split("\n")[0] ?? "";
    if (/timeout/i.test(message)) {
      if (check.kind === "has-items")
        return `${check.target} still had no items ${seconds} seconds after the page opened`;
      if (check.kind === "click-changes")
        return `clicking ${check.click} didn't change ${check.target} within ${seconds} seconds`;
      if (check.kind === "contains")
        return `${check.target} didn't show “${check.text}” within ${seconds} seconds`;
      return `after typing into ${check.input} and clicking ${check.click}, ${check.target} didn't show “${check.text}” within ${seconds} seconds`;
    }
    return `the check couldn't run: ${message}`;
  }
}

/** What the page saved in the browser (localStorage, sessionStorage) is cleared, so each check starts from nothing. */
const CLEAR_STORAGE = "(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} })()";

/**
 * Opens the page as if for the first time: loaded, what it saved cleared, and loaded again. Without the clearing, an
 * item an earlier check added (or the automatic checks' clicks saved) would still be there, and a later check could
 * pass on old data.
 */
async function freshPage(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(CLEAR_STORAGE).catch(() => {});
  await page.goto(url, { waitUntil: "load" });
}

/**
 * Runs every file's checks, each from a fresh page (see freshPage). `consoleErrors` reads what the page logged as an
 * error meanwhile, so a check that failed because the script threw says what it threw. Stopped by `signal`.
 */
export async function runDoneChecks(
  page: Page,
  url: string,
  files: DoneFile[],
  options: { wait?: number; consoleErrors?: () => string[]; signal?: AbortSignal } = {},
): Promise<DoneResult> {
  const wait = options.wait ?? DONE_WAIT_MS;
  const findings: Finding[] = [];
  const mismatches: string[] = [];
  let ran = 0;
  for (const { file, checks } of files) {
    for (const written of checks) {
      if (ran >= MAX_DONE_RUN) return { findings, mismatches };
      options.signal?.throwIfAborted();
      const check = parseDoneCheck(written);
      if ("error" in check) continue;
      ran += 1;
      await freshPage(page, url);
      options.consoleErrors?.();
      const missing = await firstMissing(page, selectorsOf(check), wait);
      if (missing) {
        mismatches.push(`“${written}” (${file}): the page has no ${missing}`);
        continue;
      }
      const why = await runCheck(page, check, wait);
      if (!why) continue;
      const thrown = options.consoleErrors?.()[0];
      findings.push({
        file,
        problem: `The plan's check “${written}” fails: ${why}.${thrown ? ` The page's console said: ${thrown}.` : ""} Make the page do this.`,
      });
    }
  }
  return { findings, mismatches };
}

/** The first selector that no element on the page matches, even after waiting; null when all are there. */
async function firstMissing(page: Page, selectors: string[], wait: number): Promise<string | null> {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { state: "attached", timeout: wait });
    } catch {
      return selector;
    }
  }
  return null;
}

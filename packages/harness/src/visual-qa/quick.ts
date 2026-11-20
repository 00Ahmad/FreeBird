import { createHash } from "node:crypto";

import { mergeFindings, type Finding, type RunSpec } from "@mrog/visual-qa";

import type { BrowserManager } from "../browser";
import { runDoneChecks, type DoneFile } from "./done-run";
import { VisualSession } from "./session";

/**
 * Visual QA's quick check: the app opened in QA's tab and its automatic checks run (a crash on start, console errors,
 * files that fail to load, buttons that do nothing or are covered), with no model and nobody asked. It runs after every
 * development pass, so a page that breaks on load goes back to the Developer at once, instead of only after every card
 * has passed QA.
 */

/**
 * What the quick check can open by itself: a web page always (FreeBird serves the folder; nothing of the project
 * runs outside the browser), an app with its own server only when its start command may run unasked (Auto-approve).
 * A desktop app waits for the full Visual QA.
 */
export const quickCheckable = (run: RunSpec, commandsAllowed: boolean): boolean =>
  run.kind === "page" || (run.kind === "server" && commandsAllowed);

/** The planned files' text, so an unchanged project isn't opened again. */
export function filesPrint(files: { files: string[]; read(path: string): string | null }): string {
  const hash = createHash("sha1");
  for (const path of files.files.toSorted()) hash.update(`${path}\0${files.read(path) ?? ""}\0`);
  return hash.digest("hex");
}

export interface QuickCheckInput {
  browser: BrowserManager;
  /** The QA role bot, whose tab opens the app. */
  qaBotId: string;
  outputFolder: string;
  files: { files: string[]; read(path: string): string | null };
  run: RunSpec;
  refuse(rel: string): string | null;
  signal: AbortSignal;
  /** The plan's "done when" checks, run on the page once it is open (web pages only). */
  done?: DoneFile[];
}

export interface QuickCheckResult {
  findings: Finding[];
  error: string | null;
  /** Done checks naming an element the page doesn't have: noted, not sent back. */
  mismatches?: string[];
}

/** Opens the app, runs the automatic checks and closes it again. `error` says why it couldn't be opened. */
export async function quickVisualCheck(input: QuickCheckInput): Promise<QuickCheckResult> {
  const session = new VisualSession({
    browser: input.browser,
    botId: input.qaBotId,
    outputFolder: input.outputFolder,
    planned: input.files.files,
    run: input.run,
    read: input.files.read,
    refuse: input.refuse,
  });
  try {
    await session.start(input.signal);
    const error = session.browserError ?? (session.missing ? `${session.missing} isn't installed` : null);
    if (error) return { findings: [], error };
    if (!input.done?.length || input.run.kind !== "page" || !session.url)
      return { findings: session.auto, error };
    const page = await input.browser.tabOf(input.qaBotId);
    const done = await runDoneChecks(page, session.url, input.done, {
      signal: input.signal,
      consoleErrors: () =>
        input.browser
          .takeProblems(input.qaBotId)
          .flatMap((problem) =>
            problem.type === "error" || problem.type === "console" ? [problem.text] : [],
          ),
    });
    return {
      findings: mergeFindings(session.auto, done.findings),
      error,
      ...(done.mismatches.length > 0 ? { mismatches: done.mismatches } : {}),
    };
  } catch (error) {
    if (input.signal.aborted) throw error;
    return { findings: [], error: (error as Error).message };
  } finally {
    await session.stop();
  }
}

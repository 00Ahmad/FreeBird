import type { CodingCard, CodingProject } from "@mrog/shared";
import { detectRun, formatFindings, type RunSpec } from "@mrog/visual-qa";

import { checkProject, type CheckInput, type Finding } from "./coding-check";
import { doneFiles } from "./coding-done";
import { filesPrint, quickCheckable, type QuickCheckInput, type QuickCheckResult } from "./visual-qa/quick";

/**
 * The checks at the start of every QA pass, before any QA turn: plain code, no model, nobody asked.
 *  - The code check (`checkProject`): a page loading a script or stylesheet that isn't there, an import of something a
 *    file doesn't export, an element id a script looks for that no page has, a broken JSON file, a key that looks
 *    made up. Every project, every pass.
 *  - Visual QA's quick check (with Visual QA on): the app opened in QA's tab, its console read and its buttons tried.
 * What they find goes straight back to the card it belongs to, so the Developer fixes it in the same round instead of
 * after every card has passed QA's reading. A check that found something runs again next pass even if the files look
 * the same; one that came back clean is skipped until a file changes.
 */

export interface PassCheckDeps {
  project(botId: string): CodingProject;
  /** The planned files and a way to read them; `given` is the user's own text (the brief), for the key check. */
  files(project: CodingProject): CheckInput;
  /** The cards a finding goes back to: its file's, and those of the other files it spans. */
  cardsFor(project: CodingProject, file: string, related?: string[]): CodingCard[];
  /** Sends cards back with what is wrong; how many went back. */
  sendBack(
    botId: string,
    items: { card: CodingCard; text: string }[],
    round: number,
    source: string,
    kind: "check",
  ): number;
  note(botId: string, text: string): void;
  /** Visual QA's quick check: opens the app and runs the automatic checks. */
  openApp(input: Omit<QuickCheckInput, "browser" | "refuse">): Promise<QuickCheckResult>;
  /** Whether an app may be started with its own command (Auto-approve on, commands not set to never). */
  commandsAllowed(project: CodingProject): boolean;
}

/** The checks run at the start of each QA pass; `run` says how many cards they sent back. */
export function passChecks(deps: PassCheckDeps) {
  /** The files as each check last found them clean, by Coding Bot and check. */
  const clean = new Map<string, string>();

  /** Sends what a check found to its cards; notes what no card owns. How many cards went back. */
  const deliver = (botId: string, findings: Finding[], source: string, prefix: string): number => {
    const project = deps.project(botId);
    const items = findings.flatMap((finding) =>
      deps
        .cardsFor(project, finding.file, finding.related)
        .filter((card) => card.column !== "in_progress")
        .map((card) => ({ card, text: `${prefix}${finding.problem}` })),
    );
    const unowned = findings.filter(
      (finding) => deps.cardsFor(project, finding.file, finding.related).length === 0,
    );
    if (unowned.length > 0)
      deps.note(botId, `${source} found problems no card owns: ${clip(formatFindings(unowned), 200)}`);
    return items.length > 0 ? deps.sendBack(botId, items, project.round + 1, source, "check") : 0;
  };

  /** Whether this check found these exact files clean last time. */
  const unchanged = (key: string, print: string) => clean.get(key) === print;

  const codeCheck = (botId: string, files: CheckInput, print: string): number => {
    const key = `${botId}:code`;
    if (unchanged(key, print)) return 0;
    const findings = checkProject(files);
    if (findings.length === 0) {
      clean.set(key, print);
      return 0;
    }
    clean.delete(key);
    return deliver(botId, findings, "The code check", "Code check: ");
  };

  const visualCheck = async (
    botId: string,
    project: CodingProject,
    files: CheckInput,
    print: string,
    signal: AbortSignal,
  ): Promise<number> => {
    if (!project.visualQa) return 0;
    const run: RunSpec = detectRun({ ...files, python: process.platform === "win32" ? "python" : "python3" });
    if (!quickCheckable(run, deps.commandsAllowed(project))) return 0;
    const key = `${botId}:visual`;
    if (unchanged(key, print)) return 0;
    const { findings, error, mismatches } = await deps.openApp({
      qaBotId: project.roles.qa.botId,
      outputFolder: project.outputFolder,
      files,
      run,
      signal,
      done: doneFiles(project.nodes, (file) => files.read(file) !== null),
    });
    if (mismatches?.length)
      deps.note(
        botId,
        `Some of the plan's done checks name elements the page doesn't have, so they didn't run: ${clip(mismatches.join("; "), 300)}`,
      );
    if (error) {
      clean.delete(key);
      deps.note(botId, `Visual QA's quick check couldn't open the app: ${clip(error, 140)}`);
      return 0;
    }
    if (findings.length === 0) {
      clean.set(key, print);
      deps.note(botId, "Visual QA's quick check: the app opened and the automatic checks found nothing");
      return 0;
    }
    clean.delete(key);
    return deliver(botId, findings, "Visual QA's quick check", "Visual QA: ");
  };

  return {
    /** Runs both checks if a card is waiting for QA; how many cards they sent back. */
    async run(botId: string, signal: AbortSignal): Promise<number> {
      const project = deps.project(botId);
      if (!project.cards.some((card) => card.column === "qa")) return 0;
      const files = deps.files(project);
      const print = filesPrint(files);
      const code = codeCheck(botId, files, print);
      const visual = await visualCheck(botId, deps.project(botId), files, print, signal);
      return code + visual;
    },
    /** Forgets what a Coding Bot's checks found clean (a new plan). */
    forget(botId: string) {
      clean.delete(`${botId}:code`);
      clean.delete(`${botId}:visual`);
    },
  };
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

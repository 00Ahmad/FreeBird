import type { CodingProject } from "@mrog/shared";

import { describeRun, type RunSpec } from "./run";

/** Heading of QA's Visual QA job, which the tests (and the model) can recognise. */
export const VISUAL_QA_HEADING = "VISUAL QA OF THE WHOLE PROJECT";

/** The tools QA gets for Visual QA, by name: its hands and eyes on the running app, and its verdict. */
export const VISUAL_QA_TOOLS = {
  start: "app_start",
  open: "app_open",
  console: "app_console",
  inspect: "app_inspect",
  finish: "finish_visual_check",
} as const;

/** The screen tools QA borrows from the Visual Bot (each answers with a fresh screenshot). */
export const VISUAL_QA_SCREEN_TOOLS = [
  "screen_look",
  "screen_watch",
  "screen_click",
  "screen_click_at",
  "screen_type",
  "screen_press",
  "screen_scroll",
  "screen_back",
] as const;

export interface VisualQaMessageOptions {
  /** QA's model can see pictures. */
  vision: boolean;
  /** A try before this one ended without a verdict. */
  retry?: boolean;
}

const BREAK = "\n\n";

/** QA's Visual QA job, after every card passed and the checks of the whole project found nothing. */
export function visualQaMessage(
  project: CodingProject,
  run: RunSpec,
  options: VisualQaMessageOptions,
): string {
  const { start, console: consoleTool, inspect, finish, open } = VISUAL_QA_TOOLS;
  const files = project.nodes.map((node) => `- ${node.path}: ${node.purpose}`).join("\n");
  const verdict = `Then call ${finish}: ok true if everything you tried worked, or ok false with each problem as a planned file path and a comment saying what you did, what should have happened and what happened instead (the Developer sees nothing else).`;
  const steps =
    run.kind === "desktop"
      ? [
          `This is a desktop app. Visual QA can't click around in desktop windows yet, so it checks that the app starts, stays open and prints no errors. Call ${start} once. If it reports a problem, put it in your verdict.`,
          verdict,
        ]
      : [
          `1. Call ${start} first. It starts the app, opens it in your own browser tab and runs the automatic checks: errors in the browser console, files that failed to load, and buttons that do nothing when clicked or are covered by something. What it finds is sent back to the Developer anyway; you don't need to repeat it, but you may add to it.`,
          "2. Make a short test plan from the brief and the files: the main things a person would do with this app (for example: type a task, click Add, see the task in the list; tick it, see it marked done).",
          options.vision
            ? `3. Do each one like a person: look at the screenshot, click and type, and check the next screenshot shows what should happen. A button that should change something must change what you see. After each action, ${consoleTool} shows new errors in the browser (and the server's output), and ${inspect} tells you whether a control is visible, enabled, covered or has a click handler.`
            : `3. Your model can't see pictures, so judge by the screen map each action returns (the controls and their names) and by ${consoleTool} and ${inspect}: check that what should appear after an action is in the map. ${consoleTool} shows new errors in the browser (and the server's output); ${inspect} tells you whether a control is visible, enabled, covered or has a click handler.`,
          `4. Stay in the app: ${open} opens another of its pages by path. Don't go to other sites. Don't change any files.`,
          `5. ${verdict}`,
        ];
  return [
    VISUAL_QA_HEADING,
    `Project brief: ${project.brief}`,
    `Output folder: ${project.outputFolder}`,
    `The project's files:\n${files}`,
    `How it runs: ${describeRun(run)}.`,
    "Every card passed and the checks of the whole project found nothing, but nobody has used the app yet. Now test it the way a person uses it.",
    ...steps,
    options.retry ? `Your last try ended without calling ${finish}. Call it now.` : "",
  ]
    .filter(Boolean)
    .join(BREAK);
}

import { z } from "zod";

import type { Bot } from "@mrog/shared";
import { defineTool, safe, type Risk, type ToolResult, type ToolSpec } from "@mrog/tools";
import { VISUAL_QA_SCREEN_TOOLS, VISUAL_QA_TOOLS } from "@mrog/visual-qa";

import type { BrowserManager } from "../browser";
import { visualTools } from "../visual";
import { inspectMark } from "./page-checks";
import type { VisualSession } from "./session";

const SCREEN = new Set<string>(VISUAL_QA_SCREEN_TOOLS);

/**
 * A screen tool used on the app under test: on the app's own pages nothing can buy, send or change anything
 * outside the project, so a click there never asks (a todo app is all "Add", "Save" and "Delete"). Anywhere else it
 * asks exactly as a Visual Bot's would. Before app_start it refuses, with what to do instead.
 */
function onTheApp(spec: ToolSpec, session: VisualSession): ToolSpec {
  return {
    ...spec,
    risk: async (args, ctx) => {
      const own = (await spec.risk(args, ctx)) as Risk;
      return session.onApp() ? safe(own.summary) : own;
    },
    run: async (args, ctx) => {
      if (!session.origin) return `The app isn't open yet: call ${VISUAL_QA_TOOLS.start} first.`;
      const result = (await spec.run(args, ctx)) as ToolResult | string;
      if (session.onApp()) return result;
      const away = `\n\nYou are no longer on the app's pages. Go back with screen_back or ${VISUAL_QA_TOOLS.open}; don't test other sites.`;
      return typeof result === "string" ? result + away : { ...result, text: result.text + away };
    },
  };
}

/** QA's hands and eyes on the running app, and nothing else that reaches the web. */
export function visualQaTools(
  browser: BrowserManager,
  bot: Bot,
  session: VisualSession,
  folder: string,
): ToolSpec[] {
  const screen = visualTools(browser, bot, [])
    .filter((spec) => SCREEN.has(spec.name))
    .map((spec) => browser.guarded(bot.id, onTheApp(spec, session)));
  const command = session.commandLine();
  const own = [
    defineTool({
      name: VISUAL_QA_TOOLS.start,
      description:
        session.run.kind === "page"
          ? "Open the project's pages in your browser (FreeBird serves the folder itself) and run the automatic checks. Call it once, first."
          : session.run.kind === "desktop"
            ? "Start the desktop app, check it starts and stays open without errors, then close it. Call it once."
            : `Start the app (\`${command}\`), open it in your browser and run the automatic checks. Call it once, first. Give command only if that one is wrong for this project.`,
      args: z.object({
        command: z
          .string()
          .trim()
          .max(500)
          .optional()
          .describe("Only if the usual command is wrong for this project"),
      }),
      // Pages are only served and opened: nothing runs on this computer. Starting an app runs the team's code, so
      // it asks like any command QA runs.
      risk: (args): Risk => {
        const line = session.commandLine(args.command);
        return line
          ? {
              level: "ask",
              kind: "terminal",
              badges: [],
              summary: `${line}\n(in ${folder}, stopped after Visual QA)`,
            }
          : safe("Open the project's pages in the browser");
      },
      run: (args, ctx) => session.start(ctx.signal, args.command),
    }),
    defineTool({
      name: VISUAL_QA_TOOLS.open,
      description: "Open another page of the app by its path, like /about or settings.html.",
      args: z.object({ path: z.string().trim().min(1).max(500) }),
      risk: (args) => safe(`Open ${args.path} in the app`),
      run: (args) => session.open(args.path),
    }),
    defineTool({
      name: VISUAL_QA_TOOLS.console,
      description:
        "See new errors in the browser console and failed loads since the last check, and what the app printed (a server's errors).",
      args: z.object({}),
      risk: () => safe("Read the app's console"),
      run: async () => session.console(),
    }),
    defineTool({
      name: VISUAL_QA_TOOLS.inspect,
      description:
        "Inspect the control in numbered box N on the latest screenshot: whether it is shown and enabled, its size, whether something covers it, and whether anything handles a click on it.",
      args: z.object({ box: z.number().int().min(1) }),
      prepare: (args) => ({ box: args.box ?? args.ref ?? args.mark ?? args.number }),
      risk: (args) => safe(`Inspect box ${args.box}`),
      run: async (args) => {
        if (!session.origin) return `The app isn't open yet: call ${VISUAL_QA_TOOLS.start} first.`;
        return inspectMark(await browser.tabOf(bot.id), args.box);
      },
    }),
  ];
  // One action at a time in the tab, like every browser tool.
  return [...own.map((spec) => browser.guarded(bot.id, spec)), ...screen];
}

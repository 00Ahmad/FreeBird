import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ToolResult } from "@mrog/tools";
import {
  consoleFindings,
  controlFindings,
  formatFindings,
  launchFindings,
  mergeFindings,
  missingProgram,
  type Finding,
  type RunSpec,
} from "@mrog/visual-qa";

import type { BrowserManager } from "../browser";
import { answers, startApp, waitForServer, waitForWindow, type RunningApp } from "./launch";
import { checkControls, problemText } from "./page-checks";
import { serveFolder, type ServedFolder } from "./serve";

export interface VisualSessionOptions {
  browser: BrowserManager;
  /** The QA role bot: its own browser tab is the one used. */
  botId: string;
  outputFolder: string;
  /** The planned files, relative to the output folder. */
  planned: string[];
  run: RunSpec;
  /** A planned file's text, or null. */
  read(path: string): string | null;
  /** Why a file may not be served (it may hold secrets, it belongs to a tool), or null. */
  refuse(rel: string): string | null;
  /** How long a server may take to answer (longer when it installs first), and a desktop app to stay open. */
  timing?: { serverMs: number; installMs: number; windowMs: number };
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMING = { serverMs: 90_000, installMs: 300_000, windowMs: 8000 };

/** Every check that is running, so closing the app can stop what they started (an app's process tree holds its port). */
const running = new Set<VisualSession>();

/** Stops every running Visual QA check: for when FreeBird closes in the middle of one. */
export async function stopAllSessions(): Promise<void> {
  await Promise.all([...running].map((session) => session.stop()));
}

/**
 * One Visual QA check of a project: starts the app (or serves its pages), opens it in QA's tab, runs the automatic
 * checks once, and answers QA's console questions while it runs. `stop` ends everything it started; it is always
 * called, whatever happened.
 */
export class VisualSession {
  /** What the automatic checks found, without a model. */
  auto: Finding[] = [];
  /** The app's own origin once it is open in the browser. */
  origin: string | null = null;
  /** app_start has run (it starts the app once). */
  started = false;
  /** Why the browser couldn't open the app, if it couldn't. */
  browserError: string | null = null;
  /** A program the start command needs that this computer doesn't have (Python, Node…), if that's why it failed. */
  missing: string | null = null;
  private served: ServedFolder | null = null;
  private app: RunningApp | null = null;
  private disallow: (() => void) | null = null;
  /** How much of the app's output QA has seen. */
  private outputSeen = 0;
  private readonly timing: typeof DEFAULT_TIMING;

  constructor(private readonly options: VisualSessionOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
  }

  get run(): RunSpec {
    return this.options.run;
  }

  /** The command that starts the app, with its install first when the project needs one and it hasn't run. */
  commandLine(override?: string): string | null {
    const { run, outputFolder } = this.options;
    if (run.kind !== "server" && run.kind !== "desktop") return null;
    const command = override?.trim() || run.command;
    const install =
      run.install && !(run.install.startsWith("npm") && existsSync(join(outputFolder, "node_modules")))
        ? run.install
        : null;
    return install && !override ? `${install}; ${command}` : command;
  }

  /** The planned file of the page that is open: its HTML file, or the server's main file. */
  get pageFile(): string {
    const { run } = this.options;
    return run.kind === "page" ? run.entry : run.kind === "none" ? "" : run.main;
  }

  /** Whether QA's tab is on the app's own pages. */
  onApp(): boolean {
    const at = this.options.browser.addressOf(this.options.botId);
    if (!this.origin || !at) return false;
    try {
      return new URL(at).origin === this.origin;
    } catch {
      return false;
    }
  }

  /** Planned files the entry page names (the scripts and styles it loads), for a finding's related files. */
  private linked(): string[] {
    const page = this.pageFile;
    const text = this.options.read(page) ?? "";
    return this.options.planned.filter((path) => path !== page && text.includes(path.split("/").at(-1)!));
  }

  /** Starts the app and opens it, runs the automatic checks, and says what QA sees. */
  async start(signal: AbortSignal, override?: string): Promise<ToolResult> {
    if (this.started) return this.reopen("The app is already running.");
    this.started = true;
    running.add(this);
    const { run, outputFolder, planned } = this.options;
    if (run.kind === "none") return { text: "This project has nothing with a screen to open.", images: [] };
    if (run.kind === "desktop") {
      const app = (this.app = startApp(this.commandLine(override)!, outputFolder));
      const open = await waitForWindow(app, this.timing.windowMs, signal);
      this.missing = open ? null : missingProgram(app.output(), app.exitCode());
      if (this.missing) {
        await app.stop();
        return {
          text: `The app couldn't start: ${this.missing} isn't installed on this computer.`,
          images: [],
        };
      }
      this.auto = launchFindings(
        { started: open, exitCode: app.exitCode(), output: app.output() },
        planned,
        run.main,
      );
      await app.stop();
      return {
        text: [
          open
            ? `The app started and stayed open for ${Math.round(this.timing.windowMs / 1000)} seconds, then was closed.`
            : `The app stopped by itself (exit code ${app.exitCode()}).`,
          this.report(),
          `What it printed:\n${tail(app.output()) || "(nothing)"}`,
        ].join("\n\n"),
        images: [],
      };
    }
    let url: string;
    if (run.kind === "page") {
      this.served = await serveFolder(outputFolder, this.options.refuse);
      url = `${this.served.origin}/${run.entry.split("/").map(encodeURIComponent).join("/")}`;
    } else {
      const command = this.commandLine(override)!;
      // Something else already answering on the usual port (your own dev server, another project) isn't this app:
      // then only the address the app prints counts.
      const taken =
        run.port !== null && (await answers(`http://localhost:${run.port}/`, this.options.fetchImpl));
      const app = (this.app = startApp(command, outputFolder));
      const ready = await waitForServer(app, {
        port: taken ? null : run.port,
        timeoutMs: command.includes(";") ? this.timing.installMs : this.timing.serverMs,
        signal,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      });
      if (!ready.url) {
        this.missing = missingProgram(app.output(), app.exitCode());
        if (this.missing)
          return {
            text: `The app couldn't start: ${this.missing} isn't installed on this computer.`,
            images: [],
          };
        this.auto = launchFindings(
          { started: false, exitCode: app.exitCode(), output: app.output(), timedOut: ready.timedOut },
          planned,
          run.main,
        );
        return {
          text: [
            `The app didn't come up.`,
            this.report(),
            `What it printed:\n${tail(app.output()) || "(nothing)"}`,
          ].join("\n\n"),
          images: [],
        };
      }
      url = ready.url;
    }
    this.origin = new URL(url).origin;
    this.disallow = this.options.browser.allowHost(new URL(url).host);
    let look: ToolResult;
    try {
      look = await this.options.browser.goTo(this.options.botId, url);
    } catch (error) {
      this.browserError = (error as Error).message;
      return {
        text: `The browser couldn't open the app: ${this.browserError}\nCall finish_visual_check with what you know.`,
        images: [],
      };
    }
    const page = await this.options.browser.tabOf(this.options.botId);
    const context = {
      origin: this.origin,
      planned,
      page: this.pageFile,
      ...(run.kind === "server" ? { main: run.main } : {}),
    };
    this.auto = mergeFindings(
      this.app
        ? launchFindings({ started: true, exitCode: null, output: this.app.output() }, planned, this.pageFile)
        : [],
      consoleFindings(this.options.browser.takeProblems(this.options.botId), context),
      controlFindings(await checkControls(page), this.pageFile, this.linked()),
    );
    this.outputSeen = this.app?.output().length ?? 0;
    return {
      text: [`The app is open at ${url}.`, this.report(), look.text].join("\n\n"),
      images: look.images,
    };
  }

  private async reopen(said: string): Promise<ToolResult> {
    if (!this.origin) return { text: `${said} ${this.report()}`, images: [] };
    const look = await this.options.browser.look(this.options.botId);
    return { text: `${said}\n\n${look.text}`, images: look.images };
  }

  /** The automatic checks' result, for QA. */
  report(): string {
    return this.auto.length > 0
      ? `The automatic checks found problems; they go back to the Developer whatever you decide:\n${formatFindings(this.auto)}`
      : "The automatic checks found nothing wrong.";
  }

  /** Opens another page of the app, by path. */
  async open(path: string): Promise<ToolResult> {
    if (!this.origin) return { text: "The app isn't open: call app_start first.", images: [] };
    const target = new URL(path.startsWith("/") ? path : `/${path}`, this.origin);
    if (target.origin !== this.origin) return { text: "Only the app's own pages can be opened.", images: [] };
    return this.options.browser.goTo(this.options.botId, target.href);
  }

  /** New errors in the browser since the last look, and what the app printed since. */
  console(): string {
    const problems = this.options.browser.takeProblems(this.options.botId);
    const output = this.app?.output() ?? "";
    const fresh = output.slice(Math.min(this.outputSeen, output.length));
    this.outputSeen = output.length;
    return [
      problems.length > 0
        ? `Browser (since the last check):\n${problems.map((problem) => `- ${problemText(problem)}`).join("\n")}`
        : "Browser: no new errors since the last check.",
      ...(this.app
        ? [fresh.trim() ? `The app printed:\n${tail(fresh)}` : "The app printed nothing new."]
        : []),
      ...(this.app?.exited() ? [`The app has stopped (exit code ${this.app.exitCode()}).`] : []),
    ].join("\n\n");
  }

  /** Ends what was started: the app, the file server, the browser's access to them, QA's tab. */
  async stop(): Promise<void> {
    running.delete(this);
    this.disallow?.();
    this.disallow = null;
    await Promise.all([
      this.app?.stop().catch(() => {}),
      this.served?.close().catch(() => {}),
      this.origin ? this.options.browser.closeTab(this.options.botId).catch(() => {}) : undefined,
    ]);
    this.app = null;
    this.served = null;
  }
}

/** The last lines of some output, short enough for a model. */
function tail(text: string, chars = 3000): string {
  const trimmed = text.trim();
  return trimmed.length > chars ? `…${trimmed.slice(-chars)}` : trimmed;
}

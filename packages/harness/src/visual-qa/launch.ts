import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { commandEnv, killTree } from "@mrog/tools";

/** The last this much of what the app printed is kept. */
const MAX_OUTPUT = 32 * 1024;
/** How often a starting server is checked for an answer. */
const POLL_MS = 400;

/** An app started for Visual QA, running in the background until stopped. */
export interface RunningApp {
  /** The last of what it printed (both streams, in order). */
  output(): string;
  /** Its exit code once it stopped by itself; null while it runs. */
  exitCode(): number | null;
  exited(): boolean;
  /** Ends it and everything it started. */
  stop(): Promise<void>;
}

/** Colours and cursor moves that dev servers print. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/**
 * Starts `command` in `cwd` in the background (PowerShell on Windows, sh elsewhere), with the app's own settings kept
 * from it like any command's. It never opens a browser window by itself, and Python prints as it goes.
 */
export function startApp(command: string, cwd: string): RunningApp {
  const windows = process.platform === "win32";
  const env = commandEnv({
    BROWSER: "none",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    CI: "1",
  });
  const child = windows
    ? spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`,
        ],
        { cwd, env, windowsHide: true },
      )
    : spawn("/bin/sh", ["-c", command], { cwd, env, detached: true });
  let output = "";
  let code: number | null = null;
  let done = false;
  const collect = () => {
    const decoder = new StringDecoder("utf8");
    return (chunk: Buffer) => {
      output += decoder.write(chunk).replace(ANSI, "");
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
  };
  child.stdout?.on("data", collect());
  child.stderr?.on("data", collect());
  child.on("error", (error) => {
    output += `\n${error.message}`;
    done = true;
    code = code ?? 1;
  });
  child.on("exit", (exit) => {
    done = true;
    code = exit ?? 1;
  });
  let stopping: Promise<void> | null = null;
  return {
    output: () => output,
    exitCode: () => (done ? code : null),
    exited: () => done,
    stop: () =>
      (stopping ??= (async () => {
        if (child.pid) await killTree(child.pid, done);
        child.stdout?.destroy();
        child.stderr?.destroy();
      })()),
  };
}

/** A local address a dev server printed (Local: http://localhost:5173/), with 0.0.0.0 read as this computer. */
export function printedUrl(output: string): string | null {
  const matches = [
    ...output.matchAll(
      /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"'<>]*)?/gi,
    ),
  ];
  const last = matches.at(-1)?.[0];
  if (!last) return null;
  return last.replace("0.0.0.0", "127.0.0.1").replace(/[).,;]+$/, "");
}

/** Whether something answers HTTP at this address (any status counts: a 404 page is a server that is up). */
export async function answers(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    await response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export interface Readiness {
  /** The address it answers on, once it does. */
  url: string | null;
  /** It stopped before answering. */
  exited: boolean;
  /** Neither, in the time given. */
  timedOut: boolean;
}

/**
 * Waits for a started server to answer: on the address it prints, else on the port it usually uses. Ends early when
 * it stops by itself, and on Stop.
 */
export async function waitForServer(
  app: RunningApp,
  options: { port: number | null; timeoutMs: number; signal: AbortSignal; fetchImpl?: typeof fetch },
): Promise<Readiness> {
  const until = Date.now() + options.timeoutMs;
  while (Date.now() < until && !options.signal.aborted) {
    const printed = printedUrl(app.output());
    const candidates = [
      ...(printed ? [printed] : []),
      ...(options.port ? [`http://localhost:${options.port}/`, `http://127.0.0.1:${options.port}/`] : []),
    ];
    for (const url of candidates)
      if (await answers(url, options.fetchImpl)) return { url, exited: false, timedOut: false };
    if (app.exited()) return { url: null, exited: true, timedOut: false };
    await new Promise((wait) => setTimeout(wait, POLL_MS));
  }
  return { url: null, exited: app.exited(), timedOut: !app.exited() };
}

/** Waits a few seconds for a desktop app: still running at the end means it started and stayed open. */
export async function waitForWindow(app: RunningApp, ms: number, signal: AbortSignal): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && !signal.aborted && !app.exited())
    await new Promise((wait) => setTimeout(wait, Math.min(POLL_MS, Math.max(0, until - Date.now()))));
  return !app.exited();
}

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type OllamaStart = "running" | "started";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface Command {
  command: string;
  args: string[];
}

/** Ways to start Ollama on this machine, best first: the tray app where installed (so the user can quit it), else `ollama serve`. */
export function ollamaCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): Command[] {
  const commands: Command[] = [];
  if (platform === "win32") {
    const dirs = [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Ollama"),
      env.ProgramFiles && join(env.ProgramFiles, "Ollama"),
    ];
    for (const dir of dirs) {
      if (!dir) continue;
      if (exists(join(dir, "ollama app.exe")))
        commands.push({ command: join(dir, "ollama app.exe"), args: [] });
      if (exists(join(dir, "ollama.exe")))
        commands.push({ command: join(dir, "ollama.exe"), args: ["serve"] });
    }
  } else if (platform === "darwin" && exists("/Applications/Ollama.app")) {
    commands.push({ command: "open", args: ["-a", "Ollama"] });
  }
  commands.push({ command: "ollama", args: ["serve"] });
  return commands;
}

interface OllamaLauncherOptions {
  url: () => string;
  reachable: () => Promise<boolean>;
  onStarted?: () => void;
  spawn?: typeof nodeSpawn;
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** How long to wait for a started Ollama to answer. */
  waitMs?: number;
  /** Stops a process group (not on Windows); tests replace it. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Starts the local Ollama when it isn't running, and can stop it again when the app quits ("Stop Ollama when FreeBird
 * closes"). An Ollama the user started themselves is never stopped.
 */
export class OllamaLauncher {
  private pending: Promise<OllamaStart> | null = null;
  /** The process this app started, while it may still be running. */
  private startedPid: number | null = null;

  constructor(private readonly options: OllamaLauncherOptions) {}

  start(): Promise<OllamaStart> {
    this.pending ??= this.launch().finally(() => (this.pending = null));
    return this.pending;
  }

  /** Whether this app started the Ollama that is running. */
  get startedIt(): boolean {
    return this.startedPid !== null;
  }

  /**
   * Stops the Ollama this app started, with its server process (Windows: the tray app and the server it runs). Does
   * nothing when the user started Ollama, or on macOS, where it was opened through `open`. True when it tried.
   */
  stop(): boolean {
    const pid = this.startedPid;
    const platform = this.options.platform ?? process.platform;
    if (pid === null || platform === "darwin") return false;
    this.startedPid = null;
    try {
      if (platform === "win32") {
        const spawn = this.options.spawn ?? nodeSpawn;
        const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        child.on("error", () => {});
      } else (this.options.kill ?? process.kill)(-pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  /** Settles once a start that's under way has finished, or at once when none is. */
  settled(): Promise<void> {
    return this.pending
      ? this.pending.then(
          () => {},
          () => {},
        )
      : Promise.resolve();
  }

  private async launch(): Promise<OllamaStart> {
    const { reachable, spawn = nodeSpawn, exists = existsSync, env = process.env } = this.options;
    if (await reachable()) return "running";
    const url = new URL(this.options.url());
    if (!LOCAL_HOSTS.has(url.hostname))
      throw failure("ollama_remote", `Ollama runs on another computer (${url.host}); start it there.`);
    const host = `${url.hostname}:${url.port || "11434"}`;

    for (const { command, args } of ollamaCommands(this.options.platform ?? process.platform, env, exists)) {
      let failed = false;
      let pid: number | null = null;
      try {
        const child = spawn(command, args, {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          // Not the app's folder: a long-running Ollama would keep it locked (it couldn't be moved or renamed).
          cwd: homedir(),
          env: { ...env, OLLAMA_HOST: host },
        });
        child.on("error", () => (failed = true));
        child.unref();
        pid = child.pid ?? null;
      } catch {
        continue;
      }
      const deadline = Date.now() + (this.options.waitMs ?? 45_000);
      while (!failed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (await reachable()) {
          this.startedPid = pid;
          this.options.onStarted?.();
          return "started";
        }
      }
      if (!failed) throw failure("ollama_timeout", "Ollama was started but didn't answer within 45 seconds.");
    }
    throw failure("ollama_not_found", "Ollama isn't installed. Get it from ollama.com, then try again.");
  }
}

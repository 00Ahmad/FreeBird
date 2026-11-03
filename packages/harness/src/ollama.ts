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
}

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Starts the local Ollama when it isn't running. It is left running when the app quits, as if the user had
 * opened it, so a loaded model survives a restart of the app.
 */
export class OllamaLauncher {
  private pending: Promise<OllamaStart> | null = null;

  constructor(private readonly options: OllamaLauncherOptions) {}

  start(): Promise<OllamaStart> {
    this.pending ??= this.launch().finally(() => (this.pending = null));
    return this.pending;
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
      } catch {
        continue;
      }
      const deadline = Date.now() + (this.options.waitMs ?? 45_000);
      while (!failed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (await reachable()) {
          this.options.onStarted?.();
          return "started";
        }
      }
      if (!failed) throw failure("ollama_timeout", "Ollama was started but didn't answer within 45 seconds.");
    }
    throw failure("ollama_not_found", "Ollama isn't installed. Get it from ollama.com, then try again.");
  }
}

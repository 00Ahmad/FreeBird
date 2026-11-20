import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_OUTPUT = 64 * 1024;
const RETURN_CHARS = 16_000;
/** After a timeout or Stop, how long to wait for the output to end before giving up on it. */
const STOP_GRACE_MS = 1500;
/** The longest a timeout or Stop waits for the kill itself (finding children on Windows can take seconds). */
const KILL_WAIT_MS = 5000;

interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Ends a command and what it started. On Windows a tree whose top has already exited can't be found by taskkill,
 * so that command's own children are also looked up by their parent's id (the top may exit while taskkill runs).
 * Settles when the kill has run.
 */
export function killTree(pid: number, exited: boolean): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The whole group is gone already.
    }
    return Promise.resolve();
  }
  const script = `$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId); $seen = @{}; function Stop-Tree($id) { foreach ($p in $all | Where-Object { $_.ParentProcessId -eq $id }) { if ($seen[$p.ProcessId]) { continue }; $seen[$p.ProcessId] = $true; Stop-Tree $p.ProcessId; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }; Stop-Tree ${pid}`;
  const run = (file: string, args: string[]) =>
    new Promise<void>((resolve) => execFile(file, args, { windowsHide: true }, () => resolve()));
  const tree = exited ? Promise.resolve() : run("taskkill", ["/pid", String(pid), "/T", "/F"]);
  return tree.then(() => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]));
}

/**
 * The app's own settings (MROG_*: the access token, the data folder, the port) and the variables that make node
 * load code before it runs (NODE_OPTIONS, ELECTRON_RUN_AS_NODE). A command must not see any of them: with the token
 * it could drive the app's API like the user, and through the others it could slip code into a node it starts.
 */
const hiddenFromCommands = (name: string) => {
  const upper = name.toUpperCase();
  return (
    upper.startsWith("MROG_") ||
    upper.includes("_MROG_") ||
    upper === "ELECTRON_RUN_AS_NODE" ||
    upper === "NODE_OPTIONS"
  );
};

/** The environment a command runs with: this process's, without what it must not see, plus the secrets it was given. */
export function commandEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !hiddenFromCommands(name)) env[name] = value;
  return { ...env, ...extra };
}

/**
 * Runs a shell command (PowerShell on Windows, sh elsewhere), killing the whole tree on timeout or abort. A child
 * left running in the background can keep the output open; after a timeout or Stop the result comes back anyway.
 */
export function runShell(
  command: string,
  options: { cwd: string; timeoutMs: number; signal: AbortSignal; env?: Record<string, string> },
): Promise<CommandResult> {
  const windows = process.platform === "win32";
  const child = windows
    ? spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          // Windows PowerShell writes the console's old code page by default, which garbles anything not ASCII.
          `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`,
        ],
        {
          cwd: options.cwd,
          env: commandEnv(options.env),
          windowsHide: true,
        },
      )
    : spawn("/bin/sh", ["-c", command], {
        cwd: options.cwd,
        env: commandEnv(options.env),
        detached: true,
      });

  let output = "";
  // One decoder per stream, so a character split between two chunks stays whole.
  const collector = () => {
    const decoder = new StringDecoder("utf8");
    const add = (text: string) => {
      output += text;
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    return { write: (chunk: Buffer) => add(decoder.write(chunk)), end: () => add(decoder.end()) };
  };
  const stdout = collector();
  const stderr = collector();
  child.stdout.on("data", stdout.write);
  child.stderr.on("data", stderr.write);

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let exited = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal.removeEventListener("abort", stop);
      stdout.end();
      stderr.end();
      resolve({ exitCode, output, timedOut });
    };
    const stop = () => {
      if (settled || grace) return;
      // Something outside the tree may still hold the output open: stop reading it and answer, once the kill has
      // run (so the next command doesn't meet a child still busy in the folder) or it's taking too long.
      const answer = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode);
      };
      grace = setTimeout(answer, KILL_WAIT_MS);
      const killed = child.pid ? killTree(child.pid, exited) : Promise.resolve();
      void Promise.all([killed, new Promise((wait) => setTimeout(wait, STOP_GRACE_MS))]).then(answer);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    if (options.signal.aborted) stop();
    else options.signal.addEventListener("abort", stop, { once: true });
    child.on("exit", () => {
      exited = true;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.on("close", (exitCode) => finish(exitCode));
  });
}

export function formatCommandResult(result: CommandResult, timeoutSeconds: number): string {
  const text =
    result.output.length > RETURN_CHARS
      ? `…(earlier output cut)\n${result.output.slice(-RETURN_CHARS)}`
      : result.output;
  const status = result.timedOut
    ? `Timed out after ${timeoutSeconds}s and was stopped.`
    : `Exit code: ${result.exitCode}`;
  return `${text.trimEnd() || "(no output)"}\n\n${status}`;
}

/** A command name on its own: not part of a longer word or a parameter (so `Format-Table` isn't `format`). */
const commandNamed = (names: string) => new RegExp(`(?<![\\w-])(?:${names})(?![\\w-])`, "i");

/** Commands that delete, overwrite or reconfigure things get the "can't be undone" badge. */
const DESTRUCTIVE = [
  // Deleting, moving over, overwriting or emptying files; PowerShell's names and their aliases too.
  commandNamed(
    "rm|rmdir|rd|del|erase|ri|unlink|shred|truncate|dd|mv|move|mi|Remove-Item|Move-Item|Set-Content|sc|Clear-Content|clc|Out-File|Remove-ItemProperty|Clear-RecycleBin",
  ),
  // Disks.
  commandNamed("format|mkfs(?:\\.\\w+)?|diskpart|Format-Volume|Clear-Disk|Initialize-Disk"),
  // Ending programs, services or the computer.
  commandNamed(
    "kill|pkill|killall|taskkill|Stop-Process|spps|Stop-Service|shutdown|reboot|Restart-Computer|Stop-Computer",
  ),
  // git that throws work away or rewrites a remote's history (--force-with-lease checks first, so it doesn't count).
  /\bgit\s+(?:reset|clean|restore|checkout\s+(?:--|\.)(?=\s|$)|branch\s+-D\b|stash\s+(?:drop|clear)\b|push\b[^\n;|&]*\s(?:--force|-f)(?![\w-]))/i,
];

export function looksDestructive(command: string): boolean {
  return DESTRUCTIVE.some((pattern) => pattern.test(command));
}

export function looksSecuritySensitive(command: string): boolean {
  return /\b(passwd|chmod|chown|icacls|Set-ExecutionPolicy|reg(\.exe)?\s+(add|delete)|netsh|ssh-keygen|gpg|setx|sudo|runas)\b/i.test(
    command,
  );
}

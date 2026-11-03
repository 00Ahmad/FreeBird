// `pnpm dev`: harness + Vite + Electron with a fresh token. `pnpm dev:web`: harness + Vite only (open the URL in a browser).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = process.argv.includes("--web");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const token = randomBytes(32).toString("hex");
const harnessUrl = "http://127.0.0.1:8790";
const uiUrl = "http://127.0.0.1:5173";

const COLORS = { harness: 36, ui: 35, desktop: 33, dev: 32 };
const log = (name, line) => process.stdout.write(`\x1b[${COLORS[name]}m${name.padEnd(7)}\x1b[0m ${line}\n`);

const children = [];
let shuttingDown = false;

/**
 * Windows needs a shell to run pnpm.cmd; our args are fixed literals, so joining them is safe. Elsewhere each
 * child leads its own process group, so shutdown can signal the `tsx watch` and `vite` processes pnpm starts too.
 */
const pnpm = (args, options) =>
  isWindows
    ? spawn(`pnpm ${args.join(" ")}`, { ...options, shell: true })
    : spawn("pnpm", args, { ...options, detached: true });
const pnpmSync = (args, options) =>
  isWindows
    ? spawnSync(`pnpm ${args.join(" ")}`, { ...options, shell: true })
    : spawnSync("pnpm", args, options);

function run(name, args, env = {}) {
  const childEnv = { ...process.env, ...env, FORCE_COLOR: "1" };
  // Inherited from editors built on Electron (e.g. VS Code tooling); it would make Electron start as plain Node.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = pnpm(args, {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) log(name, line.replace(token, "<token>"));
    });
  }
  child.on("exit", (code) => {
    log("dev", `${name} exited (${code ?? "signal"})`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (isWindows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitFor(url, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  // Stop waiting once a child has exited and we're shutting down anyway.
  while (Date.now() < until && !shuttingDown) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!shuttingDown) throw new Error(`Timed out waiting for ${url}`);
}

run("harness", ["--filter", "@mrog/harness", "dev"], {
  MROG_TOKEN: token,
  MROG_PORT: "8790",
  MROG_DATA_DIR: join(root, ".data"),
  MROG_UI_ORIGINS: uiUrl,
  MROG_KEYRING_SERVICE: "FreeBird Dev",
  // Secrets saved before the rename move over on start.
  MROG_KEYRING_PREVIOUS: "OpenMrogBog Dev",
});
run("ui", ["--filter", "@mrog/ui", "dev"], { VITE_MROG_HARNESS_URL: harnessUrl, VITE_MROG_TOKEN: token });

try {
  await waitFor(`${harnessUrl}/api/health`);
  await waitFor(uiUrl);
} catch (error) {
  log("dev", String(error));
  shutdown(1);
}

if (shuttingDown) {
  // A child exited or the wait timed out: shutdown() is already under way.
} else if (web) {
  log("dev", `ready → open ${uiUrl}`);
} else {
  log("dev", "building desktop shell…");
  const built = pnpmSync(["--filter", "@mrog/desktop", "build"], { cwd: root, stdio: "inherit" });
  if (built.status !== 0) shutdown(1);
  else
    run("desktop", ["--filter", "@mrog/desktop", "start"], {
      MROG_UI_URL: uiUrl,
      MROG_HARNESS_URL: harnessUrl,
      MROG_TOKEN: token,
    });
}

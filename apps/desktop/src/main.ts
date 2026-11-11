import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";

import { READY_PREFIX, ReadyLine } from "@mrog/shared";

interface HarnessInfo {
  url: string;
  token: string;
}

/** Dev: `pnpm dev` runs the harness and Vite itself and tells us where. */
const DEV = process.env.MROG_UI_URL && process.env.MROG_HARNESS_URL && process.env.MROG_TOKEN;

let harness: HarnessInfo | null = null;
let harnessProcess: UtilityProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

const APP_NAME = "FreeBird";
/** The app's name before it was renamed; its data folder and saved secrets move over on first start. */
const PREVIOUS_NAME = "OpenMrogBog";

app.setName(APP_NAME);
moveDataFromPreviousName();

/**
 * %APPDATA%\OpenMrogBog\data → %APPDATA%\FreeBird\data, once, so bots, chats and settings come along. Only the data
 * folder moves: Electron has already made the new folder by now, and its caches rebuild themselves.
 */
function moveDataFromPreviousName() {
  const current = join(app.getPath("userData"), "data");
  const previous = join(app.getPath("appData"), PREVIOUS_NAME, "data");
  if (existsSync(current) || !existsSync(previous)) return;
  try {
    mkdirSync(dirname(current), { recursive: true });
    renameSync(previous, current);
  } catch (error) {
    // Still in use (the old app is open): start fresh rather than fail; the old folder stays as it was.
    console.warn(`[desktop] couldn't move ${previous}: ${(error as Error).message}`);
  }
}

/**
 * The port the harness used last time. The app's address (and so a routine's webhook address copied into another
 * service) only stays the same from one launch to the next if the harness gets the same port again.
 */
const lastPortFile = () => join(app.getPath("userData"), "last-port");

function readLastPort(): string | null {
  try {
    const port = Number(readFileSync(lastPortFile(), "utf8").trim());
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? String(port) : null;
  } catch {
    return null;
  }
}

function rememberPort(url: string) {
  try {
    const port = new URL(url).port;
    if (port && port !== readLastPort()) writeFileSync(lastPortFile(), port);
  } catch {
    // Without it the next launch just picks a new port.
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      dialog.showErrorBox(
        `${APP_NAME} couldn't start`,
        error instanceof Error ? error.message : String(error),
      );
      app.exit(1);
    });
}

async function start() {
  harness = DEV
    ? { url: process.env.MROG_HARNESS_URL!, token: process.env.MROG_TOKEN! }
    : await spawnHarness();

  ipcMain.on("mrog:harness", (event) => {
    // Only our own UI may read the token.
    event.returnValue = isAppUrl(event.senderFrame?.url ?? "") ? harness : null;
  });

  createWindow();
}

function uiOrigin(): string {
  return new URL(DEV ? process.env.MROG_UI_URL! : harness!.url).origin;
}

function isAppUrl(url: string): boolean {
  try {
    return new URL(url).origin === uiOrigin();
  } catch {
    return false;
  }
}

function createWindow() {
  // The installed app shows the icon built into its .exe; in dev the window gets it from build/.
  const devIcon = join(__dirname, "../build/icon.png");
  mainWindow = new BrowserWindow({
    ...(existsSync(devIcon) ? { icon: devIcon } : {}),
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#161614" : "#faf9f6",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // Microphone (dictation), notifications and clipboard for our own UI only; everything else is refused.
  const allowed = new Set(["media", "notifications", "clipboard-sanitized-write"]);
  mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(allowed.has(permission) && isAppUrl(contents.getURL()));
  });
  mainWindow.webContents.session.setPermissionCheckHandler(
    (_contents, permission, origin) => allowed.has(permission) && isAppUrl(origin),
  );
  mainWindow.on("closed", () => (mainWindow = null));

  // Links leave the app for the system browser; the window itself never navigates away from the UI.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    // A plain link to a web page (e.g. "Download Ollama") opens in the system browser.
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  void mainWindow.loadURL(DEV ? process.env.MROG_UI_URL! : harness!.url);
}

/** Packaged/production: run the bundled harness in an Electron utility process and wait for its ready line. */
function spawnHarness(): Promise<HarnessInfo> {
  const token = randomBytes(32).toString("hex");
  const uiDist = [join(process.resourcesPath, "ui"), join(__dirname, "../../ui/dist")].find((dir) =>
    existsSync(join(dir, "index.html")),
  );
  if (!uiDist) throw new Error("The built UI was not found. Run `pnpm build` first.");

  const child = utilityProcess.fork(join(__dirname, "harness.mjs"), [], {
    serviceName: `${APP_NAME} Harness`,
    stdio: "pipe",
    env: {
      ...process.env,
      MROG_TOKEN: token,
      MROG_PORT: "0",
      // The harness takes this one if it is free, and any other if not.
      ...(readLastPort() ? { MROG_PREFERRED_PORT: readLastPort()! } : {}),
      MROG_DATA_DIR: join(app.getPath("userData"), "data"),
      MROG_UI_DIST: uiDist,
      MROG_KEYRING_SERVICE: APP_NAME,
      MROG_KEYRING_PREVIOUS: PREVIOUS_NAME,
    },
  });
  harnessProcess = child;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("The harness did not start within 20 seconds.")),
      20_000,
    );
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith(READY_PREFIX)) continue;
        const ready = ReadyLine.parse(JSON.parse(line.slice(READY_PREFIX.length)));
        clearTimeout(timeout);
        rememberPort(ready.url);
        resolve({ url: ready.url, token });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("exit", (code) => {
      clearTimeout(timeout);
      harnessProcess = null;
      reject(new Error(`The harness exited (code ${code}).`));
      if (!quitting) {
        dialog.showErrorBox(
          `${APP_NAME} stopped`,
          `The background harness exited unexpectedly (code ${code}).`,
        );
        app.exit(1);
      }
    });
  });
}

app.on("window-all-closed", () => app.quit());

app.on("before-quit", (event) => {
  if (quitting || !harnessProcess) return;
  quitting = true;
  event.preventDefault();
  const child = harnessProcess;
  const force = setTimeout(() => child.kill(), 4_000);
  child.once("exit", () => {
    clearTimeout(force);
    app.quit();
  });
  child.postMessage("shutdown");
});

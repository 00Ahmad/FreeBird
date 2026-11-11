import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HarnessConfig {
  host: string;
  /** 0 picks a free port. */
  port: number;
  /**
   * Only with `port` 0: the port to take if it is free (the one the last run used, so a webhook address stays the
   * same); a random free port otherwise.
   */
  preferredPort?: number;
  /** Bearer token every /api request except /api/health must carry. */
  token: string;
  dataDir: string;
  /** Browser origins allowed to call the API (the dev UI server); same-origin needs no entry. */
  uiOrigins: string[];
  /** Built UI to serve at "/" (packaged app); null in dev, where Vite serves it. */
  uiDist: string | null;
  heartbeatMs: number;
  vault: "keyring" | "memory";
  keyringService: string;
  /** The keychain service secrets were saved under before the app was renamed; they move to `keyringService`. */
  previousKeyringService: string | null;
  /** Keep the on-disk record of events (`<data>/logs`, see eventlog.ts). `MROG_EVENT_LOG=off` turns it off. */
  eventLog: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** ~/.freebird, or the folder from before the app was renamed (~/.openmrogbog) when only that one exists. */
function defaultDataDir(): string {
  const current = join(homedir(), ".freebird");
  const previous = join(homedir(), ".openmrogbog");
  return !existsSync(current) && existsSync(previous) ? previous : current;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const host = env.MROG_HOST ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new Error(`MROG_HOST must be a loopback address, got ${host}`);
  const port = Number(env.MROG_PORT ?? 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`Invalid MROG_PORT: ${env.MROG_PORT}`);

  // A hint, never an error: a bad value is ignored and the app starts on a random port.
  const preferred = Number(env.MROG_PREFERRED_PORT);
  const preferredPort =
    Number.isInteger(preferred) && preferred > 0 && preferred <= 65_535 ? preferred : undefined;

  let token = env.MROG_TOKEN ?? "";
  if (!token) {
    token = randomBytes(32).toString("hex");
    console.warn("[harness] MROG_TOKEN not set; generated a one-off token for this run.");
  }

  return {
    host,
    port,
    ...(preferredPort ? { preferredPort } : {}),
    token,
    dataDir: resolve(env.MROG_DATA_DIR ?? defaultDataDir()),
    uiOrigins: (env.MROG_UI_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    uiDist: env.MROG_UI_DIST ? resolve(env.MROG_UI_DIST) : null,
    heartbeatMs: Number(env.MROG_HEARTBEAT_MS ?? 15_000),
    vault: env.MROG_VAULT === "memory" ? "memory" : "keyring",
    keyringService: env.MROG_KEYRING_SERVICE ?? "FreeBird",
    previousKeyringService: env.MROG_KEYRING_PREVIOUS ?? (env.MROG_KEYRING_SERVICE ? null : "OpenMrogBog"),
    eventLog: !/^(off|0|false|no)$/i.test(env.MROG_EVENT_LOG ?? ""),
  };
}

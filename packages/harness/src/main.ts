import { APP_VERSION, READY_PREFIX, type ReadyLine } from "@mrog/shared";

import { loadConfig, startHarness } from "./index";

const config = loadConfig();
const harness = await startHarness(config);

const ready: ReadyLine = { url: harness.url, version: APP_VERSION };
console.log(READY_PREFIX + JSON.stringify(ready));
console.log(`[harness] listening on ${harness.url} · data in ${config.dataDir}`);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[harness] ${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 5_000);
  force.unref();
  await harness.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// Electron utility processes get a `parentPort`; the desktop app asks us to shut down through it.
type ParentPort = { on(event: "message", listener: (message: { data?: unknown }) => void): void };
const parentPort = (process as { parentPort?: ParentPort }).parentPort;
parentPort?.on("message", (message) => {
  if (message.data === "shutdown") void shutdown("parent");
});

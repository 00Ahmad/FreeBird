import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { openStore, type SettingsRepo } from "@mrog/store";
import { KeyringBackend, MemoryBackend, moveSecrets, Vault, type NameIndex } from "@mrog/vault";

import { EventBus } from "./bus";
import type { HarnessConfig } from "./config";
import { EventLog } from "./eventlog";
import { buildServer } from "./server";
import { createServices } from "./services";

export { EventBus } from "./bus";
export { ModelCatalog } from "./catalog";
export { loadConfig, type HarnessConfig } from "./config";
export { buildServer, type RouteModule } from "./server";
export { createServices, type Services } from "./services";
export { ProviderManager } from "./providers";
export { TurnManager } from "./turns";

const VAULT_NAMES_KEY = "vault.names";

export function settingsNameIndex(settings: SettingsRepo): NameIndex {
  return {
    load: () => settings.get<string[]>(VAULT_NAMES_KEY) ?? [],
    save: (names) => settings.set(VAULT_NAMES_KEY, names),
  };
}

/**
 * Starts listening. With a random port wanted (0) and a preferred one known, tries that first and falls back to a
 * random free one if it can't be had, so a preference never stops the app from starting.
 */
export async function listenOn(
  app: FastifyInstance,
  config: Pick<HarnessConfig, "host" | "port" | "preferredPort">,
): Promise<string> {
  if (config.port === 0 && config.preferredPort) {
    try {
      return await app.listen({ host: config.host, port: config.preferredPort });
    } catch {
      // Busy, or not allowed here: any free port will do.
    }
  }
  return app.listen({ host: config.host, port: config.port });
}

/** How long closing waits for models to unload; the desktop app gives the harness 4 seconds in all. */
export const UNLOAD_ON_CLOSE_MS = 2_500;

export interface RunningHarness {
  url: string;
  close(): Promise<void>;
}

/** Opens storage and the vault, wires services, then listens. */
export async function startHarness(config: HarnessConfig): Promise<RunningHarness> {
  const store = openStore(join(config.dataDir, "app.db"));
  const { stopped, failed } = store.messages.recoverInterrupted();
  if (stopped) console.log(`[harness] marked ${stopped} interrupted message(s) as stopped`);
  if (failed)
    console.log(`[harness] ended ${failed} message(s) that were mid-action when the app closed, as errors`);
  const backend = config.vault === "memory" ? new MemoryBackend() : new KeyringBackend(config.keyringService);
  const names = settingsNameIndex(store.settings);
  // Secrets saved before the app was renamed (OpenMrogBog → FreeBird) move to the new keychain name.
  if (
    config.vault === "keyring" &&
    config.previousKeyringService &&
    config.previousKeyringService !== config.keyringService
  ) {
    const moved = moveSecrets(names.load(), new KeyringBackend(config.previousKeyringService), backend);
    if (moved)
      console.log(`[harness] moved ${moved} saved secret(s) from "${config.previousKeyringService}"`);
  }
  const vault = new Vault(backend, names);
  const bus = new EventBus();
  const services = createServices({ config, store, vault, bus });
  if (config.eventLog) {
    const log = new EventLog(bus, {
      dir: join(config.dataDir, "logs"),
      token: config.token,
      scrub: (line) => services.scrubber.scrub(line),
      threadIds: () => store.threads.list().map((thread) => thread.id),
    });
    log.start();
    // Last to go: whatever the other services publish while closing is still recorded.
    services.disposers.unshift(() => log.close());
  }
  const app = await buildServer(services);
  const url = await listenOn(app, config);
  // Connected apps' sign-ins come back here (the port is new each time the packaged app starts).
  services.connectors.setCallbackBase(url);
  services.routines.start();
  void services.connectors.connectAll();
  void services.browser.sweepProfiles();
  services.disposers.push(() => services.routines.stop());
  // Start Ollama if asked, then load the shared model in the background so the first message is fast.
  void (async () => {
    if (services.runtime.settings.startOllama) {
      const started = await services.ollamaLauncher
        .start()
        .catch((error: Error) => console.warn(`[harness] Ollama not started: ${error.message}`));
      if (started === "started") console.log("[harness] started Ollama");
    }
    await services.runtime.warmup();
  })().catch((error: Error) => console.warn(`[harness] warm-up skipped: ${error.message}`));
  return {
    url,
    async close() {
      // Free the memory the app's models hold, then stop the Ollama it started, as you chose in Settings → Local model.
      const { unloadOnClose, stopOllamaOnClose } = services.runtime.settings;
      if (unloadOnClose)
        await services.runtime.unloadUsed(UNLOAD_ON_CLOSE_MS).catch((error: Error) => {
          console.warn(`[harness] unloading models: ${error.message}`);
        });
      if (stopOllamaOnClose && services.ollamaLauncher.stop()) console.log("[harness] stopped Ollama");
      await app.close();
      store.close();
    },
  };
}

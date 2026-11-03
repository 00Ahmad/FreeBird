import { ModelRuntime, type RuntimeSettingsStore } from "@mrog/model-runtime";
import { OllamaProvider, ProviderRegistry } from "@mrog/providers";
import { DEFAULT_RUNTIME_SETTINGS, RuntimeSettings } from "@mrog/shared";
import type { SettingsRepo, Store } from "@mrog/store";
import type { Vault } from "@mrog/vault";

import { installAgent, type Agent } from "./agent";
import { BrowserManager } from "./browser";
import type { EventBus } from "./bus";
import { ModelCatalog } from "./catalog";
import { ComputerManager } from "./computer";
import { ConnectorManager } from "./connectors";
import { OllamaLauncher } from "./ollama";
import type { HarnessConfig } from "./config";
import { ProviderManager } from "./providers";
import { RoutineRunner } from "./routines";
import { installTeam } from "./team";
import { installDelegation } from "./delegation";
import { installDiscussions, type Discussions } from "./discussion";
import { installRaces, type Races } from "./race";
import { TurnManager } from "./turns";
import { VaultService } from "./vault";

export interface Services {
  config: HarnessConfig;
  store: Store;
  vault: Vault;
  bus: EventBus;
  registry: ProviderRegistry;
  runtime: ModelRuntime;
  ollamaLauncher: OllamaLauncher;
  catalog: ModelCatalog;
  turns: TurnManager;
  agent: Agent;
  providers: ProviderManager;
  routines: RoutineRunner;
  connectors: ConnectorManager;
  computer: ComputerManager;
  browser: BrowserManager;
  vaultService: VaultService;
  delegation: ReturnType<typeof installDelegation>;
  discussions: Discussions;
  races: Races;
  fetchImpl: typeof fetch;
  /** Cleanup hooks run on shutdown, in reverse order. */
  disposers: (() => void | Promise<void>)[];
}

const RUNTIME_KEY = "runtime";

/** Read on every request and queue change, so parsed once per save. */
function runtimeSettingsStore(settings: SettingsRepo): RuntimeSettingsStore {
  return {
    load: () =>
      settings.cached(RUNTIME_KEY, (saved) => {
        const parsed = RuntimeSettings.safeParse({
          ...DEFAULT_RUNTIME_SETTINGS,
          ...(saved as Partial<RuntimeSettings> | undefined),
        });
        return parsed.success ? parsed.data : DEFAULT_RUNTIME_SETTINGS;
      }),
    save: (next) => settings.set(RUNTIME_KEY, next),
  };
}

interface ServiceInput {
  config: HarnessConfig;
  store: Store;
  vault: Vault;
  bus: EventBus;
  fetchImpl?: typeof fetch;
}

export function createServices({ config, store, vault, bus, fetchImpl = fetch }: ServiceInput): Services {
  const runtimeStore = runtimeSettingsStore(store.settings);
  const registry = new ProviderRegistry();
  const ollama = new OllamaProvider("ollama", "Ollama", () => runtimeStore.load().ollamaUrl, fetchImpl);
  registry.register(ollama);
  const catalog = new ModelCatalog(registry);

  // Coalesce bursts of queue/settings changes into one status event.
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const runtime = new ModelRuntime(runtimeStore, ollama, () => {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      void runtime.status().then((status) => bus.publish({ type: "runtime.status", status }));
    }, 250);
  });

  const ollamaLauncher = new OllamaLauncher({
    url: () => runtimeStore.load().ollamaUrl,
    reachable: () =>
      ollama.version(AbortSignal.timeout(1_500)).then(
        () => true,
        () => false,
      ),
    onStarted: () => {
      catalog.invalidate();
      bus.publish({ type: "data.changed", keys: ["models"] });
      void runtime.status().then((status) => bus.publish({ type: "runtime.status", status }));
    },
  });

  const turns = new TurnManager({ store, bus, runtime, registry, catalog });
  // A message sent while the app is still starting Ollama waits for it instead of failing.
  turns.extensions.beforeModel = () => ollamaLauncher.settled();
  const services = {
    config,
    store,
    vault,
    bus,
    registry,
    runtime,
    ollamaLauncher,
    catalog,
    turns,
    fetchImpl,
    disposers: [() => clearTimeout(statusTimer), () => turns.stopAll()],
    agent: undefined as unknown as Agent,
    providers: undefined as unknown as ProviderManager,
    routines: new RoutineRunner({ store, bus, turns }),
    connectors: new ConnectorManager({ store, vault, bus }),
    computer: new ComputerManager({ store, bus }),
    browser: new BrowserManager({ store, bus, vault, config, fetchImpl }),
    vaultService: new VaultService({ store, vault, bus, turns }),
    delegation: undefined as unknown as ReturnType<typeof installDelegation>,
    discussions: undefined as unknown as Discussions,
    races: undefined as unknown as Races,
  } satisfies Services;
  services.agent = installAgent(services);
  services.providers = new ProviderManager(services, fetchImpl);
  services.providers.load();
  installTeam(services);
  services.delegation = installDelegation(services);
  services.discussions = installDiscussions(services);
  services.races = installRaces(services);
  services.agent.toolSources.push(() => services.connectors.toolSpecs());
  services.agent.toolSources.push((bot, thread, messageId, info) =>
    services.vaultService.tools(bot, info.surface?.threadId ?? thread.id, messageId),
  );
  services.agent.toolSources.push((bot) => services.computer.tools(bot));
  services.browser.logins = services.vaultService;
  services.agent.toolSources.push((bot) => services.browser.tools(bot));
  services.agent.promptSources.push((bot) => ({ extra: services.browser.prompt(bot) }));
  // A deleted bot's (or dismissed helper's) browser tab and computer go with it.
  services.disposers.push(
    bus.subscribe((event) => {
      if (event.type !== "bot.deleted") return;
      void services.browser.forget(event.botId);
      void services.computer.remove(event.botId);
    }),
  );
  services.disposers.push(() => services.browser.close());
  services.agent.envFor = (bot) => services.vaultService.envFor(bot);
  services.disposers.push(() => services.connectors.closeAll());
  return services;
}

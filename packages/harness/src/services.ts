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
import { SecretScrubber } from "./scrubber";
import { installTeam } from "./team";
import { installDelegation } from "./delegation";
import { installDiscussions, type Discussions } from "./discussion";
import { installRaces, type Races } from "./race";
import { TurnManager } from "./turns";
import { VaultService } from "./vault";
import type { WatchdogLimits } from "./watchdog";

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
  /** Takes the user's secret values out of tool results, errors and the event log. */
  scrubber: SecretScrubber;
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
  /** Silence limits for model requests (tests shorten them). */
  watchdog?: Partial<WatchdogLimits>;
}

export function createServices({
  config,
  store,
  vault,
  bus,
  fetchImpl = fetch,
  watchdog,
}: ServiceInput): Services {
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

  const turns = new TurnManager({ store, bus, runtime, registry, catalog, watchdog });
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
    scrubber: undefined as unknown as SecretScrubber,
    delegation: undefined as unknown as ReturnType<typeof installDelegation>,
    discussions: undefined as unknown as Discussions,
    races: undefined as unknown as Races,
  } satisfies Services;
  services.scrubber = new SecretScrubber(() => services.vaultService.secretValues());
  services.scrubber.refresh();
  // A secret saved, changed or removed (including a connected app's sign-in being renewed) is known at once.
  services.disposers.push(
    bus.subscribe((event) => {
      if (event.type === "secrets.changed" || (event.type === "data.changed" && event.keys.includes("vault")))
        services.scrubber.refresh();
    }),
  );
  const scrub = (text: string) => services.scrubber.scrub(text);
  turns.extensions.scrub = scrub;
  services.agent = installAgent(services);
  services.agent.scrub = scrub;
  services.connectors.scrub = scrub;
  services.providers = new ProviderManager(services, fetchImpl);
  services.providers.load();
  installTeam(services);
  services.delegation = installDelegation(services);
  services.discussions = installDiscussions(services);
  services.races = installRaces(services);
  services.agent.toolSources.push(() => services.connectors.toolSpecs());
  // A bot's access to each connected app narrows its tools through the same gates as everything else, so the Details
  // panel and the model always agree about what it has.
  services.agent.toolGates.push((bot, name) => services.connectors.gate(bot, name));
  services.agent.limitNotes.push((bot) => services.connectors.accessNote(bot));
  services.agent.describeApp = (name) => services.connectors.describe(name);
  // Kept app results go with their chat (Clear chat, a deleted chat) and with their bot.
  services.disposers.push(
    bus.subscribe((event) => {
      if (event.type === "thread.deleted") services.connectors.results.dropThread(event.threadId);
      else if (event.type === "data.changed" && event.threadId && event.keys.includes("messages"))
        services.connectors.results.dropThread(event.threadId);
      else if (event.type === "bot.deleted") services.connectors.results.dropBot(event.botId);
    }),
  );
  services.agent.toolSources.push((bot, thread, messageId, info) =>
    services.vaultService.tools(bot, info.surface?.threadId ?? thread.id, messageId),
  );
  services.agent.toolSources.push((bot) => services.computer.tools(bot));
  services.browser.logins = services.vaultService;
  services.agent.toolSources.push((bot) => services.browser.tools(bot));
  // The browser guidance names the browser's tools: a bot whose list turns them off isn't told it has them.
  services.agent.promptSources.push((bot) => ({
    extra: services.agent.allows(bot, bot.visual ? "screen_look" : "browser_open")
      ? services.browser.prompt(bot)
      : [],
  }));
  // A deleted bot's (or dismissed helper's) browser tab and computer go with it.
  services.disposers.push(
    bus.subscribe((event) => {
      // A race's or cluster's shared browser profile goes with its chat.
      if (event.type === "thread.deleted") void services.browser.forgetProfile(event.threadId);
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

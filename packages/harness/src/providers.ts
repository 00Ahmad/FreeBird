import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createProvider, isLocalUrl } from "@mrog/providers";
import {
  AddProviderInput,
  isSecretTooLong,
  PROVIDER_PRESETS,
  presetFor,
  ProviderConfig,
  providerKeyName,
  SECRET_TOO_LONG,
  UpdateProviderInput,
  type ProviderView,
} from "@mrog/shared";

import { attempt, fail, parse } from "./http";
import type { Services } from "./services";

const KEY = "providers";

/**
 * Whether a key is ever kept or sent for this kind of provider. A server on the user's own network (LM Studio, vLLM,
 * another Ollama) takes none, so a key typed for one is dropped rather than sent to that address on every request.
 */
const takesKey = (presetId: string): boolean => {
  const preset = presetFor(presetId);
  return !preset || preset.needsKey || preset.group === "custom";
};

/** Saved cloud/local providers beyond the built-in Ollama: registered live, keys in the keychain. */
export class ProviderManager {
  constructor(
    private readonly services: Pick<Services, "store" | "vault" | "registry" | "catalog" | "bus">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  configs(): ProviderConfig[] {
    const parsed = z.array(ProviderConfig).safeParse(this.services.store.settings.get(KEY) ?? []);
    return parsed.success ? parsed.data : [];
  }

  private save(configs: ProviderConfig[]) {
    this.services.store.settings.set(KEY, configs);
    this.services.catalog.invalidate();
    this.services.bus.publish({ type: "data.changed", keys: ["providers", "models"] });
  }

  private apiKey(id: string, presetId: string): () => string | null {
    return () => {
      if (!takesKey(presetId)) return null;
      try {
        return this.services.vault.get(providerKeyName(id));
      } catch {
        return null;
      }
    };
  }

  private register(config: ProviderConfig) {
    this.services.registry.unregister(config.id);
    if (config.enabled)
      this.services.registry.register(
        createProvider(config, this.apiKey(config.id, config.preset), this.fetchImpl),
      );
  }

  /** Registers every saved provider (at startup). */
  load(): void {
    for (const config of this.configs()) {
      try {
        this.register(config);
      } catch (error) {
        console.warn(`[providers] skipped ${config.id}: ${(error as Error).message}`);
      }
    }
  }

  view(config: ProviderConfig): ProviderView {
    const preset = presetFor(config.preset);
    return {
      ...config,
      hasKey: takesKey(config.preset) && this.services.vault.has(providerKeyName(config.id)),
      local: (preset?.local ?? false) || isLocalUrl(config.baseUrl),
      kind: preset?.kind ?? "openai",
    };
  }

  add(input: AddProviderInput): ProviderConfig {
    const preset = presetFor(input.preset);
    if (!preset) throw new Error(`Unknown provider type "${input.preset}".`);
    if (preset.needsBaseUrl && !input.baseUrl) throw new Error(`${preset.label} needs a base URL.`);
    if (preset.needsKey && !input.apiKey) throw new Error(`${preset.label} needs an API key.`);
    const taken = new Set([...this.configs().map((config) => config.id), "ollama"]);
    let id = preset.preset;
    for (let n = 2; taken.has(id); n++) id = `${preset.preset}-${n}`;
    const config: ProviderConfig = {
      id,
      preset: preset.preset,
      label: input.label ?? preset.label,
      baseUrl: input.baseUrl ?? "",
      enabled: true,
    };
    if (input.apiKey && takesKey(preset.preset)) this.services.vault.set(providerKeyName(id), input.apiKey);
    this.register(config);
    this.save([...this.configs(), config]);
    return config;
  }

  update(id: string, patch: UpdateProviderInput): ProviderConfig | null {
    const configs = this.configs();
    const current = configs.find((config) => config.id === id);
    if (!current) return null;
    const { apiKey, ...rest } = patch;
    const next = { ...current, ...rest };
    if (apiKey && takesKey(current.preset)) this.services.vault.set(providerKeyName(id), apiKey);
    this.register(next);
    this.save(configs.map((config) => (config.id === id ? next : config)));
    return next;
  }

  remove(id: string): boolean {
    const configs = this.configs();
    if (!configs.some((config) => config.id === id)) return false;
    this.services.registry.unregister(id);
    try {
      this.services.vault.delete(providerKeyName(id));
    } catch {
      // keychain unavailable: the entry is orphaned but harmless
    }
    this.save(configs.filter((config) => config.id !== id));
    return true;
  }

  /** Lists the provider's models; throws with the provider's own message when it can't. */
  async test(id: string): Promise<{ models: number }> {
    const provider = this.services.registry.get(id);
    if (!provider) throw new Error("This provider is turned off.");
    const models = await provider.listModels(AbortSignal.timeout(10_000));
    this.services.catalog.invalidate();
    return { models: models.length };
  }
}

export function registerProviderRoutes(app: FastifyInstance, services: Services, manager: ProviderManager) {
  app.get("/api/providers", async () => ({
    providers: manager.configs().map((config) => manager.view(config)),
    presets: PROVIDER_PRESETS,
  }));

  // Said in plain words here; the schema would only report an invalid request.
  const keyTooLong = (body: unknown) =>
    typeof (body as { apiKey?: unknown } | null)?.apiKey === "string" &&
    isSecretTooLong((body as { apiKey: string }).apiKey.trim());

  app.post("/api/providers", async (request, reply) => {
    if (keyTooLong(request.body)) return fail(reply, 400, "secret_too_long", SECRET_TOO_LONG);
    const input = parse(AddProviderInput, request.body, reply);
    if (!input) return reply;
    const config = await attempt(reply, () => manager.add(input), 400, "invalid_request");
    if (!config) return reply;
    return reply.code(201).send({ provider: manager.view(config) });
  });

  app.patch<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    if (keyTooLong(request.body)) return fail(reply, 400, "secret_too_long", SECRET_TOO_LONG);
    const input = parse(UpdateProviderInput, request.body, reply);
    if (!input) return reply;
    const config = manager.update(request.params.id, input);
    return config
      ? { provider: manager.view(config) }
      : fail(reply, 404, "not_found", "No provider has this id.");
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    return manager.remove(request.params.id)
      ? reply.code(204).send()
      : fail(reply, 404, "not_found", "No provider has this id.");
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/test", async (request, reply) => {
    const result = await attempt(reply, () => manager.test(request.params.id), 502, "provider_error");
    return result ?? reply;
  });

  app.get("/api/usage", async () => {
    const localIds = new Set(
      services.registry
        .list()
        .filter((provider) => provider.local)
        .map((provider) => provider.id),
    );
    return { bots: services.store.messages.usageByBot(), localProviders: [...localIds] };
  });
}

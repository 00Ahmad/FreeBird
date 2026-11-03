import type { ProviderRegistry } from "@mrog/providers";
import type { ModelInfo } from "@mrog/shared";

interface CatalogSnapshot {
  models: ModelInfo[];
  errors: { providerId: string; message: string }[];
}

/** Models from every provider, cached briefly so each turn doesn't re-list them. */
export class ModelCatalog {
  private cache: { at: number; snapshot: CatalogSnapshot } | null = null;
  private inflight: Promise<CatalogSnapshot> | null = null;
  /** Bumped by invalidate() and forced refreshes: a load started before then never fills the cache. */
  private generation = 0;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly ttlMs = 30_000,
  ) {}

  invalidate(): void {
    this.cache = null;
    this.inflight = null;
    this.generation += 1;
  }

  async all(force = false): Promise<CatalogSnapshot> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.snapshot;
    // A forced refresh (e.g. a model that was just pulled) doesn't settle for a load that began before it.
    if (force) this.invalidate();
    if (!this.inflight) {
      const load = this.load(this.generation).finally(() => {
        if (this.inflight === load) this.inflight = null;
      });
      this.inflight = load;
    }
    return this.inflight;
  }

  private async load(generation: number): Promise<CatalogSnapshot> {
    const providers = this.registry.list();
    const results = await Promise.allSettled(
      providers.map(async (provider) => ({
        provider,
        models: await provider.listModels(AbortSignal.timeout(8_000)),
      })),
    );
    const snapshot: CatalogSnapshot = { models: [], errors: [] };
    results.forEach((result, index) => {
      if (result.status === "fulfilled") snapshot.models.push(...result.value.models);
      else
        snapshot.errors.push({
          providerId: providers[index]?.id ?? "?",
          message: (result.reason as Error).message,
        });
    });
    if (generation === this.generation) this.cache = { at: Date.now(), snapshot };
    return snapshot;
  }

  /** One model's info; refreshes once if the ref is unknown (e.g. just pulled). */
  async info(ref: string): Promise<ModelInfo | null> {
    const found = (await this.all()).models.find((model) => model.ref === ref);
    if (found) return found;
    return (await this.all(true)).models.find((model) => model.ref === ref) ?? null;
  }
}

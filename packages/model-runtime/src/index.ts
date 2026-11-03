import { ProviderError, type OllamaProvider } from "@mrog/providers";
import { parseModelRef, RuntimeSettings, type LoadedModel, type RuntimeStatus } from "@mrog/shared";

export interface RuntimeSettingsStore {
  load(): RuntimeSettings;
  save(settings: RuntimeSettings): void;
}

/** User chat beats routines; routines beat background jobs (titles, memory, routing). */
export type Priority = "user" | "routine" | "background";
const RANK: Record<Priority, number> = { user: 0, routine: 1, background: 2 };

interface Waiter {
  rank: number;
  seq: number;
  grant(release: () => void): void;
}

/**
 * One local model serves every bot. This keeps it loaded (same options on every request, keep_alive, warm-up)
 * and lets at most `parallel` turns use it at once, queueing the rest by priority.
 */
export class ModelRuntime {
  private running = 0;
  private readonly waiting: Waiter[] = [];
  private seq = 0;

  constructor(
    private readonly store: RuntimeSettingsStore,
    readonly ollama: OllamaProvider,
    private readonly onChange: () => void = () => {},
  ) {}

  get settings(): RuntimeSettings {
    return this.store.load();
  }

  /** Validates and saves; reloads the shared model when an option that affects loading changed. */
  update(patch: Partial<RuntimeSettings>): RuntimeSettings {
    const before = this.settings;
    const next = RuntimeSettings.parse({ ...before, ...patch });
    this.store.save(next);
    if (next.parallel > before.parallel) this.pump();
    const reload =
      next.sharedModel !== before.sharedModel ||
      next.numCtx !== before.numCtx ||
      next.keepAlive !== before.keepAlive;
    if (reload) void this.warmup().catch(() => {});
    this.onChange();
    return next;
  }

  /** The options every local request carries; changing them would make Ollama reload the model. */
  localOptions(): { numCtx: number; keepAlive: string } {
    const { numCtx, keepAlive } = this.settings;
    return { numCtx, keepAlive };
  }

  /** Name of the shared model when it lives on this runtime's Ollama, else null. */
  sharedLocalModel(): string | null {
    const ref = this.settings.sharedModel;
    if (!ref) return null;
    const { providerId, model } = parseModelRef(ref);
    return providerId === this.ollama.id ? model : null;
  }

  async warmup(signal?: AbortSignal): Promise<boolean> {
    const model = this.sharedLocalModel();
    if (!model) return false;
    await this.run("background", () => this.ollama.warm(model, this.localOptions(), signal), { signal });
    this.onChange();
    return true;
  }

  /** Waits for a free slot. The returned function releases it (safe to call twice). */
  acquire(
    priority: Priority,
    options: { signal?: AbortSignal; onQueued?: () => void } = {},
  ): Promise<() => void> {
    const { signal, onQueued } = options;
    if (signal?.aborted) return Promise.reject(new ProviderError("aborted", "Stopped."));
    if (this.running < this.settings.parallel && this.waiting.length === 0) {
      this.running += 1;
      this.onChange();
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        rank: RANK[priority],
        seq: this.seq++,
        grant: (release) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(waiter);
        if (at !== -1) this.waiting.splice(at, 1);
        this.onChange();
        reject(new ProviderError("aborted", "Stopped."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
      this.waiting.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
      onQueued?.();
      this.onChange();
    });
  }

  async run<T>(
    priority: Priority,
    fn: () => Promise<T>,
    options: { signal?: AbortSignal; onQueued?: () => void } = {},
  ): Promise<T> {
    const release = await this.acquire(priority, options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
      this.pump();
      this.onChange();
    };
  }

  private pump() {
    while (this.running < this.settings.parallel && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.running += 1;
      next.grant(this.releaser());
    }
  }

  queueState(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  async status(): Promise<RuntimeStatus> {
    const settings = this.settings;
    let version: string | null = null;
    let loaded: LoadedModel[] = [];
    try {
      const signal = AbortSignal.timeout(2_000);
      version = await this.ollama.version(signal);
      loaded = await this.ollama.ps(signal);
    } catch {
      // unreachable: reported below
    }
    return {
      ollama: { reachable: version !== null, version, url: settings.ollamaUrl },
      loaded,
      settings,
      queue: this.queueState(),
    };
  }
}

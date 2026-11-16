import { ProviderError, type OllamaProvider } from "@mrog/providers";
import { parseModelRef, RuntimeSettings, type LoadedModel, type RuntimeStatus } from "@mrog/shared";

export interface RuntimeSettingsStore {
  load(): RuntimeSettings;
  save(settings: RuntimeSettings): void;
}

/** User chat beats routines; routines beat background jobs (titles, memory, routing). */
export type Priority = "user" | "routine" | "background";
const RANK: Record<Priority, number> = { user: 0, routine: 1, background: 2 };

/**
 * Every this long a request has waited, it counts as one rank more urgent. Without it, a busy conversation keeps a
 * routine or a background job off the model for as long as the conversation lasts.
 */
export const AGING_MS = 60_000;

interface Waiter {
  rank: number;
  seq: number;
  /** When it joined the queue (the runtime's clock). */
  since: number;
  grant(release: () => void): void;
}

/**
 * Several requests of ONE turn that share a single slot on the model (a Parallel Bots turn whose three roles each
 * search and write on their own). The turn counts as one bot at once: the slot is taken when the first request starts
 * and given back when the last one ends, so while every role waits for a search the model is free for others. At most
 * `lanes` requests are in flight together.
 *
 * Why the slots exist at all: one local model serves every bot, and a second bot's request must not make Ollama swap
 * the model out (or fight over its memory). Requests to the SAME model are safe to overlap: Ollama runs them side by
 * side up to its own OLLAMA_NUM_PARALLEL and queues the rest, which only makes them wait. Nothing else gets the model
 * meanwhile, because the group holds its slot, so no other model is ever loaded in the middle of it.
 */
export class RequestGroup {
  private inflight = 0;
  private free: number;
  private readonly waiting: { grant(): void; reject(error: unknown): void }[] = [];
  private held: Promise<() => void> | null = null;
  /** The slot's releaser once it was granted, so the last request can hand it back at once. */
  private heldRelease: (() => void) | null = null;

  /**
   * @param takeSlot  takes the turn's slot on the model (null for a model that has none, like a cloud one)
   * @param lanes     the most requests in flight together
   */
  constructor(
    private readonly takeSlot: (() => Promise<() => void>) | null,
    readonly lanes: number,
  ) {
    this.free = Math.max(1, lanes);
  }

  /** Requests in flight right now. */
  get active(): number {
    return this.inflight;
  }

  /** Waits for a place among the lanes and for the group's slot. The returned function ends the request. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    await this.takePlace(signal);
    this.inflight += 1;
    // Requests that start together share one attempt at the slot.
    if (this.inflight === 1 && this.takeSlot)
      this.held = this.takeSlot().then((release) => ((this.heldRelease = release), release));
    const slot = this.held;
    try {
      if (slot) await slot;
    } catch (error) {
      this.leave();
      throw error;
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.leave();
    };
  }

  private takePlace(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new ProviderError("aborted", "Stopped."));
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(waiter);
        if (at !== -1) this.waiting.splice(at, 1);
        reject(new ProviderError("aborted", "Stopped."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private leave() {
    this.inflight -= 1;
    const next = this.waiting.shift();
    if (next) next.grant();
    else this.free += 1;
    if (this.inflight === 0 && this.held) {
      const slot = this.held;
      const release = this.heldRelease;
      this.held = null;
      this.heldRelease = null;
      if (release) release();
      else
        void slot.then(
          (late) => late(),
          () => {},
        );
    }
  }
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
    private readonly timing: { agingMs?: number; now?: () => number } = {},
  ) {}

  /**
   * Whether a local model (by its name in Ollama) is still set for some bot, so switching away from it elsewhere mustn't
   * unload it. The harness fills this in from the bots' own models.
   */
  inUse: (model: string) => boolean = () => false;

  get settings(): RuntimeSettings {
    return this.store.load();
  }

  /** The model's name in this runtime's Ollama, or null for a cloud model or none. */
  localName(ref: string | null | undefined): string | null {
    if (!ref) return null;
    const { providerId, model } = parseModelRef(ref);
    return providerId === this.ollama.id ? model : null;
  }

  /**
   * Unloads a local model nothing uses any more: not the shared model, not a bot's own model. It waits its turn in the
   * queue, so a reply still being written on it finishes first. True when an unload was queued.
   */
  release(ref: string | null | undefined): boolean {
    const name = this.localName(ref);
    if (!name || name === this.sharedLocalModel() || this.inUse(name)) return false;
    void this.run("background", () => this.ollama.unload(name)).catch(() => {});
    return true;
  }

  /**
   * Called with a slot held, just before a request to the local model `name`: with "One local model at a time" on,
   * the other models this app loaded are unloaded first, so only one sits in memory. Skipped while other requests run
   * (with "Bots at once" above 1 they may be using those models). The models it unloaded.
   */
  async swapTo(name: string, signal?: AbortSignal): Promise<string[]> {
    if (!this.settings.oneModelAtATime || this.running > 1) return [];
    const others = this.ollama.usedModels().filter((other) => other !== name);
    for (const other of others) await this.ollama.unload(other, signal).catch(() => {});
    if (others.length > 0) this.onChange();
    return others;
  }

  /**
   * Unloads the local models this app loaded that nothing is set to use any more (not the shared model, not any
   * bot's or team role's own model), after any model change anywhere. Each waits its turn in the queue. The names.
   */
  releaseUnused(): string[] {
    const shared = this.sharedLocalModel();
    const unused = this.ollama.usedModels().filter((name) => name !== shared && !this.inUse(name));
    for (const name of unused) void this.run("background", () => this.ollama.unload(name)).catch(() => {});
    return unused;
  }

  /**
   * Unloads every local model this app loaded, for when it closes. Gives up after `timeoutMs` so closing stays quick;
   * the models' keep-alive frees them later anyway. The names it tried.
   */
  async unloadUsed(timeoutMs: number): Promise<string[]> {
    const names = this.ollama.usedModels();
    if (names.length === 0) return [];
    const signal = AbortSignal.timeout(timeoutMs);
    await Promise.race([
      Promise.allSettled(names.map((name) => this.ollama.unload(name, signal))),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
    return names;
  }

  /** Validates and saves; reloads the shared model when an option that affects loading changed. */
  update(patch: Partial<RuntimeSettings>): RuntimeSettings {
    const before = this.settings;
    const next = RuntimeSettings.parse({ ...before, ...patch });
    this.store.save(next);
    if (next.parallel > before.parallel) this.pump();
    // A new shared model: the old one is unloaded first (two models rarely fit a small GPU), then the new one loaded.
    if (next.sharedModel !== before.sharedModel) this.release(before.sharedModel);
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
        since: this.now(),
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
      onQueued?.();
      this.onChange();
    });
  }

  /**
   * A group of requests that make one turn's single slot (see RequestGroup). `local` false is a model with no slot
   * (a cloud one): the group then only limits how many requests are in flight together.
   */
  group(
    priority: Priority,
    options: { lanes: number; local: boolean; signal?: AbortSignal; onQueued?: () => void },
  ): RequestGroup {
    return new RequestGroup(
      options.local
        ? () => this.acquire(priority, { signal: options.signal, onQueued: options.onQueued })
        : null,
      options.lanes,
    );
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

  private now(): number {
    return (this.timing.now ?? Date.now)();
  }

  /**
   * Who goes next: the most urgent, where a request that has waited gets more urgent with time but never beyond a
   * user's chat; first come first served among equals. Looked at when a slot frees up, since it changes as they wait.
   */
  private takeNext(): Waiter {
    const aging = this.timing.agingMs ?? AGING_MS;
    const now = this.now();
    const urgency = (waiter: Waiter) =>
      Math.max(0, waiter.rank - Math.floor(Math.max(0, now - waiter.since) / aging));
    let best = 0;
    for (let i = 1; i < this.waiting.length; i++) {
      const a = this.waiting[i]!;
      const b = this.waiting[best]!;
      if (urgency(a) < urgency(b) || (urgency(a) === urgency(b) && a.seq < b.seq)) best = i;
    }
    return this.waiting.splice(best, 1)[0]!;
  }

  private pump() {
    while (this.running < this.settings.parallel && this.waiting.length > 0) {
      const next = this.takeNext();
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

import { ProviderError, type ChatProvider, type StreamChunk } from "@mrog/providers";

export interface WatchdogLimits {
  /** How long the model may take to send its first chunk (a cold local model loads and reads the whole prompt). */
  firstChunkMs: number;
  /**
   * How long it may stay silent between chunks. Generous on purpose: some runtimes send a long tool call (a whole
   * file to write) only once it is complete, and a slow local model can take minutes to produce it.
   */
  idleMs: number;
}

/** For a provider in the cloud: a reply that hasn't started in 5 minutes, or stops for 3, is not coming. */
export const DEFAULT_WATCHDOG: WatchdogLimits = { firstChunkMs: 5 * 60_000, idleMs: 3 * 60_000 };

/**
 * For a model on this computer, which is silent for long stretches while working: loading, then reading a prompt of
 * tens of thousands of tokens on a CPU or a partly offloaded GPU can take more than five minutes before the first
 * word, and a runtime that sends a tool call only once it is complete (a long file to write) can stay quiet for
 * minutes at a few tokens a second. Ending that early throws the work away, and a retry repeats it, which is worse
 * than waiting. Here the watchdog only guards against a connection that has died.
 */
export const LOCAL_WATCHDOG: WatchdogLimits = { firstChunkMs: 20 * 60_000, idleMs: 10 * 60_000 };

/** The limits for a provider; anything set explicitly (tests, a setting) wins over the defaults. */
export function watchdogLimits(local: boolean, override: Partial<WatchdogLimits> = {}): WatchdogLimits {
  return { ...(local ? LOCAL_WATCHDOG : DEFAULT_WATCHDOG), ...override };
}

const span = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} minute(s)` : `${Math.max(1, Math.round(ms / 1000))} second(s)`;

/**
 * Ends a model request that has gone silent, with a `stalled` error instead of waiting for ever (a hung runtime,
 * a dropped connection that never closes).
 *
 * It wraps the provider itself, so every request a turn makes is covered: the steps, the history summary, the plan
 * question and the closing reply. For a local model it must sit *inside* the queue for the shared model, so the time
 * a request waits for its turn is not counted as silence.
 *
 * It never touches the turn's own signal. The request gets its own, so ending a silent request is not mistaken for
 * the user pressing Stop (which is recorded as "stopped", not as an error).
 */
export function withWatchdog(provider: ChatProvider, override: Partial<WatchdogLimits> = {}): ChatProvider {
  const { firstChunkMs, idleMs } = watchdogLimits(provider.local, override);
  return {
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    local: provider.local,
    listModels: (signal) => provider.listModels(signal),
    async *chat(request) {
      const inner = new AbortController();
      const signal = request.signal ? AbortSignal.any([request.signal, inner.signal]) : inner.signal;
      const iterator = provider.chat({ ...request, signal })[Symbol.asyncIterator]();

      let started = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stalled: ProviderError | undefined;
      let fail: (error: ProviderError) => void = () => {};
      const stall = new Promise<never>((_, reject) => (fail = reject));
      // Between chunks nobody is waiting on it when it fires; that must not be an unhandled rejection.
      stall.catch(() => {});

      const arm = () => {
        const ms = started ? idleMs : firstChunkMs;
        clearTimeout(timer);
        timer = setTimeout(() => {
          // The user's Stop is the turn's business, and is recorded as "stopped".
          if (request.signal?.aborted) return;
          stalled = new ProviderError(
            "stalled",
            started
              ? `${provider.label} went quiet for ${span(ms)} in the middle of a reply, so I stopped waiting. Try again, or pick a faster model.`
              : `${provider.label} didn't start replying within ${span(ms)}, so I stopped waiting. Check that the model is running and try again.`,
          );
          fail(stalled);
          inner.abort();
        }, ms);
        timer.unref?.();
      };

      try {
        for (;;) {
          // Counted only while waiting for the provider: time the turn spends handling a chunk is not silence.
          arm();
          let next: IteratorResult<StreamChunk>;
          try {
            next = await Promise.race([iterator.next(), stall]);
          } catch (error) {
            // Whatever the adapter threw when its request was aborted (often "aborted"), the cause was the stall.
            throw stalled ?? error;
          }
          clearTimeout(timer);
          if (next.done) {
            // An adapter that swallows the abort ends its stream quietly: still a stall, not a finished reply.
            if (stalled) throw stalled;
            return;
          }
          started = true;
          yield next.value;
        }
      } finally {
        clearTimeout(timer);
        // Don't wait for a stream that is stuck: ending it is best effort, and aborting its request ends it.
        inner.abort();
        void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
      }
    },
  };
}

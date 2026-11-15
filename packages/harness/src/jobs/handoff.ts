/**
 * A page only you can get past (a CAPTCHA, a sign-in): the scan waits for you to press Continue or Skip. No model turn
 * is running while it waits, so nothing holds the model, and after HANDOFF_LIMIT_MS without an answer the page is
 * skipped so a scan left alone can't wait for ever.
 */
export const HANDOFF_LIMIT_MS = 10 * 60_000;

export type HandoffAnswer = "continue" | "skip";

export function createHandoffs(limitMs = () => HANDOFF_LIMIT_MS) {
  const waiting = new Map<string, (answer: HandoffAnswer | "timeout") => void>();

  /** Waits for your answer for this Job Bot; "timeout" after the limit. Rejects when the scan is stopped. */
  const wait = (botId: string, signal: AbortSignal) =>
    new Promise<HandoffAnswer | "timeout">((resolve, reject) => {
      const finish = (answer: HandoffAnswer | "timeout") => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        waiting.delete(botId);
        resolve(answer);
      };
      const abort = () => {
        clearTimeout(timer);
        waiting.delete(botId);
        reject(signal.reason instanceof Error ? signal.reason : new Error("stopped"));
      };
      if (signal.aborted) return abort();
      const timer = setTimeout(() => finish("timeout"), limitMs());
      signal.addEventListener("abort", abort, { once: true });
      waiting.set(botId, finish);
    });

  /** Your answer; false when the bot isn't waiting for one. */
  const answer = (botId: string, action: HandoffAnswer) => {
    const resolve = waiting.get(botId);
    if (!resolve) return false;
    resolve(action);
    return true;
  };

  return { wait, answer, isWaiting: (botId: string) => waiting.has(botId) };
}

export type Handoffs = ReturnType<typeof createHandoffs>;

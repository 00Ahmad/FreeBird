import { useSyncExternalStore } from "react";

let current = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  // The first reader starts the clock, and everyone reads the same time.
  if (!timer) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const quiet = () => () => {};
const snapshot = () => current;

/**
 * The time in milliseconds, updated once a second while `ticking`, from one shared clock (not a timer per reader).
 * When not ticking it stops: nothing re-renders, and the value is the last one seen.
 */
export function useNow(ticking: boolean): number {
  return useSyncExternalStore(ticking ? subscribe : quiet, snapshot);
}

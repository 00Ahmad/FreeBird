/** Chats opened before and after the current one, for Back / Forward (Cmd/Ctrl+[ and ]). */
export interface History {
  back: string[];
  forward: string[];
}

const LIMIT = 50;

/** Opening `next` from `current`: the current chat goes on the back list, and forward is forgotten. */
export function visit(history: History, current: string | null, next: string | null): History {
  if (next === current) return history;
  return {
    back: current ? [...history.back, current].slice(-LIMIT) : history.back,
    forward: [],
  };
}

/** One step back or forward, skipping chats that were deleted since; null when there's nowhere to go. */
export function step(
  history: History,
  current: string | null,
  direction: "back" | "forward",
  exists: (threadId: string) => boolean,
): { history: History; target: string } | null {
  const from = direction === "back" ? history.back.slice() : history.forward.slice();
  const to = direction === "back" ? history.forward.slice() : history.back.slice();
  let target: string | undefined;
  while ((target = from.pop()) !== undefined && (target === current || !exists(target)));
  if (target === undefined) return null;
  if (current) to.push(current);
  return {
    target,
    history: direction === "back" ? { back: from, forward: to } : { back: to, forward: from },
  };
}

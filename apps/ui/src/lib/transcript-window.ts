/**
 * Which messages of a long chat are drawn. Drawing every message of a long chat makes each new reply, each scroll and
 * each re-render do work for hundreds of rows nobody is looking at, so only the newest are drawn, and earlier ones
 * are drawn as the user scrolls up to them.
 *
 * The window is kept by the id of its first message, not by a count. New replies are added at the bottom, so a count
 * would slide the window and take a row off the top while the user is reading there: the page would jump. With an id,
 * the window only grows.
 */

/** Messages drawn when a chat opens. */
export const WINDOW_SIZE = 120;
/** Messages added each time the user reaches the top of what is drawn. */
export const WINDOW_STEP = 120;

/**
 * The index of the first message to draw.
 *
 * `startId` is where the window began last time (null the first time). If that message is gone (the chat was
 * cleared, or history was reloaded) the window starts again at the newest `size`. Whatever is in `mustShow` (the
 * first unread message, say) is included: the window is widened to reach it.
 */
export function windowStart(
  ids: readonly string[],
  startId: string | null,
  size: number,
  mustShow: readonly (string | null)[] = [],
): number {
  const known = startId === null ? -1 : ids.indexOf(startId);
  let start = known === -1 ? Math.max(0, ids.length - size) : known;
  for (const id of mustShow) {
    const at = id === null ? -1 : ids.indexOf(id);
    if (at !== -1 && at < start) start = at;
  }
  return start;
}

/** The index to start from after showing `step` more messages above the ones drawn now. */
export const revealFrom = (start: number, step: number) => Math.max(0, start - step);

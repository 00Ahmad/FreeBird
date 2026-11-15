import type { JobReader } from "@mrog/shared";

import type { PageRead } from "./page";
import { fold } from "./text";

/**
 * The reading ladder's rules, cheapest reader first: a job system's own list, the page as text, the bot's browser,
 * the Visual Bot, then you. Code decides when to step down, never a model. The readers themselves live in the
 * harness; these rules only judge what a reader brought back.
 */
export const READER_ORDER: readonly JobReader[] = ["api", "text", "browser", "visual", "you"];

/** Less text than this is a page that hasn't really loaded (a JavaScript shell, a cookie wall). */
export const MIN_PAGE_CHARS = 500;

export type Verdict =
  | { kind: "ok" }
  /** Try the next reader. */
  | { kind: "step_down"; reason: string }
  /** Only you can get past this (a CAPTCHA, a sign-in). */
  | { kind: "needs_you"; reason: string }
  /** The page doesn't exist: no reader will do better. */
  | { kind: "gone"; reason: string };

const NEEDS_SCRIPT =
  /enable javascript|javascript (is )?(required|disabled)|turn on javascript|requires javascript/;
const COOKIE_WALL = /accept (all )?cookies|cookie (consent|preferences|settings)|we use cookies/;
const SIGN_IN_WALL =
  /(sign|log) ?in to (view|see|apply|continue)|join (now )?to (view|see)|create an account to (view|see)/;

/** What to do with what a reader brought back. */
export function judge(page: PageRead): Verdict {
  if (page.status === 404 || page.status === 410) return { kind: "gone", reason: "the page doesn't exist" };
  if (page.humanCheck) return { kind: "needs_you", reason: "The site wants a human check (a CAPTCHA)." };
  const text = fold(page.text);
  if (SIGN_IN_WALL.test(text) && text.length < 2000)
    return { kind: "needs_you", reason: "The site wants you to sign in to see this page." };
  if (page.scriptRendered)
    return { kind: "step_down", reason: "the page builds its content with JavaScript" };
  if (text.length < MIN_PAGE_CHARS)
    return { kind: "step_down", reason: `only ${text.length} characters of text` };
  if (NEEDS_SCRIPT.test(text) && text.length < 3000)
    return { kind: "step_down", reason: "the page needs JavaScript" };
  if (COOKIE_WALL.test(text) && text.length < 1500)
    return { kind: "step_down", reason: "a cookie banner covers the page" };
  return { kind: "ok" };
}

/**
 * The readers to try for a page, in order. A site whose note says a costlier reader was needed starts there, so the
 * cheap ones that failed last time aren't tried again; `api` is only tried when a job system handles the address.
 */
export function readersFor(options: { api: boolean; noted?: JobReader; visual: boolean }): JobReader[] {
  const order = READER_ORDER.filter(
    (reader) => (reader !== "api" || options.api) && (reader !== "visual" || options.visual),
  );
  const noted = options.noted;
  if (!noted || noted === "api" || noted === "you") return order;
  const from = order.indexOf(noted);
  return from > 0 ? order.slice(from) : order;
}

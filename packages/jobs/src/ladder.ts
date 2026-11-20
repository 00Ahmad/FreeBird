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

/** Text enough for a small business's picture-led home page, read in the browser (see `judge`'s `minChars`). */
export const SHORT_PAGE_CHARS = 120;

/**
 * What to do with what a reader brought back. `minChars`: the least text that counts as loaded, for a page read in
 * the browser (a small business's home page is often a few lines under its pictures; a job posting never is). Seen as
 * text, a short page may still be a script shell, so the usual limit stays.
 */
export function judge(page: PageRead, options: { minChars?: number } = {}): Verdict {
  if (page.status === 404 || page.status === 410) return { kind: "gone", reason: "the page doesn't exist" };
  if (page.humanCheck) return { kind: "needs_you", reason: "The site wants a human check (a CAPTCHA)." };
  // An error page ("Access denied", "Too many requests") is often long enough to look loaded: the next reader may get
  // the real page, and if none does, no model reads the error.
  if (page.status !== undefined && page.status >= 400)
    return { kind: "step_down", reason: `the site answered HTTP ${page.status}` };
  // A job system's own data is never a half-loaded page: a small company's list of three jobs is short, not a shell.
  if (page.reader === "api" && (page.links.length > 0 || page.text.trim().length > 0)) return { kind: "ok" };
  const text = fold(page.text);
  if (SIGN_IN_WALL.test(text) && text.length < 2000)
    return { kind: "needs_you", reason: "The site wants you to sign in to see this page." };
  if (page.scriptRendered)
    return { kind: "step_down", reason: "the page builds its content with JavaScript" };
  const rendered = page.reader === "browser" || page.reader === "visual" || page.reader === "you";
  const least = rendered && options.minChars !== undefined ? options.minChars : MIN_PAGE_CHARS;
  if (text.length < least) return { kind: "step_down", reason: `only ${text.length} characters of text` };
  if (NEEDS_SCRIPT.test(text) && text.length < 3000)
    return { kind: "step_down", reason: "the page needs JavaScript" };
  if (COOKIE_WALL.test(text) && text.length < 1500)
    return { kind: "step_down", reason: "a cookie banner covers the page" };
  return { kind: "ok" };
}

/** A site note older than this is ignored, so the cheaper readers get another try. */
export const SITE_NOTE_DAYS = 30;

/** Whether a site note is still worth following. */
export const freshNote = (at: string, now: Date) =>
  now.getTime() - Date.parse(at) < SITE_NOTE_DAYS * 86_400_000;

/**
 * The readers to try for a page, in order. A site whose note says a costlier reader was needed starts there, so the
 * cheap ones that failed last time aren't tried again; but a job system's own list (`api`) is always tried first when
 * one handles the address, since one failed request there says nothing about the next.
 */
export function readersFor(options: { api: boolean; noted?: JobReader; visual: boolean }): JobReader[] {
  const order = READER_ORDER.filter(
    (reader) => (reader !== "api" || options.api) && (reader !== "visual" || options.visual),
  );
  const noted = options.noted;
  if (!noted || noted === "api" || noted === "you") return order;
  const from = order.indexOf(noted);
  if (from <= 0) return order;
  return options.api ? ["api", ...order.slice(from)] : order.slice(from);
}

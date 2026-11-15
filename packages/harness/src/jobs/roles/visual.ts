import type { RoleSpec } from "./types";

/**
 * The fallback reader: called by code only when reading the page as text and in the browser both failed. The bot
 * opens the page in its tab first, so this role never types an address; it has no typing, no keys and no hand-off
 * (Enter can submit a form; a CAPTCHA goes to the user through the bot, not through this role).
 */
export const visual: RoleSpec = {
  role: "visual",
  name: "Visual helper",
  avatar: { shape: "leaf", color: "violet" },
  tools: ["screen_look", "screen_scroll", "screen_click", "screen_back"],
  visual: true,
  rules: [
    "You are the Visual helper of a Job Bot. A job page is already open in your tab; another way of reading it failed.",
    "Make the jobs (or the one job's full details) visible: close a cookie banner or pop-up, click 'Load more', 'Show all jobs' or 'Show more', scroll down.",
    "Never type, never sign in, never apply, never submit or send anything, and never go to another site. If the page wants a sign-in or a human check, stop and say so.",
    "When the jobs or the job details are visible, stop and reply 'Done' with one short sentence.",
  ].join(" "),
};

export function visualTask(url: string, why: string): string {
  return [
    `The page ${url} is open in your tab. Reading it another way failed: ${why}.`,
    "Make its jobs, or the job's full details, visible on the screen, then stop.",
  ].join("\n");
}

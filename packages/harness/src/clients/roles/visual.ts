import type { RoleSpec } from "./types";

/** The fallback reader, called by code only when the text and browser readers both failed. No typing, no keys. */
export const visual: RoleSpec = {
  role: "visual",
  name: "Visual helper",
  avatar: { shape: "leaf", color: "violet" },
  tools: ["screen_look", "screen_scroll", "screen_click", "screen_back"],
  visual: true,
  rules: [
    "You are the Visual helper of a Client Bot. A company's page is already open in your tab; another way of reading it failed.",
    "Make the page's content visible: close a cookie banner or pop-up, click 'Show more', scroll down.",
    "Never type, never sign in, never submit or send anything, and never go to another site. If the page wants a sign-in or a human check, stop and say so.",
    "When the content is visible, stop and reply 'Done' with one short sentence.",
  ].join(" "),
};

export function visualTask(url: string, why: string): string {
  return [
    `The page ${url} is open in your tab. Reading it another way failed: ${why}.`,
    "Make its content visible on the screen, then stop.",
  ].join("\n");
}

import { z } from "zod";

/** Where web_search gets results: the bots' own browser (no key needed), or a search API. */
export const SearchProvider = z.enum(["browser", "brave", "searxng"]);
export type SearchProvider = z.infer<typeof SearchProvider>;

export const BrowserSettings = z.object({
  /** Browser tools are offered to bots. */
  enabled: z.boolean(),
  /** Show the window so you can watch the bots and take over; off runs it hidden. */
  show: z.boolean(),
  /** Which installed browser to drive. */
  channel: z.enum(["msedge", "chrome"]),
  search: SearchProvider,
  /** Your SearXNG instance, e.g. http://127.0.0.1:8888. */
  searxngUrl: z.string().url().nullable(),
  /** Name of the secret (Settings → Secrets) holding a Brave Search API key. */
  braveSecret: z.string().min(1).nullable(),
  /**
   * "per-bot": each bot has its own browser profile (sign-ins, cookies), and its helpers use it too. "shared": all
   * bots use one profile. Installs that already had the shared profile keep it until switched.
   */
  profiles: z.enum(["per-bot", "shared"]),
  /**
   * Leave out what only automated browsers send (the automation flag behind `navigator.webdriver`, "Headless" in
   * the user agent), so sites see an ordinary Edge or Chrome. CAPTCHAs are still handed to the user.
   */
  blendIn: z.boolean(),
});
export type BrowserSettings = z.infer<typeof BrowserSettings>;

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  enabled: true,
  show: true,
  channel: "msedge",
  search: "browser",
  searxngUrl: null,
  braveSecret: null,
  profiles: "per-bot",
  blendIn: true,
};

export interface BrowserTab {
  botId: string;
  botName: string;
  url: string;
  title: string;
}

export interface BrowserStatus {
  running: boolean;
  /** Profiles whose browser is open now: a bot's id, a race's or cluster's id, or "shared". */
  open: string[];
  tabs: BrowserTab[];
  error: string | null;
}

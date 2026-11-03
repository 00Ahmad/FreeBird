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
});
export type BrowserSettings = z.infer<typeof BrowserSettings>;

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  enabled: true,
  show: true,
  channel: "msedge",
  search: "browser",
  searxngUrl: null,
  braveSecret: null,
};

export interface BrowserTab {
  botId: string;
  botName: string;
  url: string;
  title: string;
}

export interface BrowserStatus {
  running: boolean;
  tabs: BrowserTab[];
  error: string | null;
}

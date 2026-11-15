import type { SiteClue } from "./types";

export const noHttps: SiteClue = {
  id: "no_https",
  label: "No secure connection",
  check: (page) => (page.url.startsWith("http://") ? "The site has no secure connection (no https)." : null),
};

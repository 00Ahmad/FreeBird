import { FREE_EMAIL_DOMAINS } from "../contacts";
import type { SiteClue } from "./types";

export const freeEmail: SiteClue = {
  id: "free_email",
  label: "Email on a free provider",
  check: (page) => {
    for (const match of page.text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) {
      const domain = match[1]!.toLowerCase();
      // Only the provider is kept, never the address: it may be a person's.
      if (FREE_EMAIL_DOMAINS.has(domain)) return `Its email address is on ${domain}, not its own domain.`;
    }
    return null;
  },
};

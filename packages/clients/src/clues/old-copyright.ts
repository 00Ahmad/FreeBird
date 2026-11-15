import { fold } from "@mrog/jobs";

import type { SiteClue } from "./types";

/** A footer this many years behind looks unlooked-after. */
export const OLD_YEARS = 3;

export const oldCopyright: SiteClue = {
  id: "old_copyright",
  label: "Old website",
  check: (page, now) => {
    const years = [
      ...fold(page.text).matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})\b/g),
    ].map((m) => Number(m[1]));
    if (years.length === 0) return null;
    const newest = Math.max(...years);
    return now.getUTCFullYear() - newest >= OLD_YEARS ? `The footer still says © ${newest}.` : null;
  },
};

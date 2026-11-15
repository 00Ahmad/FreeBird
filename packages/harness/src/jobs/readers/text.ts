import { linksFromText } from "@mrog/jobs";
import { fetchReadable } from "@mrog/tools";

import type { PageReader } from "./types";

const HEAD = /^HTTP (\d{3}) (\S*)\n\n/;
const SCRIPT_NOTE = "(Note: this page builds its content with JavaScript";

/**
 * The page fetched as text, the way fetch_url reads it: nothing on this computer or the local network is reached,
 * redirects included.
 */
export function textReader(fetchImpl: typeof fetch): PageReader {
  return {
    id: "text",
    async read(url, { signal }) {
      const raw = await fetchReadable(url, signal, fetchImpl);
      const head = HEAD.exec(raw);
      // A refusal (a local address, not text) is said in plain words.
      if (!head) throw new Error(raw.slice(0, 200));
      const status = Number(head[1]);
      // Where it ended up after redirects (a response that doesn't say: the address asked for).
      const finalUrl = head[2] || url;
      const body = raw.slice(head[0].length);
      const scriptRendered = body.includes(SCRIPT_NOTE);
      const text = body.replace(/\n\n\(Note: [\s\S]*$/, "");
      return {
        url: finalUrl,
        title: text.split("\n", 1)[0]!.slice(0, 200),
        text,
        links: linksFromText(text, finalUrl),
        reader: "text",
        humanCheck: false,
        ...(status >= 400 ? { status } : {}),
        ...(scriptRendered ? { scriptRendered } : {}),
      };
    },
  };
}

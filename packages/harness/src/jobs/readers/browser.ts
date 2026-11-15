import type { PageRead } from "@mrog/jobs";
import { isWebUrl } from "@mrog/tools";

import type { BrowserManager } from "../../browser";
import type { PageReader } from "./types";

/** What the page in a tab shows now, with its links. */
export async function tabPage(
  browser: BrowserManager,
  tab: string,
  reader: PageRead["reader"],
): Promise<PageRead> {
  const snapshot = await browser.snapshot(tab);
  return {
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.text,
    links: await browser.links(tab),
    reader,
    humanCheck: snapshot.humanCheck,
    ...(snapshot.status && snapshot.status >= 400 ? { status: snapshot.status } : {}),
  };
}

/**
 * The page opened in the Job Bot's own browser tab, so JavaScript builds it as it would for you. It is the tab the
 * Job Bot's chat shows, which is also where you solve a CAPTCHA when one turns up.
 */
export function browserReader(browser: BrowserManager): PageReader {
  return {
    id: "browser",
    async read(url, { botId }) {
      if (!isWebUrl(url)) throw new Error("only http and https addresses are opened");
      const opened = await browser.goto(botId, url);
      const page = await tabPage(browser, botId, "browser");
      return opened.status && opened.status >= 400 ? { ...page, status: opened.status } : page;
    },
  };
}

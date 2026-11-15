import { isWebUrl } from "@mrog/tools";

import type { BrowserManager } from "../browser";
import { tabPage } from "../jobs/readers/browser";
import type { PageReader } from "../jobs/readers/types";
import { visualTask } from "./roles/visual";
import { Halt, type RoleRunner } from "./run-role";
import type { ClientState } from "./state";

/** The longest the Visual helper may spend on one page: on a local model a page can take many minutes. */
export const VISUAL_LIMIT_MS = 3 * 60_000;

/**
 * The fallback: the page opened in the Visual helper's tab, made visible by the helper, then read from the tab. A page
 * that takes longer than `limitMs` is given up (the scan goes on; Stop still stops everything).
 */
export function visualReader(
  browser: BrowserManager,
  state: ClientState,
  roles: RoleRunner,
  limitMs: () => number = () => VISUAL_LIMIT_MS,
): PageReader {
  return {
    id: "visual",
    async read(url, { botId, signal, phase, why }) {
      const project = state.load(botId);
      if (!project || !isWebUrl(url)) return null;
      const tab = project.roles.visual.botId;
      await browser.goto(tab, url);
      const timer = AbortSignal.timeout(limitMs());
      try {
        const reply = await roles.run(
          botId,
          "visual",
          visualTask(url, why),
          AbortSignal.any([signal, timer]),
          {
            phase,
            url,
          },
        );
        if (reply.error) throw new Error(reply.error);
      } catch (error) {
        // Out of time, not stopped: this page is skipped and the scan carries on.
        if (error instanceof Halt && timer.aborted && !signal.aborted)
          throw new Error(`the Visual helper took more than ${Math.round(limitMs() / 60_000)} minutes`, {
            cause: error,
          });
        throw error;
      }
      return tabPage(browser, tab, "visual");
    },
  };
}

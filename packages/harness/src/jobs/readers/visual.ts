import { isWebUrl } from "@mrog/tools";

import type { BrowserManager } from "../../browser";
import { visualTask } from "../roles/visual";
import type { RoleRunner } from "../run-role";
import type { JobState } from "../state";
import { tabPage } from "./browser";
import type { PageReader } from "./types";

/**
 * The fallback: the bot opens the page in the Visual helper's tab (the helper never types an address), the helper
 * clears pop-ups and shows the jobs, then the bot reads what the tab shows. A model that can't see pictures, or any
 * other failure, just means this reader didn't work.
 */
export function visualReader(browser: BrowserManager, state: JobState, roles: RoleRunner): PageReader {
  return {
    id: "visual",
    async read(url, { botId, signal, phase, why }) {
      const project = state.load(botId);
      if (!project || !isWebUrl(url)) return null;
      const tab = project.roles.visual.botId;
      await browser.goto(tab, url);
      const reply = await roles.run(botId, "visual", visualTask(url, why), signal, { phase, url });
      if (reply.error) throw new Error(reply.error);
      return tabPage(browser, tab, "visual");
    },
  };
}

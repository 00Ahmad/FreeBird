import { isWebUrl } from "@mrog/tools";

import type { BrowserManager } from "../browser";
import { tabPage } from "../jobs/readers/browser";
import type { PageReader } from "../jobs/readers/types";
import type { Phase } from "../jobs/phase";
import type { Services } from "../services";
import { Halt } from "./halt";
import type { TeamProject, TeamState } from "./state";

/** The longest the Visual helper may spend on one page: on a local model a page can take many minutes. */
export const VISUAL_LIMIT_MS = 3 * 60_000;

export interface VisualReaderDeps<P extends TeamProject> {
  browser: BrowserManager;
  state: TeamState<P>;
  /** Runs the Visual helper's turn (the bot's role runner). */
  run(
    botId: string,
    task: string,
    signal: AbortSignal,
    options: { phase: Phase; url: string },
  ): Promise<{ error?: string }>;
  /** The Visual helper's task for a page. */
  task(url: string, why: string): string;
  models: Pick<Services, "catalog" | "runtime">;
  limitMs?: () => number;
}

/**
 * The fallback for a team bot (one copy for the Job Bot and the Client Bot): the bot opens the page in the Visual
 * helper's tab (the helper never types an address), the helper clears pop-ups and shows the content, then the bot
 * reads what the tab shows. A model that can't see pictures, or any other failure, just means this reader didn't work.
 *
 * Every try counts toward the scan's limit of Visual pages, whether it worked or not; a try that takes longer than
 * `limitMs` is given up (Stop still stops everything). A model that can't see pictures is found out once per scan,
 * said in the activity list, and the helper isn't tried again in that scan.
 */
export function teamVisualReader<P extends TeamProject>(deps: VisualReaderDeps<P>): PageReader {
  const { browser, state, models } = deps;
  const limitMs = deps.limitMs ?? (() => VISUAL_LIMIT_MS);
  /** Per bot: the scan whose model was found blind, so it isn't asked again in that scan. */
  const blind = new Map<string, number>();

  const canSee = async (botId: string, model: string | null, scan: number) => {
    if (blind.get(botId) === scan) return false;
    const ref = model ?? models.runtime.settings.sharedModel;
    const info = ref ? await models.catalog.info(ref).catch(() => null) : null;
    // A model whose abilities aren't known is tried: other providers' lists are guesses from the name.
    if (!info || info.capabilities.includes("vision")) return true;
    blind.set(botId, scan);
    state.change(botId, (p) =>
      state.logLine(
        p,
        `The Visual helper's model (${ref}) can't see pictures: pages that need it are skipped this scan`,
      ),
    );
    return false;
  };

  return {
    id: "visual",
    async read(url, { botId, signal, phase, why }) {
      const project = state.load(botId);
      const seat = project?.roles.visual;
      if (!project || !seat || !isWebUrl(url)) return null;
      const scan = project.scan?.number ?? 0;
      if (!(await canSee(botId, seat.model, scan))) return null;
      // Counted on trying: a try that fails took as long as one that worked.
      state.change(botId, (p) => void (p.scan && (p.scan.visualPages += 1)));
      const tab = seat.botId;
      await browser.goto(tab, url);
      const timer = AbortSignal.timeout(limitMs());
      try {
        const reply = await deps.run(botId, deps.task(url, why), AbortSignal.any([signal, timer]), {
          phase,
          url,
        });
        if (reply.error) throw new Error(reply.error);
      } catch (error) {
        // Out of time, not stopped: this page is given up and the scan carries on.
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

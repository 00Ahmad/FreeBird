import type { ClientProject } from "@mrog/shared";

import type { BrowserManager } from "../browser";
import type { PageReader } from "../jobs/readers/types";
import type { Services } from "../services";
import { teamVisualReader } from "../teams/visual-reader";
import { visualTask } from "./roles/visual";
import type { RoleRunner } from "./run-role";
import type { ClientState } from "./state";

export { VISUAL_LIMIT_MS } from "../teams/visual-reader";

/**
 * The Client Bot's Visual helper as a reader: the team bots' shared one (`teams/visual-reader.ts`), so it now counts
 * every try toward the 5 a scan and checks once per scan that its model can see pictures (5.10).
 */
export function visualReader(
  browser: BrowserManager,
  state: ClientState,
  roles: RoleRunner,
  models: Pick<Services, "catalog" | "runtime">,
  limitMs?: () => number,
): PageReader {
  return teamVisualReader<ClientProject>({
    browser,
    state,
    run: (botId, task, signal, options) => roles.run(botId, "visual", task, signal, options),
    task: visualTask,
    models,
    ...(limitMs ? { limitMs } : {}),
  });
}

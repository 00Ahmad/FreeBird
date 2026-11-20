import type { JobProject } from "@mrog/shared";

import type { BrowserManager } from "../../browser";
import type { Services } from "../../services";
import { teamVisualReader } from "../../teams/visual-reader";
import { visualTask } from "../roles/visual";
import type { RoleRunner } from "../run-role";
import type { JobState } from "../state";
import type { PageReader } from "./types";

export { VISUAL_LIMIT_MS } from "../../teams/visual-reader";

/** The Job Bot's Visual helper as a reader: the team bots' shared one (`teams/visual-reader.ts`). */
export function visualReader(
  browser: BrowserManager,
  state: JobState,
  roles: RoleRunner,
  models: Pick<Services, "catalog" | "runtime">,
  limitMs?: () => number,
): PageReader {
  return teamVisualReader<JobProject>({
    browser,
    state,
    run: (botId, task, signal, options) => roles.run(botId, "visual", task, signal, options),
    task: visualTask,
    models,
    ...(limitMs ? { limitMs } : {}),
  });
}

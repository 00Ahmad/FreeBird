import type { JobRole } from "@mrog/shared";

import { checker } from "./checker";
import { interviewer } from "./interviewer";
import { searcher } from "./searcher";
import type { RoleSpec } from "./types";
import { visual } from "./visual";

export type { RoleSpec } from "./types";

/** Every role, by name. */
export const ROLES: Record<JobRole, RoleSpec> = { interviewer, searcher, checker, visual };

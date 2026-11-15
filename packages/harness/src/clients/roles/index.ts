import type { ClientRole } from "@mrog/shared";

import { checker } from "./checker";
import { interviewer } from "./interviewer";
import { searcher } from "./searcher";
import type { RoleSpec } from "./types";
import { visual } from "./visual";

export type { RoleSpec } from "./types";

export const ROLES: Record<ClientRole, RoleSpec> = { interviewer, searcher, checker, visual };

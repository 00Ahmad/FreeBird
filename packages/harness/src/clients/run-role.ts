import type { ClientProject, ClientRole } from "@mrog/shared";

import type { Services } from "../services";
import { createTeamRoleRunner, type RoleReply as TeamRoleReply } from "../teams/role-runner";
import type { ClientState } from "./state";
import type { ClientTeam } from "./team";
import type { Capture } from "./tools";

export { Halt } from "../teams/halt";

export type RoleReply = TeamRoleReply<Capture>;

/** A Client Bot's role runner: the team bots' shared one (`teams/role-runner.ts`), with the Client Bot's roles. */
export const createRoleRunner = (services: Services, state: ClientState, team: ClientTeam) =>
  createTeamRoleRunner<ClientRole, ClientProject, Capture>(services, state, team);

export type RoleRunner = ReturnType<typeof createRoleRunner>;

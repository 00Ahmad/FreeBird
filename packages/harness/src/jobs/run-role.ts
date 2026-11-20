import type { JobProject, JobRole } from "@mrog/shared";

import type { Services } from "../services";
import { createTeamRoleRunner, type RoleReply as TeamRoleReply } from "../teams/role-runner";
import type { JobState } from "./state";
import type { JobTeam } from "./team";
import type { Capture } from "./tools";

export { Halt } from "../teams/halt";

export type RoleReply = TeamRoleReply<Capture>;

/** A Job Bot's role runner: the team bots' shared one (`teams/role-runner.ts`), with the Job Bot's roles and tools. */
export const createRoleRunner = (services: Services, state: JobState, team: JobTeam) =>
  createTeamRoleRunner<JobRole, JobProject, Capture>(services, state, team);

export type RoleRunner = ReturnType<typeof createRoleRunner>;

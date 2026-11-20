import { CODING_ROLES, type Bot } from "@mrog/shared";

import { useCodingProject } from "../../hooks/coding";
import { roleLabel } from "../../lib/coding";
import { AssignedSkills } from "./AssignedSkills";
import { OwnSkills } from "./OwnSkills";

/**
 * A Coding Bot's skills: those for the whole team (kept on the Coding Bot itself, which its Planner, Developer and QA
 * all have), then for each role the skills it applies on every card (picked from the shared ones) and its own, which
 * only that role has.
 */
export function CodingSkills({ bot }: { bot: Bot }) {
  const { data: project } = useCodingProject(bot.id, true);
  return (
    <>
      <OwnSkills
        ownerId={bot.id}
        title="Whole team"
        empty="Skills here are given to the Planner, the Developer and QA."
      />
      {project &&
        CODING_ROLES.map((role) => (
          <OwnSkills
            key={role}
            ownerId={project.roles[role].botId}
            title={roleLabel(role)}
            empty={`No skills of its own yet: add one only the ${roleLabel(role)} has.`}
          >
            <AssignedSkills botId={project.roles[role].botId} />
          </OwnSkills>
        ))}
    </>
  );
}

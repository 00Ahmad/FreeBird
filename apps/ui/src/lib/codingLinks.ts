import type { CodingProject } from "@mrog/shared";

/**
 * Which connections the diagram draws: the plan's (what the Planner meant), or the ones read from the code as it was
 * written (a page loading a script, a script importing another), once there are any.
 */
export type DiagramView = "plan" | "code";

/** Whether the code has any connections to show yet. */
export const hasCodeLinks = (project: Pick<CodingProject, "codeLinks">) =>
  (project.codeLinks?.length ?? 0) > 0;

/** The view actually shown: the code's only when it has connections. */
export const shownView = (project: Pick<CodingProject, "codeLinks">, wanted: DiagramView): DiagramView =>
  wanted === "code" && hasCodeLinks(project) ? "code" : "plan";

/**
 * The project as the diagram draws it in a view: the same files and cards, with the connections of that view, so the
 * layout, the marks, the labels, what lights up and the details box all agree.
 */
export function diagramProject<T extends Pick<CodingProject, "edges" | "codeLinks">>(
  project: T,
  view: DiagramView,
): T {
  return shownView(project, view) === "code" ? { ...project, edges: project.codeLinks! } : project;
}

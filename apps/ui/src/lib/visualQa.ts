import type { CodingProject, ModelInfo } from "@mrog/shared";

/** What the Visual QA switch says it does. */
export const VISUAL_QA_HINT =
  "After QA's usual checks pass, QA starts the app, opens it in its browser and uses it like a person: screenshots, clicks, typing and the console. Problems go back to the Developer.";

/**
 * Why Visual QA can only do part of its job with QA's model, or null when it can do it all. A model that can't see
 * pictures still gets the automatic checks and the screen map, but not the screenshots.
 */
export function visualQaWarning(
  project: Pick<CodingProject, "roles">,
  shared: string | null | undefined,
  models: ModelInfo[] | undefined,
): string | null {
  const ref = project.roles.qa.model ?? shared ?? null;
  if (!ref) return "QA has no model yet. Pick one with vision (the eye icon) for Visual QA.";
  const info = models?.find((model) => model.ref === ref);
  // Not listed (yet): nothing to warn about with confidence.
  if (!info) return null;
  if (info.capabilities.includes("vision")) return null;
  return `QA's model (${info.label}) can't see pictures, so Visual QA tests by the screen map and the console only. For screenshots, give QA a model with vision (the eye icon in Models).`;
}

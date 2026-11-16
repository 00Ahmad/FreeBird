/**
 * A skill FreeBird ships with: a step-by-step guide for a common task. Shared by every bot; you can edit or delete
 * it like your own. Written to work both ways: typed as /name, or loaded by a bot itself with use_skill.
 */
export interface BuiltinSkill {
  /** Letters, numbers, - and _ only (it is typed as /name). */
  name: string;
  /** When to use it (up to 400 characters): what it does and the requests it fits. A bot reads this to pick it. */
  description: string;
  prompt: string;
}

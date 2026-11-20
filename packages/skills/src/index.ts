/**
 * @mrog/skills: the skills FreeBird ships with, and how a bot finds one. Plain data and functions: the harness adds
 * them to the store once and gives bots the find_skills and use_skill tools.
 */
import { BUSINESS } from "./builtins/business";
import { CODING } from "./builtins/coding";
import { CODING_TEAM } from "./builtins/coding-team";
import { DATA } from "./builtins/data";
import { PLANNING } from "./builtins/planning";
import { RESEARCH } from "./builtins/research";
import { WRITING } from "./builtins/writing";
import type { BuiltinSkill } from "./types";

export type { BuiltinSkill } from "./types";
export * from "./assigned";
export * from "./layers";
export * from "./search";

/** Every built-in skill, by category. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  ...WRITING,
  ...CODING,
  ...CODING_TEAM,
  ...RESEARCH,
  ...BUSINESS,
  ...PLANNING,
  ...DATA,
];

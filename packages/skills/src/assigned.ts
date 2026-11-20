/**
 * Skills assigned to a bot are part of how it does its job on every task, not guides it may look up: their steps go
 * into its prompt whole. A bot that works to a fixed routine (a Coding Bot's role: plan, then propose_plan) never stops
 * to search for a skill, so one it should always apply has to be in front of it.
 */

/** Skills a role or bot is given by name; the names are matched without case, and unknown ones are left out. */
export function pickAssigned<T extends { name: string }>(
  skills: readonly T[],
  names: readonly string[],
): T[] {
  const wanted = names.map((name) => name.toLowerCase());
  return wanted.flatMap((name) => skills.find((skill) => skill.name.toLowerCase() === name) ?? []);
}

/** The prompt section for a bot's assigned skills, or null when it has none. */
export function assignedSkillsSection(skills: readonly { name: string; prompt: string }[]): string | null {
  if (skills.length === 0) return null;
  return [
    `Skills assigned to you (${skills.map((skill) => skill.name).join(", ")}): apply them on every task, as part of how you do your job; you don't need to look them up.`,
    "Your own rules and tools come first: you still follow your job's steps and finish the way your job says (with your usual tool call). Use a skill's rules, steps and checks only as far as your job allows: skip any step that needs a tool you don't have or that your rules forbid (writing or changing files, writing test files, running commands, asking someone a question), and put what that step would have told you into your comment or notes instead. What you report always goes into your usual tool call (a comment, a review, your notes): follow a skill's Output section when it describes that call, and put a separate report it asks for into the call instead.",
    ...skills.map((skill) => `=== Skill: ${skill.name} ===\n${skill.prompt.trim()}`),
  ].join("\n\n");
}

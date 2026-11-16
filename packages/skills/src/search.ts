/** Finding the skill for a task, by code: words in the request against each skill's name and description. */

export interface SkillLike {
  name: string;
  description: string;
  prompt: string;
}

const STOP = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "my",
  "me",
  "this",
  "it",
]);

const wordsOf = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(ing|ies|es|s)$/, "") : w));

/** What a skill is for: its description, or the start of its prompt when it has none. */
export const whatFor = (skill: SkillLike) =>
  skill.description.trim() || skill.prompt.replace(/\s+/g, " ").slice(0, 120);

/**
 * The skills that best match a query, best first, at most `max`. Words in the name count most, then the
 * description, then the prompt. An empty query lists them all by name.
 */
export function findSkills<T extends SkillLike>(skills: readonly T[], query: string, max = 8): T[] {
  const wanted = wordsOf(query);
  if (wanted.length === 0) return skills.toSorted((a, b) => a.name.localeCompare(b.name)).slice(0, max);
  const scored = skills.map((skill) => {
    const name = new Set(wordsOf(skill.name.replace(/[-_]/g, " ")));
    const about = new Set(wordsOf(whatFor(skill)));
    const body = new Set(wordsOf(skill.prompt));
    const score = wanted.reduce(
      (sum, w) => sum + (name.has(w) ? 3 : 0) + (about.has(w) ? 2 : 0) + (body.has(w) ? 0.5 : 0),
      0,
    );
    return { skill, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .toSorted((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, max)
    .map((s) => s.skill);
}

/** The line in a bot's prompt that tells it it has skills: names only, so the prompt stays short. */
export function skillsPromptLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return [
    `You have skills: step-by-step guides for common tasks (${names.join(", ")}).`,
    "When the user's request matches one, call use_skill with its name first and follow it; to search them by what they do, call find_skills with a few words.",
    "A skill is a guide, not a rule: the user's instructions come first.",
  ].join(" ");
}

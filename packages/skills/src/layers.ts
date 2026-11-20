/**
 * A bot's skills come in layers, most specific first: its own, then those of the team it belongs to (a Coding Bot's
 * role sees the Coding Bot's), then the ones shared by every bot. Two layers may hold a skill of the same name; the
 * more specific one wins, so a role's own "code-review" is the one it uses, not the shared one.
 */
export function mergeSkills<T extends { name: string }>(layers: readonly (readonly T[])[]): T[] {
  const byName = new Map<string, T>();
  for (const layer of layers)
    for (const skill of layer) {
      const key = skill.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, skill);
    }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

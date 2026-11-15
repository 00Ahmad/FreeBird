/**
 * Adds `key` to a set that keeps only the newest `max` keys (a Set iterates in the order keys were added). Returns
 * false when the key was there already. For "told once" bookkeeping that would otherwise grow for as long as the app
 * stays open.
 */
export function addBounded(set: Set<string>, key: string, max: number): boolean {
  if (set.has(key)) return false;
  set.add(key);
  for (const oldest of set) {
    if (set.size <= max) break;
    set.delete(oldest);
  }
  return true;
}

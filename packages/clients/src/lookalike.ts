import type { LookalikeProfile } from "@mrog/shared";

import { yearsSince } from "./dates";

/**
 * Lookalikes of your best clients: what they have in common (industry code, size, area, age), worked out by code from
 * their register entries. You see the profile and can edit it before a scan uses it.
 */

/** What a register says about one of your clients. */
export interface LookalikeSeed {
  sicCodes: string[];
  employees: number | null;
  area: string | null;
  /** Incorporated on (yyyy-mm-dd). */
  incorporated: string | null;
}

export const MIN_SEEDS = 3;

/** The values at least half of the list share. */
function shared<T>(values: T[][], total: number): T[] {
  const counts = new Map<T, number>();
  for (const list of values) for (const v of new Set(list)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n * 2 >= total)
    .toSorted((a, b) => b[1] - a[1])
    .map(([v]) => v);
}

/** The shared profile, or why there isn't one. */
export function lookalikeProfile(seeds: LookalikeSeed[], now: Date): LookalikeProfile | { error: string } {
  if (seeds.length < MIN_SEEDS)
    return { error: `Add at least ${MIN_SEEDS} clients the registers know (found ${seeds.length}).` };
  const total = seeds.length;
  let sicCodes = shared(
    seeds.map((s) => s.sicCodes),
    total,
  );
  // No full code in common: the first two digits (the broad industry) may be.
  if (sicCodes.length === 0) {
    const broad = shared(
      seeds.map((s) => s.sicCodes.map((c) => c.slice(0, 2))),
      total,
    );
    const known = new Set(seeds.flatMap((s) => s.sicCodes));
    sicCodes = [...known].filter((c) => broad.includes(c.slice(0, 2))).slice(0, 10);
  }
  if (sicCodes.length === 0)
    return { error: "Your clients don't share an industry code, so there is nothing to match." };
  const staff = seeds.flatMap((s) => (s.employees === null ? [] : [s.employees]));
  const areas = shared(
    seeds.map((s) => (s.area ? [s.area.trim()] : [])),
    total,
  );
  const ages = seeds.flatMap((s) => (s.incorporated ? [yearsSince(s.incorporated, now)] : []));
  return {
    sicCodes: sicCodes.slice(0, 10),
    sizeMin: staff.length > 0 ? Math.floor(Math.min(...staff) / 2) : null,
    sizeMax: staff.length > 0 ? Math.ceil(Math.max(...staff) * 1.5) : null,
    area: areas[0] ?? null,
    ageMin: ages.length > 0 ? Math.max(0, Math.min(...ages) - 2) : null,
    ageMax: ages.length > 0 ? Math.max(...ages) + 2 : null,
    from: total,
  };
}

export function lookalikeText(profile: LookalikeProfile): string {
  const parts = [`industry codes ${profile.sicCodes.join(", ")}`];
  if (profile.sizeMin !== null || profile.sizeMax !== null)
    parts.push(`${profile.sizeMin ?? 0}–${profile.sizeMax ?? "any"} staff`);
  if (profile.area) parts.push(profile.area);
  if (profile.ageMin !== null || profile.ageMax !== null)
    parts.push(`${profile.ageMin ?? 0}–${profile.ageMax ?? "any"} years old`);
  return parts.join(", ");
}

import { fold, words } from "@mrog/jobs";

import type { Playbook } from "../playbooks";

/** Words for a provider of any service: they don't say which service. */
const PROVIDER = new Set([
  "provider",
  "providers",
  "company",
  "companies",
  "service",
  "services",
  "bureau",
  "bureaus",
  "firm",
  "firms",
  "agency",
  "agencies",
  "solution",
  "solutions",
  "specialist",
  "specialists",
  "supplier",
  "suppliers",
  "partner",
  "partners",
]);

/** The words that name your service: from what a company would call it and what a tender for it says. */
export function serviceWords(playbook: Playbook, serviceNames: readonly string[] = []): string[] {
  const all = [...serviceNames, ...playbook.serviceNames, ...playbook.tenderWords].flatMap((name) =>
    words(name),
  );
  return [...new Set(all.filter((w) => w.length >= 4 && !PROVIDER.has(w)))];
}

/** Whether a service word is within `reach` characters of where `pattern` matches in the text. */
export function namesServiceNear(
  text: string,
  pattern: RegExp,
  service: readonly string[],
  reach = 80,
): boolean {
  if (service.length === 0) return false;
  const t = fold(text);
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  for (const match of t.matchAll(new RegExp(pattern.source, flags))) {
    const at = match.index;
    const window = t.slice(Math.max(0, at - reach), at + match[0].length + reach);
    if (
      service.some((word) =>
        new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`).test(window),
      )
    )
      return true;
  }
  return false;
}

const SCALE: Record<string, number> = { k: 1e3, m: 1e6, bn: 1e9, million: 1e6, billion: 1e9 };

/** The largest sum of money the text names ("£250k", "$3 million", "€1.2m"), or 0. */
export function largestSum(text: string): number {
  const t = fold(text);
  let largest = 0;
  const add = (raw: string, unit: string | undefined) => {
    const value = Number(raw.replace(/,/g, "")) * (unit ? (SCALE[unit] ?? 1) : 1);
    if (Number.isFinite(value)) largest = Math.max(largest, value);
  };
  for (const m of t.matchAll(/[£$€]\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn|million|billion)?\b/g)) add(m[1]!, m[2]);
  for (const m of t.matchAll(/\b(\d[\d,]*(?:\.\d+)?)\s*(million|billion)\b/g)) add(m[1]!, m[2]);
  return largest;
}

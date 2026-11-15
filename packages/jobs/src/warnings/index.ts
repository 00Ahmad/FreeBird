import type { JobWarning } from "@mrog/shared";

import { agency } from "./agency";
import { closed } from "./closed";
import { dealBreaker } from "./deal-breaker";
import { noSalary } from "./no-salary";
import { oldPosting } from "./old-posting";
import { scamWording } from "./scam-wording";
import type { WarningContext, WarningRule } from "./types";

export type { WarningContext, WarningRule } from "./types";
export { OLD_POSTING_DAYS, daysSincePosted } from "./old-posting";

/** Every warning sign, most serious first. Adding a sign is one file and one line here. */
export const WARNING_RULES: readonly WarningRule[] = [
  closed,
  scamWording,
  dealBreaker,
  agency,
  oldPosting,
  noSalary,
];

/** The warnings the rules find, then the Checker's own (clipped, at most three, each different from the rules'). */
export function warningsFor(
  context: WarningContext,
  fromChecker: string[] = [],
  rules: readonly WarningRule[] = WARNING_RULES,
): JobWarning[] {
  const found: JobWarning[] = [];
  for (const rule of rules) {
    const text = rule.check(context);
    if (text) found.push({ id: rule.id, text });
  }
  for (const text of fromChecker.slice(0, 3)) {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 200);
    if (clean) found.push({ id: "checker", text: clean });
  }
  return found;
}

/** Whether the page says the job is closed (such a job is never shown as a new one). */
export const saysClosed = (page: string) =>
  closed.check({ page, facts: [], match: [], now: new Date() }) !== null;

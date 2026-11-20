import { fold } from "@mrog/jobs";

import { daysSince, parseDate } from "../dates";
import type { SignalKind } from "./types";

const NEW =
  /incorporat|\bfounded\b|\blaunch(ed|es)?\b|\bestablished\b|new business|\bopened\b|\bregistered\b|start-?up|just opened/;
/** Words that say it happened lately. */
const LATELY = /\b(new|newly|just|recently|brand new)\b/;

const FRESH_DAYS = 365;

/**
 * A new company: it has to set up payroll, accounts, a website and IT for the first time. Found mostly in registers.
 * The words alone aren't enough ("Registered in England and Wales", "Established in 1987"): the quote must say it was
 * lately, or give a date in the last year.
 */
export const newCompany: SignalKind = {
  id: "new_company",
  label: "New company",
  strength: 0.55,
  freshForDays: FRESH_DAYS,
  indicates: (quote, _playbook, context) => {
    const t = fold(quote);
    if (!NEW.test(t)) return false;
    if (LATELY.test(t)) return true;
    const now = context?.now ?? new Date();
    const date = parseDate(quote, now);
    return date !== null && daysSince(date, now) <= FRESH_DAYS && daysSince(date, now) >= -31;
  },
  searches: ({ industry, place, year }) =>
    industry ? [`new ${industry} "opened" ${place} ${year}`.replace(/\s+/g, " ").trim()] : [],
};

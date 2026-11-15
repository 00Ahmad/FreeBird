import { fold } from "@mrog/jobs";

import type { SignalKind } from "./types";

const NEW =
  /incorporat|\bfounded\b|\blaunch(ed|es)?\b|\bestablished\b|new business|\bopened\b|\bregistered\b|start-?up|just opened/;

/** A new company: it has to set up payroll, accounts, a website and IT for the first time. Found mostly in registers. */
export const newCompany: SignalKind = {
  id: "new_company",
  label: "New company",
  strength: 0.55,
  freshForDays: 365,
  indicates: (quote) => NEW.test(fold(quote)),
  searches: ({ industry, place, year }) =>
    industry ? [`new ${industry} "opened" ${place} ${year}`.replace(/\s+/g, " ").trim()] : [],
};

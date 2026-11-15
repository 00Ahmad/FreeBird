import type { JobWarning } from "@mrog/shared";

import { agencyPost } from "./agency-post";
import { bigBuyer } from "./big-buyer";
import { closedCompany } from "./closed-company";
import { maybeCompetitor } from "./maybe-competitor";
import { noContact } from "./no-contact";
import { soleTrader } from "./sole-trader";
import { stale } from "./stale";
import type { LeadContext, LeadWarningRule } from "./types";

export type { LeadContext, LeadWarningRule } from "./types";

export const LEAD_WARNINGS: readonly LeadWarningRule[] = [
  stale,
  closedCompany,
  maybeCompetitor,
  bigBuyer,
  noContact,
  agencyPost,
  soleTrader,
];

export function leadWarnings(lead: LeadContext): JobWarning[] {
  return LEAD_WARNINGS.flatMap((rule) => {
    const text = rule.check(lead);
    return text ? [{ id: rule.id, text }] : [];
  });
}

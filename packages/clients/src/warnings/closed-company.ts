import { fold } from "@mrog/jobs";

import type { LeadWarningRule } from "./types";

const CLOSED_STATUS =
  /dissolved|liquidation|insolvency|administration|struck off|removed|closed|receivership/;
const CLOSED_PAGE =
  /ceased trading|permanently closed|we have closed|has now closed|no longer trading|closed for good/;

export const closedCompany: LeadWarningRule = {
  id: "closed-company",
  check: ({ records, pages }) => {
    const record = records.find((r) => r.status && CLOSED_STATUS.test(fold(r.status)));
    if (record) return `The register says the company is ${record.status}.`;
    return CLOSED_PAGE.test(fold(pages)) ? "Its site says it has closed." : null;
  },
};

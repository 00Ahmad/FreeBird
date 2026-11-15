import { fold } from "@mrog/jobs";

import type { LeadWarningRule } from "./types";

const ON_BEHALF =
  /on behalf of (our|a|an) client|our client (is|are) (looking|seeking)|for a client of ours|confidential client/;

export const agencyPost: LeadWarningRule = {
  id: "agency-post",
  check: ({ pages }) =>
    ON_BEHALF.test(fold(pages)) ? "Posted by an agency for a client it doesn't name." : null,
};

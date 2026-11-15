import { fold } from "@mrog/jobs";

import { clientFact } from "../facts";
import { staffOf } from "../staff";
import type { LeadWarningRule } from "./types";

const ONE_PERSON = /\b(sole trader|self[- ]employed|freelancer|one[- ]person business|i am a|i'm a)\b/;

export const soleTrader: LeadWarningRule = {
  id: "sole-trader",
  check: ({ facts, pages }) => {
    const size = staffOf(clientFact(facts, "size") ?? "");
    return (size && size.max === 1) || ONE_PERSON.test(fold(pages))
      ? "The business may be one person, so their details are personal data: use the business phone or contact form, not cold email."
      : null;
  },
};

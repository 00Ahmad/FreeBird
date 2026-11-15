import { fold } from "@mrog/jobs";

import { clientFact } from "../facts";
import { staffOf } from "../staff";
import type { LeadWarningRule } from "./types";

export const BIG_STAFF = 250;
const PUBLIC_BODY =
  /\b(council|nhs|university|college|school|academy trust|ministry|department for|government|authority|police|fire and rescue|trust)\b/;

export const bigBuyer: LeadWarningRule = {
  id: "big-buyer",
  check: ({ facts, records }) => {
    const size = staffOf(clientFact(facts, "size") ?? "");
    if (size && size.min >= BIG_STAFF)
      return "A large organisation: expect formal buying and a long decision.";
    const name = fold(clientFact(facts, "company") ?? "");
    if (records.some((r) => r.register === "contracts-finder") || PUBLIC_BODY.test(name))
      return "A public body: it buys through formal tenders with set rules and deadlines.";
    return null;
  },
};

import { fold } from "@mrog/jobs";

import type { SignalKind } from "./types";

const FIRST =
  /\b(our|the|their) first\b[^.]{0,40}\b(hire|employee|member of (staff|the team)|marketer|developer|engineer|hr|finance|accountant|salesperson|team member)|founding (engineer|marketer|hire|team member)|first (employees?|hires?|staff)/;

/** Hiring a first role: a company taking on its first employees, or its first marketer, needs help it never had. */
export const firstHire: SignalKind = {
  id: "first_hire",
  label: "Hiring a first role",
  strength: 0.85,
  freshForDays: 60,
  indicates: (quote) => FIRST.test(fold(quote)),
  searches: ({ industry, place }) => [`"our first" hire ${industry} ${place}`.replace(/\s+/g, " ").trim()],
};

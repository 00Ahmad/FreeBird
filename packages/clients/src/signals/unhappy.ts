import { fold } from "@mrog/jobs";

import type { SignalKind } from "./types";

const UNHAPPY =
  /unhappy|frustrat|fed up|disappoint|terrible|awful|\bswitch(ing)?\b|\bleaving\b|\breplace\b|alternative to|problems? with|issues? with|let (us )?down|poor service|looking to change/;

/** Unhappy with a provider: a public post complaining about the company's current one. */
export const unhappy: SignalKind = {
  id: "unhappy",
  label: "Unhappy with their provider",
  strength: 0.6,
  freshForDays: 90,
  indicates: (quote) => UNHAPPY.test(fold(quote)),
  searches: ({ serviceNames, place }) =>
    serviceNames
      .slice(0, 1)
      .map((name) => `"switching ${name}" OR "new ${name}" ${place}`.replace(/\s+/g, " ").trim()),
};

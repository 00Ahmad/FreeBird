import { fold } from "@mrog/jobs";

import type { SignalKind } from "./types";

const RAISED =
  /\brais(e|ed|es|ing)\b|funding|\bseed\b|series [a-e]\b|investment|invest(ed|ors?)\b|backed by|\bgrant\b|secured £|secured \$|secured €/;

/** Just raised money: new money is usually spent on growth, and growth needs help. */
export const funding: SignalKind = {
  id: "funding",
  label: "Just raised money",
  strength: 0.6,
  freshForDays: 180,
  indicates: (quote) => RAISED.test(fold(quote)),
  searches: ({ industry, place, year }) => [
    `${industry} ${place} "raised" seed OR "series a" ${year}`.replace(/\s+/g, " ").trim(),
  ],
};

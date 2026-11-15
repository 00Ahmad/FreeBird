import { fold } from "@mrog/jobs";

import type { SignalKind } from "./types";

const EXPANDING =
  /\bopen(ing|ed|s)?\b[^.]{0,30}\b(new|second|third|fourth|another|\w+) (office|site|branch|store|shop|restaurant|location|warehouse|clinic|studio|hotel|venue)|\bexpan(d|ds|ding|sion)\b|new (office|site|premises|location|headquarters)|moving (in)?to (a )?(bigger|larger|new)|relocat/;

/** Expanding: a new office, site or country brings new staff, systems and customers to reach. */
export const expanding: SignalKind = {
  id: "expanding",
  label: "Expanding",
  strength: 0.6,
  freshForDays: 180,
  indicates: (quote) => EXPANDING.test(fold(quote)),
  searches: ({ industry, place, year }) =>
    industry || place
      ? [`${industry} "new office" OR "opening" OR "expansion" ${place} ${year}`.replace(/\s+/g, " ").trim()]
      : [],
};

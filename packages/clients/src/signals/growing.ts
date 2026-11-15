import { fold } from "@mrog/jobs";

import type { SignalKind } from "./types";

const GROWING =
  /\b(\d{1,3}|many|several|multiple) (open )?(roles|positions|vacancies|jobs|openings)\b|growing (team|fast|rapidly|quickly)|we('| a)re growing|doubl(e|ed|ing) (in size|the team|our team|headcount)|rapid growth|headcount/;

/** Growing fast: many open jobs at once, a team doubling. A weak sign on its own. */
export const growing: SignalKind = {
  id: "growing",
  label: "Growing fast",
  strength: 0.4,
  freshForDays: 120,
  indicates: (quote) => GROWING.test(fold(quote)),
  searches: () => [],
};

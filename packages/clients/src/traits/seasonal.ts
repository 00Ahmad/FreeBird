import { fold } from "@mrog/jobs";

import type { Trait } from "./types";

const SEASONAL =
  /seasonal (staff|work|workers|roles|jobs|team)|summer (staff|season|team)|christmas (temps?|staff|season)|peak season|temporary staff|casual staff|festival season/;

export const seasonal: Trait = {
  id: "seasonal",
  label: "Seasonal staff",
  indicates: (quote) => SEASONAL.test(fold(quote)),
};

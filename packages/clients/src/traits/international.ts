import { fold } from "@mrog/jobs";

import type { Trait } from "./types";

const INTERNATIONAL =
  /offices in [\w ,]+ and |operat(e|es|ing) in \d+ countries|across (europe|the world|\d+ countries)|international (team|offices|clients|presence)|global team|teams? in \d+ countries|worldwide offices/;

export const international: Trait = {
  id: "international",
  label: "Staff in more than one country",
  indicates: (quote) => INTERNATIONAL.test(fold(quote)),
};

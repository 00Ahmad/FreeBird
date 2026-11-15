import { fold } from "@mrog/jobs";

import type { Trait } from "./types";

const SITES =
  "(sites|locations|branches|stores|shops|restaurants|offices|clinics|venues|practices|hotels|nurseries|homes)";
const MANY = new RegExp(
  `\\b(\\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|several|multiple) ${SITES}\\b|\\bour ${SITES}\\b|\\bacross (the|our) ${SITES}`,
);

export const multiSite: Trait = {
  id: "multi_site",
  label: "More than one site",
  indicates: (quote) => {
    const t = fold(quote);
    const m =
      /\b(\d{1,3}) (sites|locations|branches|stores|shops|restaurants|offices|clinics|venues|practices|hotels|nurseries|homes)\b/.exec(
        t,
      );
    return m ? Number(m[1]) >= 2 : MANY.test(t);
  },
};

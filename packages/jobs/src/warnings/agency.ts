import { fold } from "../text";
import type { WarningRule } from "./types";

const AGENCY =
  /\b(our client|on behalf of (our|a) client|we are (a|an) (recruitment|staffing) (agency|company|firm)|recruitment agency|staffing agency|confidential (client|company))\b/;

export const agency: WarningRule = {
  id: "agency",
  check: ({ page }) =>
    AGENCY.test(fold(page))
      ? "Posted by an agency for an unnamed employer: you won't know who you'd work for until later."
      : null,
};

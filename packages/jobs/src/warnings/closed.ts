import { fold } from "../text";
import type { WarningRule } from "./types";

const CLOSED =
  /\b(no longer accepting applications|this (job|position|posting|vacancy|role) (has expired|is closed|has been filled|is no longer available)|applications? (are |is )?(now )?closed|job not found)\b/;

export const closed: WarningRule = {
  id: "closed",
  check: ({ page }) => (CLOSED.test(fold(page)) ? "The page says this job is closed." : null),
};

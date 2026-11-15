import { sellsIt } from "../fit";
import type { LeadWarningRule } from "./types";

export const maybeCompetitor: LeadWarningRule = {
  id: "maybe-competitor",
  check: ({ pages, playbook }) =>
    sellsIt(pages, playbook.sells)
      ? `Its site mentions ${playbook.label.toLowerCase()} services: it may be a competitor.`
      : null,
};

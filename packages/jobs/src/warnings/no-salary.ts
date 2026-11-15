import { factValue } from "../source-check";
import type { WarningRule } from "./types";

export const noSalary: WarningRule = {
  id: "no-salary",
  check: ({ facts }) =>
    factValue(facts, "salary") === null
      ? "No salary on the posting: ask before you spend time applying."
      : null,
};

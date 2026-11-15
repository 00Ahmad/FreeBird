import { staffRange } from "../staff";
import type { Trait } from "./types";

/** Staff numbers a client has to have before this counts. */
export const MIN_STAFF = 5;

export const hasStaff: Trait = {
  id: "has_staff",
  label: "Has staff",
  indicates: (quote) => (staffRange(quote)?.min ?? 0) >= MIN_STAFF,
};

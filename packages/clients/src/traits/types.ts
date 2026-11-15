import type { TraitId } from "@mrog/shared";

/**
 * A fact about a business that implies a need with no event ("has 30 staff": it runs payroll). One file each. The
 * Checker quotes it; code checks the quote says it.
 */
export interface Trait {
  id: TraitId;
  label: string;
  indicates(quote: string): boolean;
}

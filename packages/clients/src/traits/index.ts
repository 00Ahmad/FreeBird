import type { TraitId } from "@mrog/shared";

import { hasStaff } from "./has-staff";
import { international } from "./international";
import { multiSite } from "./multi-site";
import { regulated } from "./regulated";
import { seasonal } from "./seasonal";
import type { Trait } from "./types";

export type { Trait } from "./types";
export { MIN_STAFF } from "./has-staff";

export const TRAITS: readonly Trait[] = [hasStaff, multiSite, regulated, seasonal, international];

export const traitById = (id: string): Trait | undefined =>
  TRAITS.find((trait) => trait.id === (id as TraitId));

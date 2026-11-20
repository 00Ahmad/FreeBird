import type { SignalKindId } from "@mrog/shared";

import { asking } from "./asking";
import { expanding } from "./expanding";
import { firstHire } from "./first-hire";
import { funding } from "./funding";
import { growing } from "./growing";
import { hiring } from "./hiring";
import { newCompany } from "./new-company";
import type { SignalKind } from "./types";
import { unhappy } from "./unhappy";

export type { SearchContext, SignalKind, SignContext } from "./types";
export { largestSum, namesServiceNear, serviceWords } from "./words";
export { namesTitle } from "./hiring";

/** Every kind of sign, strongest first. */
export const SIGNALS: readonly SignalKind[] = [
  asking,
  firstHire,
  hiring,
  expanding,
  funding,
  unhappy,
  newCompany,
  growing,
];

export function signalKind(id: SignalKindId): SignalKind {
  const found = SIGNALS.find((kind) => kind.id === id);
  if (!found) throw new Error(`No such signal: ${id}`);
  return found;
}

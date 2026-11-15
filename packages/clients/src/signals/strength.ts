import type { LeadSignal } from "@mrog/shared";

import { daysSince } from "../dates";
import { signalKind } from "./index";

/** An undated sign counts for this share of its strength. */
export const UNDATED_SHARE = 0.4;

/**
 * How strong a sign is now, 0 to 1, by code: full strength when new, fading to half over its fresh period, nothing
 * after it. A sign the page didn't date counts as weak. A date still to come (a tender's deadline) is fresh.
 */
export function signalStrength(signal: LeadSignal, now: Date): number {
  const kind = signalKind(signal.kind);
  if (!signal.date) return kind.strength * UNDATED_SHARE;
  const age = Math.max(0, daysSince(signal.date, now));
  if (age > kind.freshForDays) return 0;
  return kind.strength * (1 - 0.5 * (age / kind.freshForDays));
}

/** Whether a sign has faded away. */
export const isStale = (signal: LeadSignal, now: Date) =>
  signal.date !== null && signalStrength(signal, now) === 0;

/**
 * The why-now strength of a lead, 0 to 1: its strongest fresh sign, plus a little for each other fresh one.
 */
export function whyNow(signals: LeadSignal[], now: Date): number {
  const strengths = signals
    .map((signal) => signalStrength(signal, now))
    .filter((s) => s > 0)
    .toSorted((a, b) => b - a);
  if (strengths.length === 0) return 0;
  return Math.min(1, strengths[0]! + 0.1 * (strengths.length - 1));
}

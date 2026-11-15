import { daysSince } from "../dates";
import { isStale } from "../signals/strength";
import type { LeadWarningRule } from "./types";

export const stale: LeadWarningRule = {
  id: "stale",
  check: ({ signals, records, now }) => {
    const closed = records.find((r) => r.deadline && daysSince(r.deadline, now) > 0);
    if (closed) return `The tender closed on ${closed.deadline}.`;
    if (signals.length > 0 && signals.every((s) => isStale(s, now))) {
      const newest = signals
        .map((s) => s.date!)
        .toSorted()
        .at(-1)!;
      return `Its newest sign is from ${newest}: it may no longer need you.`;
    }
    return null;
  },
};

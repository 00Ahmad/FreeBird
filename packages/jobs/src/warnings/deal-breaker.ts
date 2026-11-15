import { scoreMatch } from "../match";
import type { WarningRule } from "./types";

const named = (requirement: string) => requirement.replace(/^(Free of|Not in the|Not at):?\s*/i, "");

/** A deal-breaker the job has, or may have ("partly": an on-call rotation for "weekly on-call"): you decide. */
export const dealBreaker: WarningRule = {
  id: "deal-breaker",
  check({ match }) {
    const hit = scoreMatch(match).dealBreaker;
    if (hit) return `Has one of your deal-breakers: ${hit}.`;
    const maybe = match.find((line) => line.kind === "dealbreaker" && line.verdict === "partly");
    return maybe
      ? `May have one of your deal-breakers: ${named(maybe.requirement)}${maybe.reason ? ` (${maybe.reason.replace(/\.$/, "")})` : ""}.`
      : null;
  },
};

import type { SteerMoment } from "@mrog/engine";
import type { ChatMessage } from "@mrog/providers";

/** What a Checker is told once when it ends its turn without having called its tool. */
export const checkerNudge = (tool: string) =>
  `(You haven't called ${tool}, so nothing was recorded. Call ${tool} now with what the page is, then reply with one short sentence.)`;

/**
 * A team bot's Checker turn (one copy for the Job Bot and the Client Bot): nudged once, at its end, when it has
 * reported nothing. A small model often writes its report as text and stops; this costs one step in the same turn
 * instead of a whole second turn.
 */
export function checkerSteer(tool: string, reported: () => boolean) {
  let nudged = false;
  return (moment: SteerMoment): ChatMessage[] => {
    if (moment !== "ending" || nudged || reported()) return [];
    nudged = true;
    return [{ role: "user", content: checkerNudge(tool) }];
  };
}

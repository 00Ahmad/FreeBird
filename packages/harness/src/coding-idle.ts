import type { CodingRole } from "@mrog/shared";

import type { TurnCapture } from "./coding-tools";

/**
 * A role turn that ends without calling any tool did nothing: small models sometimes describe the code, or say they
 * will write it, and stop. Starting a whole new turn rebuilds the task and costs the model its context again; instead
 * the turn is nudged once, in place, with what to call. A turn counts as having used its tools once it has made any
 * tool call, even one that was refused (its arguments didn't fit): it was told what was wrong with that call, not that
 * it made none. The Planner is left alone: a plan written as a JSON block without the tool is an answer it may give.
 */

/** What a role that called no tool is told, once; null when it isn't (the Planner, or it already was). */
export function idleNudge(role: CodingRole, capture: TurnCapture): string | null {
  if (role === "planner" || capture.usedTool || capture.idleNudged) return null;
  if (role === "developer")
    return capture.card?.kind === "file" && capture.card.path
      ? `You replied without using any tool, so nothing was written. Call write_file now with the complete ${capture.card.path}, then call finish_card.`
      : "You replied without using any tool, so nothing changed. Make the edits now with edit_file, then call finish_card.";
  if (capture.visual)
    return "You replied without using any tool. Start the app with app_start and use it, then call finish_visual_check with what you found.";
  if (capture.finalCheck)
    return "You replied without using any tool. Read the files that matter with read_file, then call finish_check with your verdict.";
  return "You replied without using any tool. Read the card's file with read_file, then call review_card with pass or fail.";
}

/** The activity line for a nudge. */
export const idleLine = (who: string) => `${who} replied without using any tool; told to use them`;

import type { Playbook } from "./types";

/**
 * Any other service. Its searches use the words of what you sell; the Interviewer proposes signals and you approve
 * them on the profile card.
 */
export const generic: Playbook = {
  id: "generic",
  label: "Other service",
  matches: /(?!)/,
  signals: ["asking", "hiring", "new_company", "funding", "expanding", "growing"],
  traits: ["has_staff"],
  clues: [],
  buyerTitles: ["Founder", "Managing Director", "Owner"],
  hiringTitles: [],
  serviceNames: [],
  sells: /(?!)/,
  tenderWords: [],
  questions: [
    "What problem does your service solve for a client?",
    "What would a client be doing just before they need you?",
  ],
};

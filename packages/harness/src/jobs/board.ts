import { randomUUID } from "node:crypto";

import { factValue, mergeProfile, suggestFrom } from "@mrog/jobs";
import {
  MAX_JOB_CARDS,
  MAX_SUGGESTIONS,
  type JobCard,
  type JobColumn,
  type JobProject,
  type ReactToJobInput,
} from "@mrog/shared";

import { JobError } from "./state";

/**
 * The board: cards in columns, your reactions, and the profile changes they suggest. Plain functions on a project;
 * the service saves and publishes after each.
 */

/** Adds a card; when the board is full, the oldest "Not for me" card goes first, then the oldest weak "Found" one. */
export function addCard(project: JobProject, card: JobCard) {
  project.cards.push(card);
  while (project.cards.length > MAX_JOB_CARDS) {
    const drop =
      project.cards.findIndex((c) => c.column === "not_for_me") >= 0
        ? project.cards.findIndex((c) => c.column === "not_for_me")
        : (project.cards
            .map((c, index) => ({ c, index }))
            .filter(({ c }) => c.column === "found")
            .toSorted((a, b) => a.c.score - b.c.score)[0]?.index ?? 0);
    project.cards.splice(drop, 1);
  }
}

const cardIn = (project: JobProject, cardId: string) => {
  const card = project.cards.find((c) => c.id === cardId);
  if (!card) throw new JobError("There's no such job on the board.", "not_found", 404);
  return card;
};

export function moveCard(project: JobProject, cardId: string, column: JobColumn) {
  cardIn(project, cardId).column = column;
}

/**
 * 👍 moves a found job to Shortlisted, 👎 to Not for me; a reason may suggest a profile change, which waits on the
 * profile card for you to accept. Clearing the reaction keeps the card where it is.
 */
export function react(project: JobProject, cardId: string, input: ReactToJobInput) {
  const card = cardIn(project, cardId);
  card.reaction = input.reaction;
  card.reason = input.reaction && input.reason ? input.reason : null;
  if (input.reaction === "down") card.column = "not_for_me";
  else if (input.reaction === "up" && (card.column === "found" || card.column === "not_for_me"))
    card.column = "shortlisted";
  if (!input.reaction || !input.reason) return;
  const suggestion = suggestFrom(
    input.reaction,
    input.reason,
    { company: factValue(card.facts, "company") },
    project.profile,
  );
  if (!suggestion) return;
  const same = project.suggestions.some(
    (s) => s.field === suggestion.field && s.value.toLowerCase() === suggestion.value.toLowerCase(),
  );
  if (!same)
    project.suggestions = [...project.suggestions, { id: randomUUID(), ...suggestion }].slice(
      -MAX_SUGGESTIONS,
    );
}

/** Accepting a suggestion adds its value to its profile list; either way it goes. */
export function answerSuggestion(project: JobProject, id: string, accept: boolean) {
  const suggestion = project.suggestions.find((s) => s.id === id);
  if (!suggestion) throw new JobError("That suggestion is gone.", "not_found", 404);
  project.suggestions = project.suggestions.filter((s) => s.id !== id);
  if (accept)
    project.profile = mergeProfile(project.profile, {
      [suggestion.field]: [...project.profile[suggestion.field], suggestion.value],
    });
}

import { randomUUID } from "node:crypto";

import {
  addToList,
  companyPrints,
  mergeOffer,
  parseEntries,
  removeFromList,
  sizeFromPrice,
  suggestFrom,
  type Suggested,
} from "@mrog/clients";
import {
  MAX_CLIENT_SUGGESTIONS,
  MAX_LEADS,
  type ClientProject,
  type Lead,
  type LeadColumn,
  type ListEntry,
  type ListName,
  type ReactToLeadInput,
} from "@mrog/shared";

import { ClientError } from "./state";

/** The board and your lists: plain functions on a project; the service saves and publishes after each. */

/**
 * Adds a lead. When the board is full, the oldest "Not a fit" lead makes room, else the weakest "New" one, and only
 * for a stronger lead ("weaker": not added). A lead you're working (shortlisted, contacted, replied, won) is never
 * dropped: with only those, the lead isn't added ("full"), and the scan says the board is full (3.2).
 */
export function addLead(project: ClientProject, lead: Lead): "added" | "weaker" | "full" {
  if (project.leads.length < MAX_LEADS) {
    project.leads.push(lead);
    return "added";
  }
  const notFit = project.leads.findIndex((l) => l.column === "not_a_fit");
  if (notFit >= 0) {
    project.leads.splice(notFit, 1);
    project.leads.push(lead);
    return "added";
  }
  const weakest = project.leads
    .map((l, index) => ({ l, index }))
    .filter(({ l }) => l.column === "new")
    .toSorted((a, b) => a.l.score - b.l.score)[0];
  if (!weakest) return "full";
  if (weakest.l.score >= lead.score) return "weaker";
  project.leads.splice(weakest.index, 1);
  project.leads.push(lead);
  return "added";
}

const leadIn = (project: ClientProject, leadId: string) => {
  const lead = project.leads.find((l) => l.id === leadId);
  if (!lead) throw new ClientError("There's no such lead on the board.", "not_found", 404);
  return lead;
};

export function moveLead(project: ClientProject, leadId: string, column: LeadColumn) {
  const lead = leadIn(project, leadId);
  lead.column = column;
  lead.updatedAt = new Date().toISOString();
}

/** 👍 shortlists a new lead, 👎 moves it to Not a fit; a reason may suggest a profile change, waiting for you. */
export function reactToLead(project: ClientProject, leadId: string, input: ReactToLeadInput) {
  const lead = leadIn(project, leadId);
  lead.reaction = input.reaction;
  lead.reason = input.reaction && input.reason ? input.reason : null;
  if (input.reaction === "down") lead.column = "not_a_fit";
  else if (input.reaction === "up" && (lead.column === "new" || lead.column === "not_a_fit"))
    lead.column = "shortlisted";
  if (!input.reaction) return;
  const suggestion = suggestFrom(input.reaction, input.reason ?? "", lead, project.profile, project.leads);
  if (suggestion) addSuggestions(project, [suggestion]);
}

/** Adds suggestions not already waiting (by field and value), keeping the last few. */
export function addSuggestions(project: ClientProject, suggested: readonly Suggested[]) {
  for (const suggestion of suggested) {
    const same = project.suggestions.some(
      (s) => s.field === suggestion.field && s.value.toLowerCase() === suggestion.value.toLowerCase(),
    );
    if (!same)
      project.suggestions = [...project.suggestions, { id: randomUUID(), ...suggestion }].slice(
        -MAX_CLIENT_SUGGESTIONS,
      );
  }
}

/** After a profile change: the client size your price states, suggested (3.3). */
export const suggestFromPrice = (project: ClientProject) =>
  addSuggestions(project, sizeFromPrice(project.profile));

/** Accepting a suggestion changes the profile; either way it goes. */
export function answerSuggestion(project: ClientProject, id: string, accept: boolean) {
  const suggestion = project.suggestions.find((s) => s.id === id);
  if (!suggestion) throw new ClientError("That suggestion is gone.", "not_found", 404);
  project.suggestions = project.suggestions.filter((s) => s.id !== id);
  if (!accept) return;
  const { field, value } = suggestion;
  project.profile = mergeOffer(
    project.profile,
    field === "sizeMax" || field === "sizeMin"
      ? { [field]: Number(value) }
      : { [field]: [...project.profile[field], value] },
  );
}

export function setNote(project: ClientProject, leadId: string, note: string) {
  leadIn(project, leadId).note = note;
}

export function setWatch(project: ClientProject, leadId: string, watch: boolean) {
  leadIn(project, leadId).watch = watch;
}

/**
 * Forgets a lead: its card and quotes go. With `block` it goes on your do-not-contact list and never comes back;
 * without, a later scan may find it again.
 */
export function forgetLead(project: ClientProject, leadId: string, block: boolean) {
  const lead = leadIn(project, leadId);
  project.leads = project.leads.filter((l) => l.id !== leadId);
  const prints = new Set(companyPrints({ name: lead.company, domain: lead.domain }));
  if (block)
    project.lists = addToList(project.lists, "doNotContact", [{ name: lead.company, domain: lead.domain }]);
  else project.seen = project.seen.filter((print) => !prints.has(print));
}

/** Adds pasted lines or a CSV's rows to one of your lists; how many were read. */
export function addLines(project: ClientProject, list: ListName, text: string): number {
  const entries = parseEntries(text);
  project.lists = addToList(project.lists, list, entries);
  return entries.length;
}

export function removeEntry(project: ClientProject, list: ListName, entry: ListEntry) {
  project.lists = removeFromList(project.lists, list, entry);
}

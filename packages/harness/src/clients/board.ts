import { randomUUID } from "node:crypto";

import {
  addToList,
  companyPrints,
  mergeOffer,
  parseEntries,
  removeFromList,
  suggestFrom,
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

/** Adds a lead; when the board is full, the oldest "Not a fit" goes first, then the weakest "New" one. */
export function addLead(project: ClientProject, lead: Lead) {
  project.leads.push(lead);
  while (project.leads.length > MAX_LEADS) {
    const notFit = project.leads.findIndex((l) => l.column === "not_a_fit");
    const drop =
      notFit >= 0
        ? notFit
        : (project.leads
            .map((l, index) => ({ l, index }))
            .filter(({ l }) => l.column === "new")
            .toSorted((a, b) => a.l.score - b.l.score)[0]?.index ?? 0);
    project.leads.splice(drop, 1);
  }
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
  if (!suggestion) return;
  const same = project.suggestions.some(
    (s) => s.field === suggestion.field && s.value.toLowerCase() === suggestion.value.toLowerCase(),
  );
  if (!same)
    project.suggestions = [...project.suggestions, { id: randomUUID(), ...suggestion }].slice(
      -MAX_CLIENT_SUGGESTIONS,
    );
}

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

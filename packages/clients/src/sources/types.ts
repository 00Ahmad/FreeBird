import type { ClientKeyName, LeadKind, OfferProfile } from "@mrog/shared";

import type { Playbook } from "../playbooks";

/** What a register search asks for. */
export interface RegisterQuery {
  words: string[];
  place: string;
  sicCodes: string[];
  /** yyyy-mm-dd */
  incorporatedFrom: string | null;
  incorporatedTo: string | null;
  /** Which page of results to ask for (from 1), for a register that pages; set by the scan. */
  page?: number;
}

/** A request the harness sends for a register: plain data, so this package never reaches the network. */
export interface RegisterRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

/** One entry of an official list: a company, a tender notice, or licensed premises. */
export interface RegisterRecord {
  register: string;
  id: string;
  /** Its public page. */
  url: string;
  name: string;
  kind: "company" | "tender" | "premises";
  place: string | null;
  industry: string | null;
  sicCodes: string[];
  employees: number | null;
  /** yyyy-mm-dd */
  incorporated: string | null;
  status: string | null;
  website: string | null;
  title: string | null;
  description: string | null;
  published: string | null;
  deadline: string | null;
  value: string | null;
}

/**
 * An official list or open data set, one file each: how to ask it (plain data), and how to read its answer. Adding a
 * register means adding one file and one line in the list. Each was checked against its own terms first.
 */
export interface Register {
  id: string;
  label: string;
  country: "UK";
  /** Which kind of lead its records are. */
  finds: LeadKind;
  /** The API key it needs from Settings, or null. */
  needsKey: ClientKeyName | null;
  /** Whether it can help with this profile. */
  fits(profile: OfferProfile, playbook: Playbook): boolean;
  /** The searches to run for a profile (at most a few). */
  queries(profile: OfferProfile, playbook: Playbook, now: Date): RegisterQuery[];
  request(query: RegisterQuery, key: string | null): RegisterRequest;
  parse(json: unknown): RegisterRecord[];
  /**
   * For a register that pages: whether this answer was the last page of `query`. Without it, the register has no
   * paging (each scan asks the same, recent window), and nothing is remembered.
   */
  isLastPage?(json: unknown, query: RegisterQuery): boolean;
}

/** An empty record to fill in. */
export const record = (
  fields: Partial<RegisterRecord> & Pick<RegisterRecord, "register" | "id" | "url" | "name" | "kind">,
): RegisterRecord => ({
  place: null,
  industry: null,
  sicCodes: [],
  employees: null,
  incorporated: null,
  status: null,
  website: null,
  title: null,
  description: null,
  published: null,
  deadline: null,
  value: null,
  ...fields,
});

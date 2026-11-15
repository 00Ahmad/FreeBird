import {
  companiesHouse,
  lookalikeProfile,
  parseEntries,
  type LookalikeSeed,
  type Register,
  type RegisterRecord,
} from "@mrog/clients";
import { MAX_LOOKALIKE_CLIENTS, type ListEntry, type LookalikeProfile } from "@mrog/shared";

import type { Registers } from "./registers";

const yearsBefore = (now: Date, years: number) => {
  const date = new Date(now);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
};

/** Companies like your favourite clients, from Companies House. */
export async function companiesHouseLookalike(
  registers: Registers,
  profile: LookalikeProfile,
  now: Date,
  signal: AbortSignal,
): Promise<{ register: Register; records: RegisterRecord[] } | { error: string }> {
  if (!registers.ready(companiesHouse))
    return { error: "add a Companies House API key in the Client Bot's settings" };
  const result = await registers.search(
    companiesHouse,
    [
      {
        words: [],
        place: profile.area ?? "",
        sicCodes: profile.sicCodes,
        incorporatedFrom: profile.ageMax !== null ? yearsBefore(now, profile.ageMax) : null,
        incorporatedTo: profile.ageMin !== null ? yearsBefore(now, profile.ageMin) : null,
      },
    ],
    signal,
  );
  return "error" in result ? result : { register: companiesHouse, records: result.records };
}

/**
 * Your favourite clients looked up in Companies House by name, and what they share worked out by code. The clients
 * stay on this computer and are never shown as leads.
 */
export async function learnLookalikes(
  registers: Registers,
  text: string,
  now: Date,
  signal: AbortSignal,
): Promise<{ clients: ListEntry[]; profile: LookalikeProfile | null; note: string }> {
  const clients = parseEntries(text).slice(0, MAX_LOOKALIKE_CLIENTS);
  const seeds: LookalikeSeed[] = [];
  for (const client of clients) {
    const record = await registers.findCompany(client.name, signal);
    if (record)
      seeds.push({
        sicCodes: record.sicCodes,
        employees: record.employees,
        area: record.place?.split(",")[0]?.trim() ?? null,
        incorporated: record.incorporated,
      });
  }
  const profile = lookalikeProfile(seeds, now);
  if ("error" in profile) return { clients, profile: null, note: profile.error };
  return {
    clients,
    profile,
    note: `Found ${seeds.length} of your ${clients.length} clients in Companies House.`,
  };
}

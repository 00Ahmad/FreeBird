import type { Register, RegisterQuery, RegisterRecord, RegisterRequest } from "@mrog/clients";
import { companyProfile, companyRecord, foodHygiene, nameSearch, premisesByName } from "@mrog/clients";
import type { ClientKeyName } from "@mrog/shared";
import type { Vault } from "@mrog/vault";

/**
 * Sends a register's requests (the requests themselves are plain data from @mrog/clients) and reads the answers.
 * Keys come from the vault (the OS keychain), never from the model, and never appear in a page or a log.
 */

export const KEY_NAMES: Record<ClientKeyName, string> = { companiesHouse: "CLIENTBOT_COMPANIES_HOUSE_KEY" };

const TIMEOUT_MS = 20_000;

export class RegisterError extends Error {}

export type FetchJson = (request: RegisterRequest, signal: AbortSignal) => Promise<unknown>;

/** A fetch of one register request, as JSON; a plain error when it fails. */
export function fetchJson(fetchImpl: typeof fetch): FetchJson {
  return async (request, signal) => {
    const res = await fetchImpl(request.url, {
      method: request.method,
      headers: { "user-agent": "FreeBird/0.1 (+local assistant)", ...request.headers },
      ...(request.body ? { body: request.body } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (res.status === 404) return null;
    if (res.status === 401) throw new RegisterError("the key was refused");
    if (res.status === 403 || res.status === 429)
      throw new RegisterError("too many requests; try again in a few minutes");
    if (!res.ok) throw new RegisterError(`it answered HTTP ${res.status}`);
    return res.json();
  };
}

export interface RegisterDeps {
  vault: Pick<Vault, "get">;
  fetch: FetchJson;
}

export function createRegisters(deps: () => RegisterDeps) {
  const keyOf = (name: ClientKeyName | null) => (name ? (deps().vault.get(KEY_NAMES[name]) ?? null) : null);

  /** Whether a register can run now (it needs no key, or its key is saved). */
  const ready = (register: Register) => !register.needsKey || !!keyOf(register.needsKey);

  /** Runs a register's queries; the records, or a plain reason it couldn't. */
  const search = async (
    register: Register,
    queries: RegisterQuery[],
    signal: AbortSignal,
  ): Promise<{ records: RegisterRecord[] } | { error: string }> => {
    const key = keyOf(register.needsKey);
    if (register.needsKey && !key) return { error: "no API key saved" };
    const records: RegisterRecord[] = [];
    try {
      for (const query of queries)
        records.push(...register.parse(await deps().fetch(register.request(query, key), signal)));
    } catch (error) {
      if (signal.aborted) throw error;
      return { error: (error as Error).message };
    }
    const seen = new Set<string>();
    return { records: records.filter((r) => !seen.has(r.id) && !!seen.add(r.id)) };
  };

  /** One company found by name in Companies House, with its profile (for lookalikes). Null when not found. */
  const findCompany = async (name: string, signal: AbortSignal): Promise<RegisterRecord | null> => {
    const key = keyOf("companiesHouse");
    if (!key) throw new RegisterError("Add a Companies House API key first.");
    const found = (await deps().fetch(nameSearch(name, key), signal)) as {
      items?: { company_number?: string }[];
    } | null;
    const number = found?.items?.[0]?.company_number;
    if (!number) return null;
    const profile = await deps().fetch(companyProfile(number, key), signal);
    return profile ? companyRecord(profile as never) : null;
  };

  /** Food businesses with this name near this place (no key needed). */
  const findPremises = async (name: string, place: string, signal: AbortSignal): Promise<RegisterRecord[]> =>
    foodHygiene.parse(await deps().fetch(premisesByName(name, place), signal));

  return { ready, search, findCompany, findPremises, hasKey: (name: ClientKeyName) => !!keyOf(name) };
}

export type Registers = ReturnType<typeof createRegisters>;

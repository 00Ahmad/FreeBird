import type { OfferProfile } from "@mrog/shared";

import { daysBefore } from "../dates";
import { anyIndustry } from "../profile";
import { isUkArea, placeOf } from "../region";
import { sicCodesFor } from "./sic";
import {
  record,
  type Register,
  type RegisterQuery,
  type RegisterRecord,
  type RegisterRequest,
} from "./types";

/**
 * UK Companies House: the official register of every UK company. Its public data API is free with a key you create
 * at developer.company-information.service.gov.uk and add in the Client Bot's settings. Basic auth, the key as the
 * user name. Rate limit: 600 requests per 5 minutes; a scan sends a handful.
 */
const API = "https://api.company-information.service.gov.uk";
const PUBLIC = "https://find-and-update.company-information.service.gov.uk/company/";

const auth = (key: string | null): Record<string, string> =>
  key ? { authorization: `Basic ${btoa(`${key}:`)}` } : {};

interface ChItem {
  company_name?: string;
  title?: string;
  company_number?: string;
  company_status?: string;
  date_of_creation?: string;
  sic_codes?: string[];
  registered_office_address?: {
    address_line_1?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
  };
  address?: { address_line_1?: string; locality?: string; region?: string; postal_code?: string };
}

const placeOfItem = (item: ChItem) => {
  const a = item.registered_office_address ?? item.address;
  return [a?.locality, a?.region, a?.postal_code].filter(Boolean).join(", ") || null;
};

/** One company from any of the register's answers (a search item or a company profile). */
export function companyRecord(item: ChItem): RegisterRecord | null {
  const name = (item.company_name ?? item.title ?? "").trim();
  const number = (item.company_number ?? "").trim();
  if (!name || !/^[A-Z0-9]{6,10}$/i.test(number)) return null;
  return record({
    register: "companies-house",
    id: number,
    url: `${PUBLIC}${number}`,
    name,
    kind: "company",
    place: placeOfItem(item),
    sicCodes: (item.sic_codes ?? []).filter((c) => /^\d{4,5}$/.test(c)),
    incorporated: /^\d{4}-\d{2}-\d{2}$/.test(item.date_of_creation ?? "") ? item.date_of_creation! : null,
    status: item.company_status ?? null,
  });
}

/** The advanced search request for a query. */
export function advancedSearch(query: RegisterQuery, key: string | null): RegisterRequest {
  const params = new URLSearchParams({ company_status: "active", size: "50" });
  if (query.place) params.set("location", query.place);
  if (query.sicCodes.length > 0) params.set("sic_codes", query.sicCodes.join(","));
  if (query.incorporatedFrom) params.set("incorporated_from", query.incorporatedFrom);
  if (query.incorporatedTo) params.set("incorporated_to", query.incorporatedTo);
  return {
    url: `${API}/advanced-search/companies?${params}`,
    method: "GET",
    headers: { accept: "application/json", ...auth(key) },
  };
}

/** Finding one company by name (for your favourite clients), then its profile by number. */
export const nameSearch = (name: string, key: string | null): RegisterRequest => ({
  url: `${API}/search/companies?${new URLSearchParams({ q: name, items_per_page: "1" })}`,
  method: "GET",
  headers: { accept: "application/json", ...auth(key) },
});
export const companyProfile = (number: string, key: string | null): RegisterRequest => ({
  url: `${API}/company/${encodeURIComponent(number)}`,
  method: "GET",
  headers: { accept: "application/json", ...auth(key) },
});

const itemsOf = (json: unknown): ChItem[] => {
  const items = (json as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as ChItem[]) : [];
};

export const parseItems = (json: unknown): RegisterRecord[] =>
  itemsOf(json).flatMap((item) => companyRecord(item) ?? []);

export const companiesHouse: Register = {
  id: "companies-house",
  label: "UK Companies House",
  country: "UK",
  finds: "quiet",
  needsKey: "companiesHouse",
  fits: (profile) => isUkArea(profile.areas) && placeOf(profile.areas) !== "",
  queries(profile: OfferProfile, _playbook, now) {
    const base = {
      words: [],
      place: placeOf(profile.areas),
      sicCodes: anyIndustry(profile) ? [] : sicCodesFor(profile.industries),
      incorporatedTo: null,
    };
    // A search by place alone, any industry, would be every company in town: only with codes, or for new companies.
    const queries: RegisterQuery[] = [];
    if (base.sicCodes.length > 0) queries.push({ ...base, incorporatedFrom: null });
    if (profile.signals.includes("new_company"))
      queries.push({ ...base, incorporatedFrom: daysBefore(now, 365) });
    return queries;
  },
  request: advancedSearch,
  parse: parseItems,
};

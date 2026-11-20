import { clip, stripHtml } from "@mrog/jobs";

import { daysBefore } from "../dates";
import { isUkArea } from "../region";
import { record, type Register, type RegisterRecord } from "./types";

/**
 * UK Find a Tender (FTS): public tenders above the procurement thresholds, from the whole UK (Contracts Finder covers
 * England's smaller ones). Its OCDS API needs no key: `GET /api/1.0/ocdsReleasePackages` with `stages`, `limit` (up to
 * 100), `updatedFrom`, `updatedTo` and a `cursor` (docs at find-tender.service.gov.uk/apidocumentation, and a live
 * answer, checked 2026-11-20). Data under the Open Government Licence v3.0; the terms forbid crawling that disrupts
 * the service, and a 429 asks to wait for its Retry-After. One request a scan: the newest notices still open.
 *
 * It can't be searched by words, so the scan keeps only tenders that name what you sell (code, before any model).
 */
const API = "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages";

/** Notices updated within this many days are asked for. */
export const FTS_DAYS = 30;

interface Release {
  id?: string;
  ocid?: string;
  date?: string;
  buyer?: { name?: string };
  tender?: {
    title?: string;
    description?: string;
    status?: string;
    tenderPeriod?: { endDate?: string };
    value?: { amount?: number; currency?: string };
  };
  links?: { rel?: string; href?: string }[];
}

const day = (raw: string | undefined) => (raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null);

export const findATender: Register = {
  id: "find-a-tender",
  label: "UK Find a Tender (public tenders)",
  country: "UK",
  finds: "asking",
  needsKey: null,
  fits: (profile) => isUkArea(profile.areas),
  queries: (_profile, _playbook, now) => [
    { words: [], place: "", sicCodes: [], incorporatedFrom: daysBefore(now, FTS_DAYS), incorporatedTo: null },
  ],
  request: (query) => {
    const params = new URLSearchParams({ stages: "tender", limit: "100" });
    if (query.incorporatedFrom) params.set("updatedFrom", `${query.incorporatedFrom}T00:00:00`);
    return { url: `${API}?${params}`, method: "GET", headers: { accept: "application/json" } };
  },
  parse(json) {
    const list = (json as { releases?: unknown })?.releases;
    if (!Array.isArray(list)) return [];
    const byProcurement = new Map<string, RegisterRecord>();
    for (const release of list as Release[]) {
      const ocid = release.ocid?.trim();
      const buyer = release.buyer?.name?.trim();
      const title = release.tender?.title?.trim();
      if (!ocid || !buyer || !title || release.tender?.status !== "active") continue;
      // One procurement has several releases: the newest one stands for it.
      const known = byProcurement.get(ocid);
      if (known && (known.published ?? "") >= (day(release.date) ?? "")) continue;
      const canonical = release.links?.find((link) => link.rel === "canonical")?.href;
      const value = release.tender.value?.amount;
      byProcurement.set(
        ocid,
        record({
          register: "find-a-tender",
          id: ocid,
          // No public notice page is documented: the notice's own address if it gives one, else its API record.
          url: canonical ?? `${API}/${encodeURIComponent(release.id ?? ocid)}`,
          name: buyer,
          kind: "tender",
          title,
          description: clip(stripHtml(release.tender.description ?? ""), 3000),
          published: day(release.date),
          deadline: day(release.tender.tenderPeriod?.endDate),
          value: value
            ? `${release.tender.value?.currency === "GBP" ? "£" : ""}${value.toLocaleString("en-GB")}`
            : null,
          status: release.tender.status ?? null,
        }),
      );
    }
    return [...byProcurement.values()];
  },
};

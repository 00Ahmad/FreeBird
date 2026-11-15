import { clip, stripHtml } from "@mrog/jobs";

import { daysBefore } from "../dates";
import { serviceNamesOf } from "../playbooks";
import { isUkArea } from "../region";
import { record, type Register, type RegisterRecord } from "./types";

/**
 * UK Contracts Finder: public sector tenders in England. Its search API is public (no key); too many requests in a
 * short time get a 403 for five minutes, so a scan sends one request per tender word, at most three.
 */
const API = "https://www.contractsfinder.service.gov.uk/api/rest/2/search_notices/json";
const PUBLIC = "https://www.contractsfinder.service.gov.uk/Notice/";

interface Notice {
  id?: string;
  title?: string;
  description?: string;
  organisationName?: string;
  deadlineDate?: string | null;
  publishedDate?: string | null;
  valueLow?: number;
  valueHigh?: number;
  postcode?: string | null;
  regionText?: string | null;
  noticeStatus?: string;
}

const day = (raw: string | null | undefined) =>
  raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;

const money = (low?: number, high?: number) => {
  const fmt = (n: number) => `£${n.toLocaleString("en-GB")}`;
  if (low && high && high > low) return `${fmt(low)}–${fmt(high)}`;
  if (low || high) return fmt((low || high)!);
  return null;
};

export const contractsFinder: Register = {
  id: "contracts-finder",
  label: "UK Contracts Finder (public tenders)",
  country: "UK",
  finds: "asking",
  needsKey: null,
  fits: (profile) => isUkArea(profile.areas),
  queries: (profile, playbook, now) =>
    (playbook.tenderWords.length > 0 ? playbook.tenderWords : serviceNamesOf(profile))
      .slice(0, 3)
      .map((word) => ({
        words: [word],
        place: "",
        sicCodes: [],
        incorporatedFrom: daysBefore(now, 120),
        incorporatedTo: null,
      })),
  request: (query) => ({
    url: API,
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      searchCriteria: {
        types: ["Contract"],
        statuses: ["Open"],
        keyword: query.words.join(" "),
        ...(query.incorporatedFrom ? { publishedFrom: query.incorporatedFrom } : {}),
      },
      size: 20,
    }),
  }),
  parse(json) {
    const list = (json as { noticeList?: unknown })?.noticeList;
    if (!Array.isArray(list)) return [];
    return (list as { item?: Notice }[]).flatMap(({ item }): RegisterRecord[] => {
      const id = item?.id?.trim();
      const buyer = item?.organisationName?.trim();
      const title = item?.title?.trim();
      if (!item || !id || !buyer || !title) return [];
      return [
        record({
          register: "contracts-finder",
          id,
          url: `${PUBLIC}${id}`,
          name: buyer,
          kind: "tender",
          place: [item.regionText, item.postcode].filter(Boolean).join(", ") || null,
          title,
          description: clip(stripHtml((item.description ?? "").replace(/&#0*39;/g, "'")), 3000),
          published: day(item.publishedDate),
          deadline: day(item.deadlineDate),
          value: money(item.valueLow, item.valueHigh),
          status: item.noticeStatus ?? null,
        }),
      ];
    });
  },
};

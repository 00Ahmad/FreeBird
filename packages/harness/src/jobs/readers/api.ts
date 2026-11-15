import { sourceFor } from "@mrog/jobs";

import type { PageReader } from "./types";

/** A job system's public job list (Greenhouse, Lever): clean data, no page to load. */
export function apiReader(fetchImpl: typeof fetch): PageReader {
  return {
    id: "api",
    async read(url, { signal }) {
      const found = sourceFor(url);
      if (!found) return null;
      const res = await fetchImpl(found.apiUrl, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { accept: "application/json", "user-agent": "FreeBird/0.1 (+local assistant)" },
      });
      if (res.status === 404 || res.status === 410)
        return { url, title: "", text: "", links: [], reader: "api", humanCheck: false, status: res.status };
      if (!res.ok) throw new Error(`${found.source.label} answered HTTP ${res.status}`);
      const page = found.source.toPage(await res.json(), url);
      if (!page) throw new Error(`${found.source.label} sent something unexpected`);
      return { url, ...page, reader: "api", humanCheck: false };
    },
  };
}

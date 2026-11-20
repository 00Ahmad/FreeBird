import { describe, expect, it } from "vitest";

import { pickFromList, listPickLimit } from "./list-pick";
import { emptyProfile, mergeProfile } from "./profile";

const profile = mergeProfile(emptyProfile(), {
  titles: ["Backend Engineer"],
  relatedTitles: ["Platform Engineer"],
  workplace: ["remote"],
  places: ["Leeds"],
});
const link = (text: string, n: number, place?: string) => ({
  text,
  url: `https://boards.greenhouse.io/acme/jobs/${n}`,
  ...(place ? { place } : {}),
});

describe("picking jobs from a list by code", () => {
  it("keeps the titles you want, in a place that suits you first, up to a limit", () => {
    const links = [
      link("Senior Product Manager", 1, "Remote"),
      link("Backend Engineer, Payments", 2, "Berlin"),
      link("Senior Backend Engineer (Ruby)", 3, "Remote, EMEA"),
      link("Platform Engineer", 4, "Leeds, UK"),
      link("Engineer, Backend", 5, "Remote"),
    ];
    expect(pickFromList(links, profile, 10)).toEqual([
      "https://boards.greenhouse.io/acme/jobs/3",
      "https://boards.greenhouse.io/acme/jobs/4",
      "https://boards.greenhouse.io/acme/jobs/2",
    ]);
    expect(pickFromList(links, profile, 1)).toHaveLength(1);
  });

  it("queues a few jobs per list, never the whole page budget", () => {
    expect(listPickLimit(1)).toBe(5);
    expect(listPickLimit(5)).toBe(10);
    expect(listPickLimit(50)).toBe(15);
  });
});

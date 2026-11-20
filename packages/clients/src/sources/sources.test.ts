import { describe, expect, it } from "vitest";

import { emptyOffer, mergeOffer } from "../profile";
import { payroll } from "../playbooks/payroll";
import { companiesHouse, companyRecord, nameSearch } from "./companies-house";
import { contractsFinder } from "./contracts-finder";
import { findATender } from "./find-a-tender";
import { foodHygiene, premisesCount, premisesFit } from "./food-hygiene";
import { REGISTERS, recordFacts, recordPage, recordSignals, registersFor, sicCodesFor } from "./index";

const NOW = new Date("2026-11-14T12:00:00Z");
const profile = mergeOffer(emptyOffer(), {
  offer: "Payroll",
  areas: ["Leeds"],
  industries: ["restaurants"],
  signals: ["asking", "hiring", "new_company"],
});

// Made-up answers in each register's shape (checked against the live services in November 2026).
const CH_ANSWER = {
  items: [
    {
      company_name: "BRIGHTSIDE KITCHENS LTD",
      company_number: "12345678",
      company_status: "active",
      date_of_creation: "2026-09-01",
      sic_codes: ["56101"],
      registered_office_address: {
        address_line_1: "1 Test Street",
        locality: "Leeds",
        postal_code: "LS1 1AA",
      },
    },
    { company_name: "", company_number: "1" },
  ],
};
const CF_ANSWER = {
  hitCount: 1,
  noticeList: [
    {
      score: 1,
      item: {
        id: "aaaa-bbbb",
        title: "Provision of payroll services",
        description: "The Test Trust is seeking a payroll provider.&#039;s",
        organisationName: "The Test Trust",
        deadlineDate: "2026-12-20T12:00:00+00:00",
        publishedDate: "2026-11-01T09:00:00+00:00",
        valueLow: 50000,
        valueHigh: 80000,
        postcode: "LS1 1AA",
        regionText: "Yorkshire and The Humber",
        noticeStatus: "Open",
      },
    },
  ],
};
const FSA_ANSWER = {
  establishments: [
    {
      FHRSID: 1,
      BusinessName: "Pine Cafe",
      BusinessType: "Restaurant/Cafe/Canteen",
      AddressLine1: "2 Test Road",
      AddressLine4: "Leeds",
      PostCode: "LS2 2BB",
    },
    {
      FHRSID: 2,
      BusinessName: "Pine Cafe",
      BusinessType: "Restaurant/Cafe/Canteen",
      AddressLine4: "Leeds",
      PostCode: "LS3 3CC",
    },
    { FHRSID: 3, BusinessName: "Corner Shop", BusinessType: "Retailers - other", AddressLine4: "Leeds" },
  ],
  meta: {},
};

describe("registers", () => {
  it("each has its own id; only those that fit the profile are used", () => {
    expect(new Set(REGISTERS.map((r) => r.id)).size).toBe(REGISTERS.length);
    expect(registersFor(profile, payroll).map((r) => r.id)).toEqual([
      "contracts-finder",
      "find-a-tender",
      "companies-house",
      "food-hygiene",
    ]);
    expect(registersFor({ ...profile, areas: ["Toronto"] }, payroll)).toEqual([]);
  });

  it("map industries to UK industry codes", () => {
    expect(sicCodesFor(["restaurants", "care homes"])).toEqual(["56101", "56102", "87100", "87300"]);
    expect(sicCodesFor(["underwater basket weaving"])).toEqual([]);
  });
});

describe("register pages across scans (2.2)", () => {
  it("are remembered by a key that doesn't change from day to day", async () => {
    const { queryKey } = await import("./register-pages");
    const today = companiesHouse.queries(profile, payroll, NOW);
    const later = companiesHouse.queries(profile, payroll, new Date("2026-11-20T12:00:00Z"));
    expect(today.map((q) => queryKey(companiesHouse, q))).toEqual(
      later.map((q) => queryKey(companiesHouse, q)),
    );
    // The two queries (by code, and new companies) still have their own keys.
    expect(new Set(today.map((q) => queryKey(companiesHouse, q))).size).toBe(today.length);
  });
});

describe("Find a Tender (6.3)", () => {
  // Shaped like the live answer checked on 2026-11-20 (made-up content).
  const ANSWER = {
    releases: [
      {
        id: "110001-2026",
        ocid: "ocds-test-0001",
        date: "2026-11-10T10:00:00Z",
        buyer: { name: "Test City Council" },
        tender: {
          title: "Payroll services",
          description: "<p>The council seeks a payroll provider.</p>",
          status: "active",
          tenderPeriod: { endDate: "2026-12-20T12:00:00Z" },
          value: { amount: 250000, currency: "GBP" },
        },
        links: [{ rel: "canonical", href: "https://notices.test/0001" }],
      },
      {
        id: "110002-2026",
        ocid: "ocds-test-0001",
        date: "2026-11-12T10:00:00Z",
        buyer: { name: "Test City Council" },
        tender: { title: "Payroll services (amended)", status: "active" },
      },
      {
        id: "3",
        ocid: "ocds-test-0003",
        buyer: { name: "Closed Trust" },
        tender: { title: "Cleaning", status: "complete" },
      },
    ],
    links: { next: "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?cursor=abc" },
  };

  it("asks for open tenders updated lately, with no key", () => {
    const [query] = findATender.queries(profile, payroll, NOW);
    const request = findATender.request(query!, null);
    expect(request.url).toBe(
      "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?stages=tender&limit=100&updatedFrom=2026-10-15T00%3A00%3A00",
    );
    expect(findATender.needsKey).toBeNull();
  });

  it("reads one record per procurement, the newest release, open ones only", () => {
    const records = findATender.parse(ANSWER);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      register: "find-a-tender",
      id: "ocds-test-0001",
      name: "Test City Council",
      kind: "tender",
      title: "Payroll services (amended)",
      published: "2026-11-12",
    });
    expect(findATender.parse({ nothing: true })).toEqual([]);
  });
});

describe("Companies House", () => {
  it("asks by place and industry codes, and for new companies, with the key as basic auth", () => {
    const queries = companiesHouse.queries(profile, payroll, NOW);
    expect(queries).toHaveLength(2);
    const request = companiesHouse.request(queries[1]!, "test-key");
    expect(request.url).toBe(
      "https://api.company-information.service.gov.uk/advanced-search/companies?company_status=active&size=50&start_index=0&location=Leeds&sic_codes=56101%2C56102&incorporated_from=2025-11-14",
    );
    expect(request.headers.authorization).toBe(`Basic ${btoa("test-key:")}`);
    // The next page starts where the last stopped (2.2).
    expect(companiesHouse.request({ ...queries[1]!, page: 3 }, "k").url).toContain("start_index=100");
    const items = (n: number) => Array.from({ length: n }, () => ({}));
    expect(companiesHouse.isLastPage!({ hits: "120", items: items(20) }, { ...queries[1]!, page: 3 })).toBe(
      true,
    );
    expect(companiesHouse.isLastPage!({ hits: "500", items: items(50) }, { ...queries[1]!, page: 3 })).toBe(
      false,
    );
    // Each place you serve, not only the first (2.3).
    expect(
      companiesHouse.queries({ ...profile, areas: ["Leeds", "York"] }, payroll, NOW).map((q) => q.place),
    ).toEqual(["Leeds", "Leeds", "York", "York"]);
    expect(companiesHouse.queries({ ...profile, industries: ["any"], signals: [] }, payroll, NOW)).toEqual(
      [],
    );
    expect(nameSearch("Brightside", "k").url).toContain("/search/companies?q=Brightside");
  });

  it("reads an answer; a bad item is skipped", () => {
    const records = companiesHouse.parse(CH_ANSWER);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "12345678",
      name: "BRIGHTSIDE KITCHENS LTD",
      place: "Leeds, LS1 1AA",
      incorporated: "2026-09-01",
      url: "https://find-and-update.company-information.service.gov.uk/company/12345678",
    });
    expect(companiesHouse.parse({ nope: 1 })).toEqual([]);
    expect(companyRecord({ company_name: "X", company_number: "bad number!" })).toBeNull();
  });
});

describe("Contracts Finder", () => {
  it("asks for open tenders by the playbook's words", () => {
    const [query] = contractsFinder.queries(profile, payroll, NOW);
    const request = contractsFinder.request(query!, null);
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body!)).toEqual({
      searchCriteria: {
        types: ["Contract"],
        statuses: ["Open"],
        keyword: "payroll",
        publishedFrom: "2026-07-17",
      },
      size: 20,
    });
  });

  it("reads a notice into a tender record", () => {
    const [tender] = contractsFinder.parse(CF_ANSWER);
    expect(tender).toMatchObject({
      name: "The Test Trust",
      kind: "tender",
      title: "Provision of payroll services",
      deadline: "2026-12-20",
      published: "2026-11-01",
      value: "£50,000–£80,000",
      url: "https://www.contractsfinder.service.gov.uk/Notice/aaaa-bbbb",
    });
    expect(tender!.description).toBe("The Test Trust is seeking a payroll provider.'s");
  });
});

describe("food hygiene ratings", () => {
  it("asks by place with the version header, and reads premises", () => {
    const [query] = foodHygiene.queries(profile, payroll, NOW);
    const request = foodHygiene.request(query!, null);
    expect(request.headers["x-api-version"]).toBe("2");
    expect(request.url).toContain("address=Leeds");
    expect(request.url).toContain("businessTypeId=1");
    const records = foodHygiene.parse(FSA_ANSWER);
    expect(premisesFit(records, ["restaurants"]).map((r) => r.id)).toEqual(["1", "2"]);
    expect(premisesCount(records).get("pine cafe")).toBe(2);
    expect(foodHygiene.fits({ ...profile, industries: ["software"] }, payroll)).toBe(false);
  });
});

describe("a record as a page", () => {
  it("quotes every fact from the record's own text", () => {
    const [company] = companiesHouse.parse(CH_ANSWER);
    const page = recordPage(company!);
    for (const fact of recordFacts(company!)) if (fact.quote) expect(page.text).toContain(fact.quote);
    expect(recordSignals(company!, NOW, NOW.toISOString())).toEqual([
      {
        kind: "new_company",
        quote: "Incorporated: 2026-09-01",
        url: company!.url,
        date: "2026-09-01",
        foundAt: NOW.toISOString(),
      },
    ]);
    const [tender] = contractsFinder.parse(CF_ANSWER);
    expect(recordSignals(tender!, NOW, NOW.toISOString())[0]).toMatchObject({
      kind: "asking",
      date: "2026-11-01",
    });
    expect(recordPage(tender!).text).toContain("Deadline: 2026-12-20");
  });
});

describe("staff from food premises (your choice after the live run)", () => {
  it("counts a staffed food business on the register as having staff, when you look for that trait", async () => {
    const { staffFromPremises } = await import("./food-hygiene");
    const [pine] = foodHygiene.parse(FSA_ANSWER);
    expect(staffFromPremises(pine!, ["has_staff"])).toEqual({
      kind: "trait",
      id: "has_staff",
      quote: "A restaurant/cafe/canteen on the food hygiene register",
      url: pine!.url,
    });
    expect(staffFromPremises(pine!, ["multi_site"])).toBeNull();
    expect(staffFromPremises({ ...pine!, industry: "Mobile caterer" }, ["has_staff"])).toBeNull();
    expect(staffFromPremises({ ...pine!, industry: "Other catering premises" }, ["has_staff"])).toBeNull();
    const [company] = companiesHouse.parse(CH_ANSWER);
    expect(staffFromPremises(company!, ["has_staff"])).toBeNull();
  });
});

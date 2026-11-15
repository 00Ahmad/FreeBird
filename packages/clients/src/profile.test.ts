import { describe, expect, it } from "vitest";

import { PLAYBOOKS, pickPlaybook, playbookOf, serviceNamesOf } from "./playbooks";
import { emptyOffer, mergeOffer, missingForScan, offerText, requirementsOf } from "./profile";

describe("the offer profile", () => {
  it("picks the playbook by code from what you sell", () => {
    expect(pickPlaybook("Outsourced payroll for small businesses").id).toBe("payroll");
    expect(pickPlaybook("We do bookkeeping and VAT returns").id).toBe("accounting");
    expect(pickPlaybook("A digital marketing agency: SEO and social").id).toBe("marketing");
    expect(pickPlaybook("Bespoke web development and mobile apps").id).toBe("software");
    expect(pickPlaybook("Managed IT support for offices").id).toBe("it_support");
    expect(pickPlaybook("Commercial window cleaning").id).toBe("generic");
    expect(new Set(PLAYBOOKS.map((p) => p.id)).size).toBe(PLAYBOOKS.length);
  });

  it("fills the playbook's defaults when what you sell is first given, keeping your own choices", () => {
    const profile = mergeOffer(emptyOffer(), { offer: "Payroll for restaurants", areas: ["Leeds", "Leeds"] });
    expect(profile.signals).toContain("hiring");
    expect(profile.traits).toContain("has_staff");
    expect(profile.buyerTitles.length).toBeGreaterThan(0);
    expect(profile.areas).toEqual(["Leeds"]);
    const edited = mergeOffer(profile, { signals: ["asking"] });
    expect(edited.signals).toEqual(["asking"]);
    // Saying more about the offer, with the same playbook, keeps your choice.
    expect(mergeOffer(edited, { offer: "Payroll and pensions for restaurants" }).signals).toEqual(["asking"]);
  });

  it("refuses a size range the wrong way round", () => {
    expect(() => mergeOffer(emptyOffer(), { sizeMin: 50, sizeMax: 5 })).toThrow(/bigger/);
  });

  it("says what a scan still needs", () => {
    expect(missingForScan(emptyOffer())).toHaveLength(4);
    const ready = mergeOffer(emptyOffer(), { offer: "Payroll", areas: ["Leeds"], industries: ["any"] });
    expect(missingForScan(ready)).toEqual([]);
  });

  it("numbers the requirements; 'any' industry is no requirement", () => {
    const profile = mergeOffer(emptyOffer(), {
      offer: "Payroll",
      areas: ["Leeds"],
      industries: ["restaurants"],
      sizeMin: 5,
      sizeMax: 50,
      mustHaves: ["Pays staff weekly"],
    });
    expect(requirementsOf(profile)).toEqual([
      { id: "r1", kind: "industry", text: "Works in one of: restaurants" },
      { id: "r2", kind: "place", text: "Based in, or can be served in: Leeds" },
      { id: "r3", kind: "size", text: "Has 5 to 50 staff" },
      { id: "r4", kind: "must", text: "Pays staff weekly" },
    ]);
    expect(requirementsOf({ ...profile, industries: ["any"] })[0]!.kind).toBe("place");
    expect(offerText(profile)).toContain("Sells: Payroll (Payroll)");
  });

  it("names the service the way a client asking for it would", () => {
    expect(serviceNamesOf(mergeOffer(emptyOffer(), { offer: "payroll" }))).toContain("payroll provider");
    const other = mergeOffer(emptyOffer(), { offer: "We offer commercial window cleaning for offices" });
    expect(playbookOf(other).id).toBe("generic");
    expect(serviceNamesOf(other)).toEqual(["commercial window cleaning"]);
  });
});

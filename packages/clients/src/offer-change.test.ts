import { nextInterviewState } from "@mrog/jobs";
import { describe, expect, it } from "vitest";

import { addToOffer, describeOfferChange, keepOfferSaid, OFFER_TOPICS } from "./offer-change";
import { emptyOffer, mergeOffer } from "./profile";

const base = mergeOffer(emptyOffer(), {
  offer: "IT support for accountants",
  areas: ["Leeds"],
  industries: ["accountants"],
});

describe("the Interviewer's change to the offer (4.4)", () => {
  it("adds list items instead of replacing the list, and takes out what you name", () => {
    const added = mergeOffer(base, addToOffer(base, { industries: ["law firms"] }));
    expect(added.industries).toEqual(["accountants", "law firms"]);
    const removed = mergeOffer(added, addToOffer(added, {}, { industries: ["accountants"] }));
    expect(removed.industries).toEqual(["law firms"]);
  });

  it("keeps only what you said", () => {
    const { change, dropped } = keepOfferSaid(
      { industries: ["law firms", "dentists"], sizeMin: 10, sizeMax: 500, price: "£300 a month" },
      "Also law firms, with 10 to 50 staff",
    );
    expect(change).toEqual({ industries: ["law firms"], sizeMin: 10 });
    expect(dropped).toEqual(["dentists", "at most 500 staff", 'the price "£300 a month"']);
    expect(keepOfferSaid({ price: "£300 a month" }, "We charge 300 a month").change.price).toBe(
      "£300 a month",
    );
    // A form of a word you said counts (found in the benchmark: "accounting" for "accountants").
    expect(
      keepOfferSaid({ industries: ["accounting"] }, "IT support for accountants").change.industries,
    ).toEqual(["accounting"]);
    // What you sell must be what you said too.
    expect(keepOfferSaid({ offer: '{"industries": ["law firms"]}' }, "Also add law firms").dropped).toEqual([
      'what you sell: "{"industries": ["law firms"]}"',
    ]);
  });

  it("says what changed, with the kind of service picked (1.7)", () => {
    const after = mergeOffer(emptyOffer(), {
      offer: "IT support for accountants",
      industries: ["accountants"],
    });
    expect(describeOfferChange(emptyOffer(), after)).toEqual([
      "Sells: IT support for accountants",
      "Kind of service: IT support",
      "Added industry: accountants",
      `Buyers to ask for (usual for IT support): ${after.buyerTitles.join(", ")}`,
    ]);
  });
});

describe("your price (3.3)", () => {
  it("suggests a client size only when it states one", async () => {
    const { sizeFromPrice } = await import("./learn");
    const priced = (price: string) => mergeOffer(base, { price });
    expect(sizeFromPrice(priced("£300 a month for up to 50 staff"))).toEqual([
      { field: "sizeMax", value: "50", because: "Your price says “£300 a month for up to 50 staff”." },
    ]);
    expect(
      sizeFromPrice(priced("£8 per employee, for teams of 10 to 200 employees")).map((s) => s.value),
    ).toEqual(["10", "200"]);
    expect(sizeFromPrice(priced("£300 a month"))).toEqual([]);
    // A size you set already isn't suggested.
    expect(sizeFromPrice(mergeOffer(base, { price: "up to 50 staff", sizeMax: 40 }))).toEqual([]);
  });
});

describe("the interview's topics (4.2, 4.3)", () => {
  it("are found in the question asked, and a skip is kept", () => {
    const asked = "Roughly how many staff do your ideal clients have? And what do you charge?";
    expect(nextInterviewState({ asked: [], skipped: [] }, asked, "skip", OFFER_TOPICS)).toEqual({
      asked: ["price", "size"],
      skipped: ["price", "size"],
    });
  });
});

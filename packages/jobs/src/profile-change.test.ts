import { describe, expect, it } from "vitest";

import { nextInterviewState, skipsQuestion, topicsIn } from "./interview";
import { emptyProfile, mergeProfile } from "./profile";
import { addToProfile, describeChange, keepWhatWasSaid } from "./profile-change";

const base = mergeProfile(emptyProfile(), { titles: ["Backend Engineer"], mustHaves: ["Python", "SQL"] });

describe("the Interviewer's change to the profile", () => {
  it("adds list items instead of replacing the list, and takes out what it names", () => {
    // Before: "also add Go" saved as mustHaves ["Go"] wiped Python and SQL.
    expect(addToProfile(base, { mustHaves: ["Go"] }).mustHaves).toEqual(["Python", "SQL", "Go"]);
    expect(addToProfile(base, {}, { mustHaves: ["sql"] }).mustHaves).toEqual(["Python"]);
    expect(addToProfile(base, { seniority: "Senior" })).toEqual({ seniority: "Senior" });
  });

  it("leaves out what the user didn't say", () => {
    const heard = "I want PM jobs in Leeds, at least 55k, must know SQL";
    const { change, dropped } = keepWhatWasSaid(
      {
        titles: ["Product Manager"],
        places: ["Leeds", "Manchester"],
        mustHaves: ["SQL", "Kubernetes"],
        minSalary: { amount: 55000, currency: "GBP", period: "year" },
      },
      heard,
    );
    expect(change).toMatchObject({ titles: ["Product Manager"], places: ["Leeds"], mustHaves: ["SQL"] });
    expect(change.minSalary).toEqual({ amount: 55000, currency: "GBP", period: "year" });
    expect(dropped).toEqual(["Kubernetes", "Manchester"]);
    expect(
      keepWhatWasSaid({ minSalary: { amount: 90000, currency: "GBP", period: "year" } }, heard).dropped,
    ).toEqual(["a lowest salary of 90000"]);
  });

  it("says what changed", () => {
    const after = mergeProfile(base, { mustHaves: ["Python", "Go"], workplace: ["remote"] });
    expect(describeChange(base, after)).toEqual([
      "Added must-have: Go",
      "Removed must-have: SQL",
      "Workplace: remote",
    ]);
  });
});

describe("the interview's topics", () => {
  it("finds what a question asks about, and remembers a skip", () => {
    expect(topicsIn("What's the lowest salary you'd take, and do you need visa sponsorship?")).toEqual([
      "salary",
      "rightToWork",
    ]);
    expect(skipsQuestion("skip")).toBe(true);
    expect(skipsQuestion("Skipper is my dog's name")).toBe(false);
    const state = nextInterviewState(
      { asked: ["titles"], skipped: [] },
      "What's the lowest salary you'd take?",
      "skip",
    );
    expect(state).toEqual({ asked: ["titles", "salary"], skipped: ["salary"] });
  });
});

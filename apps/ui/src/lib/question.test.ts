import { describe, expect, it } from "vitest";

import { answerBody, answerLines, togglePick } from "./question";

describe("what a question card sends", () => {
  it("sends a tapped option on its own, or what was typed", () => {
    expect(answerBody({ picks: ["Green"], typed: "", multiple: false })).toEqual({ answer: "Green" });
    expect(answerBody({ picks: [], typed: "  Teal, actually ", multiple: false })).toEqual({
      answer: "Teal, actually",
    });
    // A tapped option wins over text left in the box.
    expect(answerBody({ picks: ["Green"], typed: "Teal", multiple: false })).toEqual({ answer: "Green" });
  });

  it("sends nothing while nothing is chosen or typed", () => {
    expect(answerBody({ picks: [], typed: "   ", multiple: false })).toBeNull();
    expect(answerBody({ picks: [], typed: "", multiple: true })).toBeNull();
    expect(answerBody({ picks: ["", "  "], typed: "", multiple: true })).toBeNull();
  });

  it("sends the ticks of a multiple-choice question together, keeping a comma inside a choice", () => {
    expect(answerBody({ picks: ["Paris, France", "Rome"], typed: "", multiple: true })).toEqual({
      choices: ["Paris, France", "Rome"],
    });
  });

  it("adds what was typed as one more pick, without repeating a pick", () => {
    expect(answerBody({ picks: ["A"], typed: "Something else", multiple: true })).toEqual({
      choices: ["A", "Something else"],
    });
    expect(answerBody({ picks: ["A"], typed: " A ", multiple: true })).toEqual({ choices: ["A"] });
    expect(answerBody({ picks: [], typed: "Only this", multiple: true })).toEqual({ choices: ["Only this"] });
  });
});

describe("showing an answer", () => {
  it("shows one line per pick for a multiple-choice question, and the answer as written otherwise", () => {
    expect(
      answerLines({ answer: "Paris, France\nRome", multiple: true, options: ["Paris, France", "Rome"] }),
    ).toEqual(["Paris, France", "Rome"]);
    // A typed answer to a plain question keeps its own line breaks in one piece.
    expect(answerLines({ answer: "first\nsecond", multiple: undefined, options: undefined })).toEqual([
      "first\nsecond",
    ]);
    expect(answerLines({ answer: undefined, multiple: true, options: ["A", "B"] })).toEqual([]);
  });
});

describe("ticking options", () => {
  const options = ["Red", "Green", "Blue"];

  it("adds and removes a pick, listing picks in the options' order", () => {
    expect(togglePick(options, [], "Blue")).toEqual(["Blue"]);
    expect(togglePick(options, ["Blue"], "Red")).toEqual(["Red", "Blue"]);
    expect(togglePick(options, ["Red", "Blue"], "Red")).toEqual(["Blue"]);
    expect(togglePick(options, ["Red"], "Red")).toEqual([]);
  });

  it("ignores a pick that isn't one of the options", () => {
    expect(togglePick(options, ["Red"], "Purple")).toEqual(["Red"]);
  });
});

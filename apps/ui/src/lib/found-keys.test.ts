import { describe, expect, it } from "vitest";

import { addFoundLabel, foundKeyText, offeredKeys } from "./found-keys";

const groq = { preset: "groq", label: "Groq", envVar: "GROQ_API_KEY" };
const google = { preset: "google", label: "Google Gemini", envVar: "GOOGLE_API_KEY" };

describe("keys found on this computer", () => {
  it("names the provider and the variable it came from", () => {
    expect(foundKeyText(groq)).toBe("Groq (from GROQ_API_KEY)");
    expect(foundKeyText(google)).toBe("Google Gemini (from GOOGLE_API_KEY)");
  });

  it("gives each Add button a name that says which provider it adds", () => {
    expect(addFoundLabel(groq)).toBe("Add Groq");
    expect(addFoundLabel(google)).toBe("Add Google Gemini");
  });

  it("leaves out a provider already in the list", () => {
    expect(offeredKeys([groq, google], [])).toEqual([groq, google]);
    expect(offeredKeys([groq, google], [{ preset: "groq" }])).toEqual([google]);
    expect(offeredKeys([groq], [{ preset: "groq" }, { preset: "openai" }])).toEqual([]);
  });
});

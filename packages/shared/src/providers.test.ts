import { describe, expect, it } from "vitest";

import { FoundKey, PROVIDER_PRESETS } from ".";

describe("where each provider's key is looked for", () => {
  it("uses the variable names the providers document", () => {
    const names = Object.fromEntries(
      PROVIDER_PRESETS.filter((preset) => preset.envVars).map((preset) => [preset.preset, preset.envVars]),
    );
    expect(names).toEqual({
      anthropic: ["ANTHROPIC_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      groq: ["GROQ_API_KEY"],
      xai: ["XAI_API_KEY"],
      mistral: ["MISTRAL_API_KEY"],
      deepseek: ["DEEPSEEK_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      together: ["TOGETHER_API_KEY"],
      fireworks: ["FIREWORKS_API_KEY"],
      cerebras: ["CEREBRAS_API_KEY"],
      "ollama-cloud": ["OLLAMA_API_KEY"],
    });
  });

  it("looks only for cloud services that need just a key", () => {
    for (const preset of PROVIDER_PRESETS.filter((candidate) => candidate.envVars)) {
      expect(preset.group).toBe("cloud");
      expect(preset.needsKey).toBe(true);
      expect(preset.needsBaseUrl).toBe(false);
    }
  });

  it("describes a found key without its value", () => {
    expect(Object.keys(FoundKey.shape).toSorted()).toEqual(["envVar", "label", "preset"]);
    const parsed = FoundKey.parse({
      preset: "groq",
      label: "Groq",
      envVar: "GROQ_API_KEY",
      value: "gsk-secret",
    });
    expect(parsed).toEqual({ preset: "groq", label: "Groq", envVar: "GROQ_API_KEY" });
  });
});

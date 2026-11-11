import { describe, expect, it } from "vitest";

import { addProviderBody, showsApiKey } from "./provider-form";

const openai = { preset: "openai", group: "cloud", needsKey: true, needsBaseUrl: false } as const;
const lmstudio = { preset: "lmstudio", group: "local", needsKey: false, needsBaseUrl: false } as const;
const custom = { preset: "custom", group: "custom", needsKey: false, needsBaseUrl: true } as const;

describe("add provider form", () => {
  it("shows the key field for services that need one and for custom servers", () => {
    expect(showsApiKey(openai)).toBe(true);
    expect(showsApiKey(custom)).toBe(true);
    expect(showsApiKey(lmstudio)).toBe(false);
  });

  it("sends the key typed into a field that is showing", () => {
    expect(addProviderBody(openai, { label: "", baseUrl: "", apiKey: " sk-1 " })).toEqual({
      preset: "openai",
      apiKey: "sk-1",
    });
    expect(
      addProviderBody(custom, { label: "Mine", baseUrl: "http://192.168.1.5:8080/v1", apiKey: "k" }),
    ).toEqual({ preset: "custom", label: "Mine", baseUrl: "http://192.168.1.5:8080/v1", apiKey: "k" });
  });

  it("does not send a key the form is not showing", () => {
    expect(
      addProviderBody(lmstudio, { label: "", baseUrl: "http://192.168.1.5:1234", apiKey: "sk-1" }),
    ).toEqual({ preset: "lmstudio", baseUrl: "http://192.168.1.5:1234" });
  });
});

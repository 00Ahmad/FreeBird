import { describe, expect, it } from "vitest";

import { AddProviderInput, MAX_SECRET_LENGTH, SetSecretInput, UpdateProviderInput } from ".";

describe("how long a secret may be", () => {
  it("is what Windows Credential Manager can hold", () => {
    expect(MAX_SECRET_LENGTH).toBe(1280);
  });

  it("accepts a value up to the limit and refuses one past it, saying how long it may be", () => {
    expect(SetSecretInput.safeParse({ value: "a".repeat(MAX_SECRET_LENGTH) }).success).toBe(true);
    const tooLong = SetSecretInput.safeParse({ value: "a".repeat(MAX_SECRET_LENGTH + 1) });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0]?.message).toContain("1,280");
  });

  it("applies the same limit to a provider's API key", () => {
    const key = (length: number) => ({ preset: "openai", apiKey: "k".repeat(length) });
    expect(AddProviderInput.safeParse(key(MAX_SECRET_LENGTH)).success).toBe(true);
    expect(AddProviderInput.safeParse(key(MAX_SECRET_LENGTH + 1)).success).toBe(false);
    expect(UpdateProviderInput.safeParse({ apiKey: "k".repeat(MAX_SECRET_LENGTH) }).success).toBe(true);
    expect(UpdateProviderInput.safeParse({ apiKey: "k".repeat(MAX_SECRET_LENGTH + 1) }).success).toBe(false);
  });
});

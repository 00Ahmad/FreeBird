import { describe, expect, it } from "vitest";

import { MemoryBackend, moveSecrets, Vault, type NameIndex } from ".";

function memoryIndex(): NameIndex {
  let names: string[] = [];
  return { load: () => names, save: (next) => (names = next) };
}

describe("vault", () => {
  it("stores values in the backend and only names in the index", () => {
    const backend = new MemoryBackend();
    const index = memoryIndex();
    const vault = new Vault(backend, index);

    vault.set("OPENAI_API_KEY", "sk-test");
    vault.set("OPENAI_API_KEY", "sk-test-2");
    expect(vault.names()).toEqual(["OPENAI_API_KEY"]);
    expect(index.load()).toEqual(["OPENAI_API_KEY"]);
    expect(vault.get("OPENAI_API_KEY")).toBe("sk-test-2");

    expect(vault.delete("OPENAI_API_KEY")).toBe(true);
    expect(vault.delete("OPENAI_API_KEY")).toBe(false);
    expect(backend.get("OPENAI_API_KEY")).toBeNull();
    expect(vault.names()).toEqual([]);
  });

  it("rejects unsafe names", () => {
    const vault = new Vault(new MemoryBackend(), memoryIndex());
    expect(() => vault.set("../../etc", "x")).toThrow();
  });
});

describe("moving secrets after a rename", () => {
  it("moves each secret once, keeps ones already saved under the new name, and skips missing ones", () => {
    const before = new MemoryBackend();
    const after = new MemoryBackend();
    before.set("GITHUB_TOKEN", "old-token");
    before.set("SMTP_PASSWORD", "old-smtp");
    after.set("SMTP_PASSWORD", "new-smtp");

    expect(moveSecrets(["GITHUB_TOKEN", "SMTP_PASSWORD", "NEVER_SAVED"], before, after)).toBe(1);
    expect(after.get("GITHUB_TOKEN")).toBe("old-token");
    expect(before.get("GITHUB_TOKEN")).toBeNull();
    expect(after.get("SMTP_PASSWORD")).toBe("new-smtp");
    expect(moveSecrets(["GITHUB_TOKEN"], before, after)).toBe(0);
  });
});

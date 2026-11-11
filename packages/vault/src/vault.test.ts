import { describe, expect, it } from "vitest";

import { MemoryBackend, moveSecrets, SecretTooLongError, Vault, type NameIndex, type SecretBackend } from ".";

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

/** Refuses what Windows Credential Manager refuses: more than 1,280 UTF-16 units in one entry. */
class LimitedBackend implements SecretBackend {
  private readonly values = new Map<string, string>();
  get(name: string) {
    return this.values.get(name) ?? null;
  }
  set(name: string, value: string) {
    if (value.length > 1280) throw new Error("password longer than the platform limit of 2560 chars");
    this.values.set(name, value);
  }
  delete(name: string) {
    this.values.delete(name);
  }
  names() {
    return [...this.values.keys()];
  }
}

describe("secrets longer than one keychain entry", () => {
  const long = "x".repeat(1281) + JSON.stringify({ tail: "é".repeat(2500) });

  it("refuses an ordinary secret that is too long, with a clear error", () => {
    const vault = new Vault(new LimitedBackend(), memoryIndex());
    expect(() => vault.set("TOKEN_A", "y".repeat(1281))).toThrow(SecretTooLongError);
    expect(() => vault.set("TOKEN_A", "y".repeat(1281))).toThrow(/at most 1,280 characters/);
    vault.set("TOKEN_A", "y".repeat(1280));
    expect(vault.get("TOKEN_A")).toBe("y".repeat(1280));
  });

  it("keeps a long value in pieces and puts it back together", () => {
    const backend = new LimitedBackend();
    const index = memoryIndex();
    const vault = new Vault(backend, index);
    vault.setLong("MCP_OAUTH_X", long);
    expect(vault.get("MCP_OAUTH_X")).toBe(long);
    // One name for the user; the pieces are the backend's business.
    expect(index.load()).toEqual(["MCP_OAUTH_X"]);
    expect(backend.names().length).toBeGreaterThan(2);
    expect(backend.get("MCP_OAUTH_X")).toMatch(/^freebird-parts:[0-9a-f]{6}:\d+$/);
  });

  it("never cuts a character in half", () => {
    const vault = new Vault(new LimitedBackend(), memoryIndex());
    const emoji = "a" + "😀".repeat(1500);
    vault.setLong("MCP_OAUTH_X", emoji);
    expect(vault.get("MCP_OAUTH_X")).toBe(emoji);
  });

  it("keeps a short value as one plain entry", () => {
    const backend = new LimitedBackend();
    const vault = new Vault(backend, memoryIndex());
    vault.setLong("MCP_OAUTH_X", "short");
    expect(backend.names()).toEqual(["MCP_OAUTH_X"]);
    expect(backend.get("MCP_OAUTH_X")).toBe("short");
  });

  it("replaces a long value, shorter or longer, without leaving pieces behind", () => {
    const backend = new LimitedBackend();
    const vault = new Vault(backend, memoryIndex());
    vault.setLong("MCP_OAUTH_X", long);
    vault.setLong("MCP_OAUTH_X", long + long);
    expect(vault.get("MCP_OAUTH_X")).toBe(long + long);
    const pieces = backend.names().length;
    vault.setLong("MCP_OAUTH_X", "small");
    expect(vault.get("MCP_OAUTH_X")).toBe("small");
    expect(backend.names()).toEqual(["MCP_OAUTH_X"]);
    vault.setLong("MCP_OAUTH_X", long);
    vault.set("MCP_OAUTH_X", "plain");
    expect(backend.names()).toEqual(["MCP_OAUTH_X"]);
    expect(pieces).toBeGreaterThan(1);
  });

  it("reads a value saved before pieces existed", () => {
    const backend = new LimitedBackend();
    const index = memoryIndex();
    index.save(["MCP_OAUTH_X"]);
    const vault = new Vault(backend, index);
    backend.set("MCP_OAUTH_X", JSON.stringify({ url: "https://a.example", tokens: { access_token: "t" } }));
    expect(JSON.parse(vault.get("MCP_OAUTH_X")!)).toMatchObject({ url: "https://a.example" });
  });

  it("deletes every piece with the value", () => {
    const backend = new LimitedBackend();
    const vault = new Vault(backend, memoryIndex());
    vault.set("OTHER_ONE", "stay");
    vault.setLong("MCP_OAUTH_X", long);
    expect(vault.delete("MCP_OAUTH_X")).toBe(true);
    expect(backend.names()).toEqual(["OTHER_ONE"]);
    expect(vault.names()).toEqual(["OTHER_ONE"]);
  });

  it("keeps the old value whole when a piece can't be written", () => {
    const backend = new LimitedBackend();
    const vault = new Vault(backend, memoryIndex());
    vault.setLong("MCP_OAUTH_X", long);
    let writes = 0;
    const set = backend.set.bind(backend);
    backend.set = (name, value) => {
      if (++writes === 3) throw new Error("keychain locked");
      set(name, value);
    };
    expect(() => vault.setLong("MCP_OAUTH_X", long + long)).toThrow("keychain locked");
    backend.set = set;
    expect(vault.get("MCP_OAUTH_X")).toBe(long);
    vault.delete("MCP_OAUTH_X");
    expect(backend.names()).toEqual([]);
  });

  it("hands back the note, not a value with a hole, when a piece is missing", () => {
    const backend = new LimitedBackend();
    const vault = new Vault(backend, memoryIndex());
    vault.setLong("MCP_OAUTH_X", long);
    const piece = backend.names().find((name) => name.includes("#"))!;
    backend.delete(piece);
    expect(vault.get("MCP_OAUTH_X")).toMatch(/^freebird-parts:/);
  });

  it("moves a long value's pieces with it after a rename", () => {
    const before = new LimitedBackend();
    const after = new LimitedBackend();
    const old = new Vault(before, memoryIndex());
    old.setLong("MCP_OAUTH_X", long);
    old.set("PLAIN_ONE", "p");
    expect(moveSecrets(["MCP_OAUTH_X", "PLAIN_ONE"], before, after)).toBe(2);
    expect(before.names()).toEqual([]);
    const index = memoryIndex();
    index.save(["MCP_OAUTH_X", "PLAIN_ONE"]);
    expect(new Vault(after, index).get("MCP_OAUTH_X")).toBe(long);
  });
});

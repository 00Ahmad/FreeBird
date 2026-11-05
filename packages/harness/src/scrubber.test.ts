import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message } from "@mrog/shared";
import { defineTool, safe } from "@mrog/tools";

import { HIDDEN, MIN_SECRET_LENGTH, SecretScrubber, secretForms, type SecretValue } from "./scrubber";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

const scrubberOf = (...secrets: SecretValue[]) => {
  const scrubber = new SecretScrubber(() => secrets);
  scrubber.refresh();
  return scrubber;
};

describe("the secret scrubber", () => {
  it("hides a secret wherever it appears, as often as it appears", () => {
    const s = scrubberOf({ kind: "plain", value: "sk-live-abcdef123456" });
    expect(s.scrub("key=sk-live-abcdef123456 and again sk-live-abcdef123456.")).toBe(
      `key=${HIDDEN} and again ${HIDDEN}.`,
    );
  });

  it("knows the forms a value turns up in: in an address, in a Basic header, escaped in JSON", () => {
    const password = 'p@ss w0rd/"quoted"';
    const s = scrubberOf({ kind: "login", username: "sam@example.com", password });
    expect(s.scrub(`https://x.test/?pw=${encodeURIComponent(password)}`)).not.toContain(
      encodeURIComponent(password),
    );
    const basic = Buffer.from(`sam@example.com:${password}`).toString("base64");
    expect(s.scrub(`Authorization: Basic ${basic}`)).toBe(`Authorization: Basic ${HIDDEN}`);
    expect(s.scrub(JSON.stringify({ password }))).not.toContain("w0rd");
    expect(s.scrub(Buffer.from(password).toString("base64"))).toBe(HIDDEN);
  });

  it("hides a card number written with or without spaces and dashes", () => {
    const s = scrubberOf({ kind: "card", number: "4111 1111 1111 1111" });
    for (const written of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111"])
      expect(s.scrub(`card ${written} ok`), written).toBe(`card ${HIDDEN} ok`);
  });

  it("leaves short values alone: they would wreck ordinary text, and they aren't what leaks", () => {
    const s = scrubberOf(
      { kind: "plain", value: "admin" },
      { kind: "plain", value: "x".repeat(MIN_SECRET_LENGTH - 1) },
    );
    // Not as written, and not in any other form either.
    expect(s.size).toBe(0);
    expect(s.scrub("log in as admin")).toBe("log in as admin");
    expect(s.scrub(Buffer.from("admin").toString("base64"))).toBe(Buffer.from("admin").toString("base64"));
  });

  it("matches values as text, never as a pattern", () => {
    const s = scrubberOf({ kind: "plain", value: "a.b*c+d?(e)[f]$g" });
    expect(s.scrub("a.b*c+d?(e)[f]$g")).toBe(HIDDEN);
    // What the characters would match as a pattern is left alone.
    expect(s.scrub("aXbbbccd(e)fg")).toBe("aXbbbccd(e)fg");
  });

  it("replaces a longer secret whole when it contains a shorter one", () => {
    const s = scrubberOf({ kind: "plain", value: "abcdefgh" }, { kind: "plain", value: "abcdefgh-and-more" });
    expect(s.scrub("abcdefgh-and-more")).toBe(HIDDEN);
  });

  it("does nothing at all when there are no secrets, and survives a keychain that can't be read", () => {
    const empty = scrubberOf();
    expect(empty.scrub("anything")).toBe("anything");
    const broken = new SecretScrubber(() => {
      throw new Error("keychain locked");
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      broken.refresh();
    } finally {
      console.warn = warn;
    }
    expect(broken.scrub("text")).toBe("text");
  });

  it("lists distinct forms", () => {
    const forms = secretForms({ kind: "plain", value: "plainvalue1" });
    expect(forms).toContain("plainvalue1");
    expect(forms).toContain(Buffer.from("plainvalue1").toString("base64"));
  });
});

let h: TestHarness | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe("what the app knows is secret", () => {
  it("takes plain secrets, passwords, card numbers and sign-in tokens, but not contact details", async () => {
    h = await makeHarness();
    const vault = h.services.vaultService;
    h.services.vault.set("GITHUB_TOKEN", "ghp_tokenvalue123");
    vault.add({ kind: "login", website: "https://example.com", username: "sam", password: "hunter2-long" });
    vault.add({ kind: "card", number: "4111 1111 1111 1111", expiry: "12/30", cvc: "123", name: "Sam Q" });
    vault.add({
      kind: "contact",
      name: "Sam Q",
      email: "sam@example.com",
      phone: "+1 555 0100",
      address: "1 Long Street",
    });
    h.services.vault.set(
      "MCP_OAUTH_GMAIL",
      JSON.stringify({
        url: "https://x",
        tokens: { access_token: "at-0123456789", refresh_token: "rt-0123456789" },
      }),
    );
    // A login whose stored secret got damaged must not take the others down with it...
    const damaged = vault.add({
      kind: "login",
      website: "https://broken.test",
      username: "x",
      password: "will-be-lost",
    });
    h.services.vault.set(`VAULT_ITEM_${damaged.id.toUpperCase().replaceAll("-", "_")}`, "{not json");
    // ...and a left-over entry for an item that no longer exists is not a secret to look for.
    h.services.vault.set("VAULT_ITEM_GONE", "left-over-text");
    const values = vault.secretValues();
    const flat = JSON.stringify(values);
    for (const expected of [
      "ghp_tokenvalue123",
      "hunter2-long",
      "4111111111111111",
      "at-0123456789",
      "rt-0123456789",
    ])
      expect(flat, expected).toContain(expected);
    expect(flat).not.toContain("sam@example.com");
    expect(flat).not.toContain("1 Long Street");
    expect(flat).not.toContain("{not json");
    expect(flat).not.toContain("left-over-text");
  });
});

describe("secrets in a conversation", () => {
  async function setup(replies: unknown[][]) {
    dataDir = mkdtempSync(join(tmpdir(), "mrog-scrub-"));
    const requests: any[] = [];
    h = await makeHarness({
      config: { dataDir },
      handlers: fakeOllama((body) => {
        requests.push(body);
        const next = replies.shift();
        if (next === undefined) return ndjson([{ message: { content: "ok" } }, { done: true }]);
        if (!Array.isArray(next)) return next as Response;
        return ndjson([...next, { done: true }]);
      }),
    });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const bot = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
    ).json().bot as Bot;
    return { bot, requests };
  }
  const finished = () =>
    nextEvent<Message>(
      h!.bus,
      (e) => e.type === "message.updated" && e.message.status !== "streaming" && e.message,
      8000,
    );
  const send = (bot: Bot, text: string) =>
    h!.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text },
    });

  it("keeps a secret saved after the app started out of a tool result, the chat and the model's view", async () => {
    const { bot, requests } = await setup([
      [{ message: { tool_calls: [{ function: { name: "peek", arguments: {} } }] } }],
      [{ message: { content: "Done." } }],
    ]);
    h!.services.agent.toolSources.push(() => [
      defineTool({
        name: "peek",
        description: "Reads a config file",
        args: z.object({}),
        risk: () => safe("Peek"),
        run: async () => "config: api_key=sk-later-added-999 region=eu",
      }),
    ]);
    // Saved through the API while the app runs: the scrubber hears of it.
    await h!.app.inject({
      method: "PUT",
      url: "/api/secrets/LATE_KEY",
      headers: auth,
      payload: { value: "sk-later-added-999" },
    });
    const done = finished();
    await send(bot, "read the config");
    const reply = await done;
    const tool = reply.parts.find((p) => p.type === "tool");
    expect(tool).toMatchObject({ result: `config: api_key=${HIDDEN} region=eu` });
    expect(JSON.stringify(requests[1])).not.toContain("sk-later-added-999");
    expect(JSON.stringify(h!.store.messages.list(bot.threadId))).not.toContain("sk-later-added-999");
  });

  it("keeps a secret out of an error the model server sends back", async () => {
    // The server fails and quotes the key back in its error text.
    const { bot } = await setup([
      Response.json({ error: "invalid key sk-provider-secret-77" }, { status: 401 }) as unknown as unknown[],
    ]);
    h!.services.vault.set("PROVIDER_X_KEY", "sk-provider-secret-77");
    h!.services.scrubber.refresh();
    const done = finished();
    await send(bot, "hi");
    const reply = await done;
    const error = reply.parts.find((p) => p.type === "error");
    expect(error).toMatchObject({ type: "error", message: expect.stringContaining(HIDDEN) });
    expect(JSON.stringify(reply)).not.toContain("sk-provider-secret-77");
  });
});

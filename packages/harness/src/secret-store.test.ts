import { afterEach, describe, expect, it } from "vitest";

import { openStore, type Store } from "@mrog/store";
import { Vault, type SecretBackend } from "@mrog/vault";

import { EventBus } from "./bus";
import { settingsNameIndex } from "./index";
import { ConnectorSignIn, PendingSignIns, oauthSecretName } from "./oauth";
import { auth, makeHarness, type TestHarness } from "./testing";
import { VaultService } from "./vault";

/** Refuses what Windows Credential Manager refuses: more than 1,280 UTF-16 units in one entry. */
class WindowsLikeBackend implements SecretBackend {
  readonly values = new Map<string, string>();
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
}

type PendingSecrets = Map<string, { name: string; resolve(saved: boolean): void }>;
const pendingOf = (service: VaultService) =>
  (service as unknown as { pendingSecrets: PendingSecrets }).pendingSecrets;

let h: TestHarness | undefined;
let store: Store | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  store?.close();
  store = undefined;
});

const SERVER = "https://mcp.example.com/mcp";
/** A token the size of a Microsoft or Atlassian JWT. */
const BIG_TOKEN = `eyJ${"a1B2c3D4".repeat(400)}`;

function signIn(backend = new WindowsLikeBackend()) {
  store ??= openStore(":memory:");
  const vault = new Vault(backend, settingsNameIndex(store.settings));
  const bus = new EventBus();
  const make = (serverUrl = SERVER) =>
    new ConnectorSignIn({
      vault,
      bus,
      connectorId: "ms-365",
      serverUrl,
      base: () => "http://127.0.0.1:5555",
      pending: new PendingSignIns(),
    });
  return { backend, vault, bus, make, sign: make() };
}

describe("the secret routes and the length limit", () => {
  it("answers a secret that is too long with a 400 that says how long it may be", async () => {
    h = await makeHarness();
    const tooLong = await h.app.inject({
      method: "PUT",
      url: "/api/secrets/GITHUB_TOKEN",
      headers: auth,
      payload: { value: "x".repeat(1281) },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ error: "secret_too_long" });
    expect(tooLong.json().message).toContain("1,280");
    expect(h.services.vault.has("GITHUB_TOKEN")).toBe(false);

    const ok = await h.app.inject({
      method: "PUT",
      url: "/api/secrets/GITHUB_TOKEN",
      headers: auth,
      payload: { value: "x".repeat(1280) },
    });
    expect(ok.statusCode).toBe(204);
  });

  it("answers a provider key that is too long with a 400, on add and on update", async () => {
    h = await makeHarness();
    const add = await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "groq", apiKey: "k".repeat(1281) },
    });
    expect(add.statusCode).toBe(400);
    expect(add.json().message).toContain("1,280");
    expect(h.services.vault.has("PROVIDER_GROQ_KEY")).toBe(false);

    await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "groq", apiKey: "k" },
    });
    const update = await h.app.inject({
      method: "PATCH",
      url: "/api/providers/groq",
      headers: auth,
      payload: { apiKey: "k".repeat(1281) },
    });
    expect(update.statusCode).toBe(400);
    expect(update.json().message).toContain("1,280");
    expect(h.services.vault.get("PROVIDER_GROQ_KEY")).toBe("k");
  });

  it("answers a secret card with a too-long value with a 400 and leaves the card open to try again", async () => {
    h = await makeHarness();
    // Opens a card the way the request_secret tool does.
    let answer: boolean | undefined;
    pendingOf(h.services.vaultService).set("req-1", {
      name: "GITHUB_TOKEN",
      resolve: (saved) => (answer = saved),
    });

    const tooLong = await h.app.inject({
      method: "POST",
      url: "/api/secret-requests/req-1",
      headers: auth,
      payload: { name: "GITHUB_TOKEN", value: "x".repeat(1281) },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().message).toContain("1,280");
    expect(answer).toBeUndefined();
    expect(h.services.vault.has("GITHUB_TOKEN")).toBe(false);

    const retry = await h.app.inject({
      method: "POST",
      url: "/api/secret-requests/req-1",
      headers: auth,
      payload: { name: "GITHUB_TOKEN", value: "short" },
    });
    expect(retry.statusCode).toBe(204);
    expect(answer).toBe(true);
    expect(h.services.vault.get("GITHUB_TOKEN")).toBe("short");
  });

  it("answers a secret card with a keychain error with a 503, not a 500, and leaves the card open", async () => {
    h = await makeHarness();
    const pending = pendingOf(h.services.vaultService);
    pending.set("req-2", { name: "GITHUB_TOKEN", resolve: () => {} });
    h.services.vault.set = () => {
      throw new Error("keychain locked");
    };
    const res = await h.app.inject({
      method: "POST",
      url: "/api/secret-requests/req-2",
      headers: auth,
      payload: { value: "abc" },
    });
    expect(res.statusCode).toBe(503);
    expect(pending.has("req-2")).toBe(true);
  });
});

describe("a connected app's sign-in with big tokens", () => {
  const bigSignIn = () => ({
    access_token: BIG_TOKEN,
    refresh_token: `refresh-${BIG_TOKEN}`,
    token_type: "Bearer",
    expires_in: 3600,
  });

  it("is kept even when it is longer than one keychain entry, and read back whole", () => {
    const { sign, make, backend } = signIn();
    sign.saveClientInformation({ client_id: "client-1" });
    sign.saveCodeVerifier("verifier-123");
    sign.saveTokens(bigSignIn());
    expect(backend.values.size).toBeGreaterThan(2);
    // A fresh object, as after a restart.
    const again = make();
    expect(again.tokens()).toMatchObject({ access_token: BIG_TOKEN, refresh_token: `refresh-${BIG_TOKEN}` });
    expect(again.clientInformation()).toEqual({ client_id: "client-1" });
    expect(again.hasTokens()).toBe(true);
  });

  it("keeps working through a refresh that replaces the tokens", () => {
    const { sign, make } = signIn();
    sign.saveTokens(bigSignIn());
    sign.saveTokens({ ...bigSignIn(), access_token: `${BIG_TOKEN}-2` });
    expect(make().tokens()?.access_token).toBe(`${BIG_TOKEN}-2`);
  });

  it("still reads a sign-in saved before the pieces existed", () => {
    const { backend, make } = signIn();
    const saved = { url: SERVER, tokens: { access_token: "old-access-token", token_type: "Bearer" } };
    backend.set(oauthSecretName("ms-365"), JSON.stringify(saved));
    store!.settings.set("vault.names", [oauthSecretName("ms-365")]);
    expect(make().tokens()?.access_token).toBe("old-access-token");
  });

  it("deletes every piece when the app's sign-in is forgotten", () => {
    const { sign, backend, vault } = signIn();
    sign.saveTokens(bigSignIn());
    expect(backend.values.size).toBeGreaterThan(2);
    sign.forget();
    expect(backend.values.size).toBe(0);
    expect(vault.names()).toEqual([]);
  });

  it("deletes every piece when the app's address changes", () => {
    const { sign, make, backend, vault } = signIn();
    sign.saveTokens(bigSignIn());
    expect(make("https://elsewhere.example/mcp").tokens()).toBeUndefined();
    expect(backend.values.size).toBe(0);
    expect(vault.names()).toEqual([]);
  });

  it("is removed whole when its one name is deleted in Settings", async () => {
    const backend = new WindowsLikeBackend();
    h = await makeHarness({
      // The routes keep the vault they were built with, so swap it before they are.
      setup(services) {
        (services as { vault: Vault }).vault = new Vault(backend, settingsNameIndex(services.store.settings));
      },
    });
    const sign = new ConnectorSignIn({
      vault: h.services.vault,
      bus: h.bus,
      connectorId: "ms-365",
      serverUrl: SERVER,
      base: () => null,
      pending: new PendingSignIns(),
    });
    sign.saveTokens(bigSignIn());
    expect(backend.values.size).toBeGreaterThan(2);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/secrets/${oauthSecretName("ms-365")}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(backend.values.size).toBe(0);
  });

  it("is scrubbed from results as whole token strings, however many pieces it is in", () => {
    const { sign, vault, bus } = signIn();
    sign.saveClientInformation({ client_id: "c", client_secret: "client-secret-value" });
    sign.saveTokens(bigSignIn());
    const service = new VaultService({ store: store!, vault, bus, turns: undefined as never });
    const plain = service.secretValues().flatMap((secret) => (secret.kind === "plain" ? [secret.value] : []));
    expect(plain).toEqual(expect.arrayContaining([BIG_TOKEN, `refresh-${BIG_TOKEN}`, "client-secret-value"]));
  });
});

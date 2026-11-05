import { randomBytes } from "node:crypto";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { Vault } from "@mrog/vault";

import type { EventBus } from "./bus";
import { OAUTH_PREFIX } from "./vault";

/**
 * Signing in to a connected app over OAuth (for MCP servers that ask for it), with the MCP SDK doing the protocol:
 * finding the server's authorization server, registering FreeBird as a client, PKCE, and refreshing tokens. This is the
 * part the SDK leaves to the app: where things are kept, and how the user is sent to sign in and back.
 *
 * - Everything for one app's sign-in (its client registration, tokens, and the PKCE verifier of a sign-in under way)
 *   is one keychain entry, `MCP_OAUTH_<ID>`, listed with the user's other secrets so it can be deleted there.
 * - It is tied to the server's address: an entry made for another address is never sent anywhere (so editing an
 *   app's URL can't hand its token to a new server), and is deleted.
 * - Nothing opens on its own: when a server wants a sign-in, the app shows "Sign in", and the address is opened only
 *   when the user presses it.
 * - The sign-in comes back to the harness's own loopback address. That address changes each time the packaged app
 *   starts, so a client registered for an older one is used to refresh tokens (no address involved) but registered
 *   again before the user is sent to sign in.
 */

/** The keychain name for one connected app's sign-in; fits SecretName, so Settings can list and delete it. */
export const oauthSecretName = (connectorId: string) =>
  `${OAUTH_PREFIX}${connectorId.toUpperCase().replaceAll("-", "_")}`;

/** Where the user's browser comes back to after signing in, on the harness. */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

/** How long a sign-in may take before its link stops working. */
export const SIGN_IN_TTL_MS = 10 * 60_000;

interface Saved {
  /** The server the rest belongs to. */
  url: string;
  client?: OAuthClientInformationMixed;
  /** The address the client was registered with. */
  redirect?: string;
  tokens?: OAuthTokens;
  verifier?: string;
}

/** Sign-ins under way, by the `state` sent with them: each works once, and not for long. */
export class PendingSignIns {
  private readonly pending = new Map<string, { connectorId: string; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  start(connectorId: string): string {
    this.prune();
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, { connectorId, expires: this.now() + SIGN_IN_TTL_MS });
    return state;
  }

  /** The app a returning sign-in belongs to; null when the state is unknown, used or too old. */
  take(state: string | undefined): string | null {
    this.prune();
    if (!state) return null;
    const entry = this.pending.get(state);
    this.pending.delete(state);
    return entry ? entry.connectorId : null;
  }

  private prune() {
    const now = this.now();
    for (const [state, entry] of this.pending) if (entry.expires <= now) this.pending.delete(state);
  }
}

export class ConnectorSignIn implements OAuthClientProvider {
  /** The address to send the user to, once a server has asked for a sign-in. */
  signInUrl: URL | null = null;

  constructor(
    private readonly deps: {
      vault: Vault;
      bus: EventBus;
      connectorId: string;
      serverUrl: string;
      /** The harness's own address, once it is listening. */
      base: () => string | null;
      pending: PendingSignIns;
    },
  ) {}

  private get name() {
    return oauthSecretName(this.deps.connectorId);
  }

  /** The server this sign-in belongs to. */
  get serverUrl(): string {
    return this.deps.serverUrl;
  }

  private load(): Saved {
    const raw = this.deps.vault.get(this.name);
    if (!raw) return { url: this.deps.serverUrl };
    try {
      const saved = JSON.parse(raw) as Saved;
      if (saved.url === this.deps.serverUrl) return saved;
    } catch {
      // unreadable: start again
    }
    // Made for another server (the app's address was edited), or damaged: never sent anywhere.
    this.forget();
    return { url: this.deps.serverUrl };
  }

  private save(next: Saved) {
    this.deps.vault.set(this.name, JSON.stringify(next));
    // The scrubber learns the new token; Settings lists the entry.
    this.deps.bus.publish({ type: "secrets.changed", names: this.deps.vault.names() });
  }

  /** Deletes everything kept for this app's sign-in. */
  forget(): void {
    if (this.deps.vault.get(this.name) === null) return;
    this.deps.vault.delete(this.name);
    this.deps.bus.publish({ type: "secrets.changed", names: this.deps.vault.names() });
  }

  /** The user is about to sign in: a client registered for an older address of the app must be registered again. */
  prepareSignIn(): void {
    const saved = this.load();
    if (saved.client && saved.redirect !== this.callback())
      this.save({ url: saved.url, tokens: saved.tokens });
  }

  hasTokens(): boolean {
    return Boolean(this.load().tokens);
  }

  private callback(): string | undefined {
    const base = this.deps.base();
    return base ? `${base.replace(/\/$/, "")}${OAUTH_CALLBACK_PATH}` : undefined;
  }

  get redirectUrl(): string | undefined {
    return this.callback();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "FreeBird",
      redirect_uris: this.callback() ? [this.callback()!] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A desktop app can't keep a client secret: PKCE stands in for it.
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.deps.pending.start(this.deps.connectorId);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.load().client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.save({ ...this.load(), client, redirect: this.callback() });
  }

  tokens(): OAuthTokens | undefined {
    return this.load().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const { verifier: _done, ...rest } = this.load();
    this.save({ ...rest, tokens });
  }

  redirectToAuthorization(url: URL): void {
    // Kept for the "Sign in" button; never opened from here.
    this.signInUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.save({ ...this.load(), verifier });
  }

  codeVerifier(): string {
    const verifier = this.load().verifier;
    if (!verifier) throw new Error("No sign-in is under way for this app. Press Sign in again.");
    return verifier;
  }

  /** The server refused what was kept (an expired refresh, a deleted client): drop it, so the next try starts clean. */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") return this.forget();
    if (scope === "discovery") return;
    const saved = this.load();
    if (scope === "client") this.save({ url: saved.url, tokens: saved.tokens });
    else if (scope === "tokens") this.save({ ...saved, tokens: undefined });
    else this.save({ ...saved, verifier: undefined });
  }
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

/** The page the user's browser shows when it comes back. Everything in it is escaped; it runs no script. */
export function signInPage(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:15px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}h1{font-size:1.2rem}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
}

/** The headers for that page: nothing loads, nothing runs, it can't be framed. */
export const SIGN_IN_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

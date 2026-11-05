import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ConnectorView } from "@mrog/shared";

import { oauthSecretName, PendingSignIns } from "./oauth";
import { auth, makeHarness, type TestHarness } from "./testing";

/** An app that asks for OAuth: its own authorization server (with PKCE checked for real) and an MCP server behind it. */
async function oauthApp() {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const seenAuth: string[] = [];
  const registrations: { redirect_uris: string[] }[] = [];
  let issued = 0;
  let base = "";

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => resolve(text));
    });
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const tokens = () => {
    issued += 1;
    const at = `access-${issued}-abcdef`;
    const rt = `refresh-${issued}-abcdef`;
    access.add(at);
    refresh.add(rt);
    return { access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: 3600 };
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register") {
      const body = JSON.parse(await readBody(req));
      registrations.push(body);
      return json(res, 201, { ...body, client_id: `client-${registrations.length}`, client_id_issued_at: 1 });
    }
    if (url.pathname === "/authorize") {
      // The user approves straight away: the browser is sent back with a code.
      const code = `code-${codes.size + 1}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge")!,
        redirect: url.searchParams.get("redirect_uri")!,
      });
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("grant_type") === "authorization_code") {
        const entry = codes.get(form.get("code")!);
        codes.delete(form.get("code")!);
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (!entry || entry.challenge !== challenge || entry.redirect !== form.get("redirect_uri"))
          return json(res, 400, { error: "invalid_grant" });
        return json(res, 200, tokens());
      }
      if (form.get("grant_type") === "refresh_token" && refresh.delete(form.get("refresh_token")!))
        return json(res, 200, tokens());
      return json(res, 400, { error: "invalid_grant" });
    }
    if (url.pathname === "/mcp") {
      const header = req.headers.authorization ?? "";
      seenAuth.push(header);
      if (!access.has(header.replace(/^Bearer /, ""))) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      const mcp = new McpServer({ name: "secure", version: "1.0.0" });
      mcp.registerTool(
        "list_files",
        { description: "List files", inputSchema: { dir: z.string().optional() } },
        async () => ({
          content: [{ type: "text", text: "a.txt" }],
        }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      const raw = req.method === "POST" ? await readBody(req) : "";
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      return;
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    seenAuth,
    registrations,
    /** A token handed out some other way (the user pasted it in), which the app accepts. */
    grant: (token: string) => void access.add(token),
    revokeAll: () => {
      access.clear();
      refresh.clear();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let h: TestHarness | undefined;
const apps: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const CALLBACK_BASE = "http://127.0.0.1:65001";

async function setup() {
  const app = await oauthApp();
  apps.push(app);
  h = await makeHarness();
  h.services.connectors.setCallbackBase(CALLBACK_BASE);
  const res = await h.app.inject({
    method: "POST",
    url: "/api/connectors",
    headers: auth,
    payload: { name: "Secure Files", transport: { type: "http", url: `${app.base}/mcp`, headers: {} } },
  });
  return { app, connector: res.json().connector as ConnectorView };
}

/** What the user's browser does: open the sign-in page, follow it back to the app's callback. */
async function signInAsUser(url: string) {
  const page = await fetch(url, { redirect: "manual" });
  const back = new URL(page.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe(`${CALLBACK_BASE}/oauth/callback`);
  return h!.app.inject({ method: "GET", url: `${back.pathname}${back.search}` });
}

const view = async () =>
  ((await h!.app.inject({ url: "/api/connectors", headers: auth })).json().connectors as ConnectorView[])[0]!;

describe("signing in to a connected app over OAuth", () => {
  it("asks for a sign-in instead of failing, and opens nothing on its own", async () => {
    const { connector } = await setup();
    expect(connector).toMatchObject({
      state: "auth",
      error: expect.stringContaining("Sign in to Secure Files"),
    });
  });

  it("signs in with PKCE through the user's browser, connects, and keeps the tokens in the keychain", async () => {
    const { app } = await setup();
    const start = await h!.app.inject({
      method: "POST",
      url: "/api/connectors/secure-files/sign-in",
      headers: auth,
    });
    expect(start.statusCode).toBe(200);
    const url = new URL(start.json().url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(`${CALLBACK_BASE}/oauth/callback`);
    expect(url.searchParams.get("state")).toBeTruthy();

    const back = await signInAsUser(url.toString());
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain("Signed in to Secure Files");
    expect(back.headers["content-security-policy"]).toContain("default-src 'none'");

    expect(await view()).toMatchObject({ state: "connected", tools: [{ name: "list_files" }] });
    const saved = JSON.parse(h!.services.vault.get(oauthSecretName("secure-files"))!);
    expect(saved).toMatchObject({ url: `${app.base}/mcp`, tokens: { access_token: expect.any(String) } });
    expect(saved.verifier).toBeUndefined(); // the sign-in is over
    // The token is now one of the secrets kept out of results and logs.
    expect(h!.services.scrubber.scrub(`token ${saved.tokens.access_token}`)).toBe("token [hidden]");
    // The keychain entry is a name the user can see and delete in Settings.
    expect((await h!.app.inject({ url: "/api/secrets", headers: auth })).json().names).toContain(
      "MCP_OAUTH_SECURE_FILES",
    );
  });

  it("accepts each sign-in link once, and turns away an unknown one, escaping what the server sent", async () => {
    await setup();
    const start = await h!.app.inject({
      method: "POST",
      url: "/api/connectors/secure-files/sign-in",
      headers: auth,
    });
    const page = await fetch(start.json().url, { redirect: "manual" });
    const back = new URL(page.headers.get("location")!);
    expect((await h!.app.inject({ url: `${back.pathname}${back.search}` })).statusCode).toBe(200);
    const again = await h!.app.inject({ url: `${back.pathname}${back.search}` });
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain("expired or was already used");

    const forged = await h!.app.inject({
      url: "/oauth/callback?state=made-up&error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.body).not.toContain("<script>");
    expect(forged.body).toContain("&lt;script&gt;");
  });

  it("needs no app token for the callback, but nothing else outside /api opens up", async () => {
    await setup();
    // The browser has no token; the callback answers it (here: an unknown state).
    expect((await h!.app.inject({ url: "/oauth/callback?code=x&state=y" })).statusCode).toBe(400);
    expect(
      (await h!.app.inject({ method: "POST", url: "/api/connectors/secure-files/sign-in" })).statusCode,
    ).toBe(401);
  });

  it("keeps the sign-in across a new port: refreshes without registering again, registers again before a new sign-in", async () => {
    const { app } = await setup();
    const start = await h!.app.inject({
      method: "POST",
      url: "/api/connectors/secure-files/sign-in",
      headers: auth,
    });
    await signInAsUser(start.json().url);
    expect(app.registrations).toHaveLength(1);

    // The packaged app starts on another port. The tokens still work: no new registration, no sign-in.
    h!.services.connectors.setCallbackBase("http://127.0.0.1:65002");
    await h!.app.inject({ method: "POST", url: "/api/connectors/secure-files/reconnect", headers: auth });
    expect((await view()).state).toBe("connected");
    expect(app.registrations).toHaveLength(1);

    // The server forgets the tokens: the next sign-in registers again, for the new address.
    app.revokeAll();
    const next = await h!.app.inject({
      method: "POST",
      url: "/api/connectors/secure-files/sign-in",
      headers: auth,
    });
    expect(new URL(next.json().url).searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:65002/oauth/callback",
    );
    expect(app.registrations).toHaveLength(2);
    expect(app.registrations[1]!.redirect_uris).toEqual(["http://127.0.0.1:65002/oauth/callback"]);
  });

  it("never sends a token to another server after the app's address is changed", async () => {
    const { app } = await setup();
    const start = await h!.app.inject({
      method: "POST",
      url: "/api/connectors/secure-files/sign-in",
      headers: auth,
    });
    await signInAsUser(start.json().url);
    const token = JSON.parse(h!.services.vault.get(oauthSecretName("secure-files"))!).tokens.access_token;
    expect(app.seenAuth).toContain(`Bearer ${token}`);

    const other = await oauthApp();
    apps.push(other);
    await h!.app.inject({
      method: "PATCH",
      url: "/api/connectors/secure-files",
      headers: auth,
      payload: { transport: { type: "http", url: `${other.base}/mcp`, headers: {} } },
    });
    expect(other.seenAuth.some((header) => header.includes(token))).toBe(false);
    expect((await view()).state).toBe("auth");
    // The old server's entry is gone.
    expect(h!.services.vault.get(oauthSecretName("secure-files")) ?? "").not.toContain(token);
  });

  it("deletes the sign-in when the app is removed", async () => {
    await setup();
    const start = await h!.app.inject({
      method: "POST",
      url: "/api/connectors/secure-files/sign-in",
      headers: auth,
    });
    await signInAsUser(start.json().url);
    expect(h!.services.vault.get(oauthSecretName("secure-files"))).not.toBeNull();
    await h!.app.inject({ method: "DELETE", url: "/api/connectors/secure-files", headers: auth });
    expect(h!.services.vault.get(oauthSecretName("secure-files"))).toBeNull();
  });
});

describe("apps the user gave a token to, and the app's own entries", () => {
  it("uses a pasted token as before: no sign-in offered, and a refused token says so", async () => {
    const app = await oauthApp();
    apps.push(app);
    app.grant("pasted-token-12345");
    h = await makeHarness();
    h.services.connectors.setCallbackBase(CALLBACK_BASE);
    const add = (name: string, token: string) =>
      h!.app.inject({
        method: "POST",
        url: "/api/connectors",
        headers: auth,
        payload: {
          name,
          transport: { type: "http", url: `${app.base}/mcp`, headers: { Authorization: `Bearer ${token}` } },
        },
      });
    expect((await add("Good", "pasted-token-12345")).json().connector).toMatchObject({ state: "connected" });
    expect(app.registrations).toHaveLength(0);
    const bad = (await add("Bad", "wrong-token")).json().connector as ConnectorView;
    expect(bad.state).toBe("error");
    expect(bad.error).toBe(
      "Needs auth: Bad refused the sign-in (HTTP 401). Check the token in its settings.",
    );
    expect(app.registrations).toHaveLength(0);
  });

  it("never hands an app's sign-in or a Vault entry to a bot, and won't let a bot overwrite one", async () => {
    await setup();
    const start = await h!.app.inject({
      method: "POST",
      url: "/api/connectors/secure-files/sign-in",
      headers: auth,
    });
    await signInAsUser(start.json().url);
    const bot = h!.store.bots.create({ name: "Ada" });
    // As if granted by an older version, or by hand: it still isn't handed over.
    (h!.services.vaultService as unknown as { grant(id: string, names: string[]): void }).grant(bot.id, [
      "MCP_OAUTH_SECURE_FILES",
    ]);
    expect(h!.services.vaultService.envFor(bot)).not.toHaveProperty("MCP_OAUTH_SECURE_FILES");
    const ask = h!.services.vaultService
      .tools(bot, bot.threadId, "m")
      .find((spec) => spec.name === "request_secret")!;
    const ctx = {
      workspace: ".",
      botId: bot.id,
      botName: "Ada",
      threadId: bot.threadId,
      signal: new AbortController().signal,
      ask: async () => "",
    };
    for (const name of ["MCP_OAUTH_SECURE_FILES", "VAULT_ITEM_ABC"])
      expect(await ask.run({ name, reason: "need it" }, ctx)).toContain("keeps for its own sign-ins");
  });
});

describe("sign-in links", () => {
  it("work once, for one app, and not after ten minutes", () => {
    let now = 0;
    const pending = new PendingSignIns(() => now);
    const a = pending.start("mail");
    const b = pending.start("files");
    expect(pending.take(a)).toBe("mail");
    expect(pending.take(a)).toBeNull();
    now += 10 * 60_000 + 1;
    expect(pending.take(b)).toBeNull();
    expect(pending.take(undefined)).toBeNull();
    expect(pending.take("never-issued")).toBeNull();
  });
});

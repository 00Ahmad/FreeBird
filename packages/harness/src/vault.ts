import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  ImportCsvInput,
  loginEnvNames,
  NewVaultItem,
  SecretName,
  VaultItem,
  type Bot,
  type MessagePart,
} from "@mrog/shared";
import { BADGES, defineTool, safe, type ToolSpec } from "@mrog/tools";

import { fail, parse } from "./http";
import type { Services } from "./services";

const ITEMS_KEY = "vault.items";
const grantsKey = (botId: string) => `grants:${botId}`;
const itemSecret = (id: string) => `VAULT_ITEM_${id.toUpperCase().replaceAll("-", "_")}`;

/** "https://www.Daraz.pk/login" → "daraz.pk". */
function siteHost(website: string): string | null {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(website) ? website : `https://${website}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * Domains where each subdomain belongs to someone else (shops, tenants, hosted sites, country registries). A login
 * saved for one of these is never offered to its subdomains. A short list of common ones, not the whole public
 * suffix list.
 */
const SHARED_DOMAINS = new Set([
  "sharepoint.com",
  "myshopify.com",
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "blogspot.com",
  "wordpress.com",
  "wixsite.com",
  "squarespace.com",
  "zendesk.com",
  "atlassian.net",
  "slack.com",
  "notion.site",
  "co.uk",
  "com.au",
  "co.jp",
  "com.pk",
  "com.br",
  "co.in",
]);

/** Whether a login saved for `site` may be offered on the page host `page`. */
function loginMatches(page: string, site: string, subdomains: boolean): boolean {
  if (page === site) return true;
  // Subdomains only when the login allows them, and never below a shared domain or a bare suffix.
  return subdomains && page.endsWith(`.${site}`) && site.includes(".") && !SHARED_DOMAINS.has(site);
}

/** Logins, cards and contact info (UI-SPEC §11 Vault), plus secrets bots request and are granted. */
export class VaultService {
  /** Open secret cards: the name the bot asked for (the only name the value is saved under) and the waiter. */
  private readonly pendingSecrets = new Map<string, { name: string; resolve(saved: boolean): void }>();

  constructor(private readonly services: Pick<Services, "store" | "vault" | "bus" | "turns">) {}

  items(): VaultItem[] {
    const parsed = z.array(VaultItem).safeParse(this.services.store.settings.get(ITEMS_KEY) ?? []);
    return parsed.success ? parsed.data : [];
  }

  private saveItems(items: VaultItem[]) {
    this.services.store.settings.set(ITEMS_KEY, items);
    this.services.bus.publish({ type: "data.changed", keys: ["vault"] });
  }

  add(input: NewVaultItem): VaultItem {
    const id = randomUUID().slice(0, 13);
    const base = { id, hints: input.hints ?? "", createdAt: new Date().toISOString() };
    let item: VaultItem;
    let secret: Record<string, string>;
    if (input.kind === "login") {
      item = {
        ...base,
        kind: "login",
        label: input.website,
        website: input.website,
        username: input.username,
        last4: null,
        ...(input.subdomains ? { subdomains: true } : {}),
      };
      secret = { password: input.password };
    } else if (input.kind === "card") {
      const digits = input.number.replace(/\s/g, "");
      item = {
        ...base,
        kind: "card",
        label: input.name,
        website: null,
        username: null,
        last4: digits.slice(-4),
      };
      secret = { number: digits, expiry: input.expiry, cvc: input.cvc, name: input.name };
    } else {
      item = { ...base, kind: "contact", label: input.name, website: null, username: null, last4: null };
      secret = {
        name: input.name,
        email: input.email ?? "",
        phone: input.phone ?? "",
        address: input.address ?? "",
      };
    }
    this.services.vault.set(itemSecret(id), JSON.stringify(secret));
    this.saveItems([...this.items(), item]);
    return item;
  }

  remove(id: string): boolean {
    const items = this.items();
    if (!items.some((item) => item.id === id)) return false;
    this.services.vault.delete(itemSecret(id));
    this.saveItems(items.filter((item) => item.id !== id));
    return true;
  }

  /** CSV export from a password manager: needs website/url, username, password columns. */
  importCsv(csv: string): { imported: number; skipped: number } {
    const rows = parseCsv(csv);
    const header = (rows.shift() ?? []).map((cell) => cell.trim().toLowerCase());
    const col = (...names: string[]) => header.findIndex((cell) => names.includes(cell));
    const site = col("url", "website", "login_uri", "site");
    const user = col("username", "login_username", "email", "user");
    const pass = col("password", "login_password");
    if (site === -1 || user === -1 || pass === -1)
      throw new Error("The CSV needs website, username and password columns.");
    const existing = new Set(this.items().map((item) => `${item.website}|${item.username}`));
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      const website = row[site]?.trim() ?? "";
      const username = row[user]?.trim() ?? "";
      const password = row[pass] ?? "";
      if (
        !website.startsWith("https://") ||
        !username ||
        !password ||
        existing.has(`${website}|${username}`)
      ) {
        skipped += 1;
        continue;
      }
      this.add({ kind: "login", website, username, password });
      existing.add(`${website}|${username}`);
      imported += 1;
    }
    return { imported, skipped };
  }

  grants(botId: string): string[] {
    return this.services.store.settings.get<string[]>(grantsKey(botId)) ?? [];
  }

  private grant(botId: string, names: string[]) {
    this.services.store.settings.set(grantsKey(botId), [...new Set([...this.grants(botId), ...names])]);
  }

  /**
   * The saved login for a web page's host, with its password, for the app to type into a sign-in form. Matches the
   * login's own site (with or without "www."), and its subdomains only for a login saved with that option, so
   * neither a look-alike site nor another tenant on a shared domain gets the password.
   */
  loginForHost(host: string): { item: VaultItem; password: string } | null {
    const page = host.toLowerCase().replace(/^www\./, "");
    for (const item of this.items()) {
      if (item.kind !== "login" || !item.website) continue;
      const site = siteHost(item.website);
      if (!site || !loginMatches(page, site, item.subdomains ?? false)) continue;
      const raw = this.services.vault.get(itemSecret(item.id));
      if (!raw) continue;
      return { item, password: (JSON.parse(raw) as { password: string }).password };
    }
    return null;
  }

  /** The saved login for exactly this site (the same site, not one whose name merely contains it). */
  private loginForSite(website: string): VaultItem | undefined {
    const wanted = siteHost(website);
    return wanted
      ? this.items().find(
          (item) => item.kind === "login" && item.website && siteHost(item.website) === wanted,
        )
      : undefined;
  }

  /** Secrets a bot's commands receive as environment variables. */
  envFor(bot: Bot): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this.grants(bot.id)) {
      if (name.startsWith("login:")) {
        const item = this.items().find((candidate) => candidate.id === name.slice(6));
        const raw = item ? this.services.vault.get(itemSecret(item.id)) : null;
        if (!item?.website || !raw) continue;
        const names = loginEnvNames(item.website);
        env[names.username] = item.username ?? "";
        env[names.password] = (JSON.parse(raw) as { password: string }).password;
      } else {
        const value = this.services.vault.get(name);
        if (value) env[name] = value;
      }
    }
    return env;
  }

  /**
   * Answers an open secret card: saves `value` (null when the user skipped it) under the name the bot asked for,
   * whatever the request says. False when the card is no longer waiting.
   */
  respondSecret(requestId: string, value: string | null): boolean {
    const pending = this.pendingSecrets.get(requestId);
    if (!pending) return false;
    if (value !== null) {
      this.services.vault.set(pending.name, value);
      this.services.bus.publish({ type: "secrets.changed", names: this.services.vault.names() });
    }
    pending.resolve(value !== null);
    return true;
  }

  tools(bot: Bot, threadId: string, messageId: string): ToolSpec[] {
    const items = this.items();
    return [
      defineTool({
        name: "request_secret",
        description:
          "Ask the user for an API key, token or password. They type it into a secure card; you never see the value. It becomes an environment variable with this name in your commands.",
        args: z.object({ name: SecretName, reason: z.string().min(1).max(300) }),
        risk: (args) => safe(`Ask for ${args.name}`),
        run: async (args, ctx) => {
          const hook = this.services.turns.partHooks.get(messageId);
          if (!hook) return "The secure card could not be shown.";
          const requestId = randomUUID();
          const part: Extract<MessagePart, { type: "secret" }> = {
            type: "secret",
            requestId,
            name: args.name,
            reason: args.reason,
            saved: false,
          };
          hook.parts.push(part);
          hook.publish();
          this.services.turns.setActivity(threadId, bot.id, "waiting_user");
          const saved = await new Promise<boolean>((resolve, reject) => {
            const onAbort = () => {
              this.pendingSecrets.delete(requestId);
              // A helper's card sits in its coordinator's message, which may go on: close it there too.
              part.expired = true;
              hook.publish();
              reject(new Error("Stopped."));
            };
            ctx.signal.addEventListener("abort", onAbort, { once: true });
            this.pendingSecrets.set(requestId, {
              name: args.name,
              resolve: (value) => {
                ctx.signal.removeEventListener("abort", onAbort);
                this.pendingSecrets.delete(requestId);
                resolve(value);
              },
            });
          });
          this.services.turns.setActivity(threadId, bot.id, "working");
          part.saved = saved;
          hook.publish();
          if (!saved) return "The user declined to provide it.";
          this.grant(bot.id, [args.name]);
          return `Saved securely as ${args.name}. Your commands can read it from the environment variable ${args.name}.`;
        },
      }),
      ...(items.some((item) => item.kind === "login")
        ? [
            defineTool({
              name: "use_login",
              description: `Get a saved login for a website as environment variables for your commands (you never see the password). Saved sites: ${items
                .filter((item) => item.kind === "login")
                .map((item) => item.website)
                .join(", ")}.`,
              args: z.object({ website: z.string().min(1) }),
              // The card names the login that will be handed over, not what the model typed.
              risk: (args) => {
                const item = this.loginForSite(args.website);
                return {
                  level: "ask",
                  kind: "general",
                  badges: [BADGES.security],
                  summary: item
                    ? `Use your saved login for ${item.website}${item.username ? ` (${item.username})` : ""}`
                    : `Use a saved login for ${args.website} (none matches)`,
                };
              },
              run: async (args) => {
                const item = this.loginForSite(args.website);
                if (!item?.website) return `No saved login matches ${args.website}.`;
                this.grant(bot.id, [`login:${item.id}`]);
                const names = loginEnvNames(item.website);
                return `Granted. In commands, use the environment variables ${names.username} and ${names.password}.`;
              },
            }),
          ]
        : []),
    ];
  }
}

/** RFC 4180-ish CSV: quoted fields, escaped quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

export function registerVaultRoutes(app: FastifyInstance, vaultService: VaultService) {
  app.get("/api/vault", async () => ({ items: vaultService.items() }));

  app.post("/api/vault", async (request, reply) => {
    const input = parse(NewVaultItem, request.body, reply);
    if (!input) return reply;
    return reply.code(201).send({ item: vaultService.add(input) });
  });

  app.post("/api/vault/import", async (request, reply) => {
    const input = parse(ImportCsvInput, request.body, reply);
    if (!input) return reply;
    try {
      return vaultService.importCsv(input.csv);
    } catch (error) {
      return fail(reply, 400, "invalid_csv", (error as Error).message);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/vault/:id", async (request, reply) => {
    return vaultService.remove(request.params.id)
      ? reply.code(204).send()
      : fail(reply, 404, "not_found", "No vault item has this id.");
  });

  /**
   * The secure secret card: the value goes straight to the keychain, under the name the bot asked for. A `name`
   * in the body (the card sends one) is never used, so an open request can't overwrite another secret.
   */
  app.post<{ Params: { id: string } }>("/api/secret-requests/:id", async (request, reply) => {
    const body = parse(
      z.object({
        name: SecretName.optional(),
        value: z.string().min(1).max(16_384).optional(),
        decline: z.boolean().optional(),
      }),
      request.body,
      reply,
    );
    if (!body) return reply;
    const value = !body.decline && body.value ? body.value : null;
    if (!vaultService.respondSecret(request.params.id, value)) {
      return fail(reply, 410, "expired", "This request is no longer waiting.");
    }
    return reply.code(204).send();
  });
}

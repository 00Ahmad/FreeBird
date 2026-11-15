import { timingSafeEqual } from "node:crypto";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import {
  APP_NAME,
  APP_VERSION,
  EPHEMERAL_EVENTS,
  newId,
  type HarnessEvent,
  type HarnessEventInput,
  type HealthResponse,
} from "@mrog/shared";

import { registerAgentRoutes } from "./agent";
import { fail } from "./http";
import { registerProviderRoutes } from "./providers";
import { registerBrowserRoutes } from "./browser";
import { registerLibraryRoutes } from "./routes/library";
import { registerComputerRoutes } from "./computer";
import { registerConnectorRoutes } from "./connectors";
import { registerDiscussionRoutes } from "./discussion";
import { registerRaceRoutes } from "./race";
import { registerCodingRoutes } from "./coding";
import { registerJobRoutes } from "./jobs/routes";
import { registerClientRoutes } from "./clients/routes";
import { registerRoutineRoutes } from "./routines";
import { registerTeamRoutes } from "./team";
import { registerVaultRoutes } from "./vault";
import { registerVoiceRoutes } from "./voice";
import { registerBotRoutes } from "./routes/bots";
import { registerChatRoutes } from "./routes/chat";
import { registerRuntimeRoutes } from "./routes/runtime";
import { registerSecretRoutes } from "./routes/secrets";
import type { Services } from "./services";

/** Extra route modules added by later phases. */
export type RouteModule = (app: FastifyInstance, services: Services) => void;

/** Rejecting other Host headers stops DNS-rebinding pages from reaching the loopback server. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

const UI_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  // Pictures in bot replies (product photos, charts) come from the web, as they do in development.
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  // The bot computer's desktop is a web page on a local port.
  "frame-src http://127.0.0.1:* http://localhost:*",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

function hostnameOf(host: string | undefined): string {
  if (!host) return "";
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0] ?? "";
}

function tokenMatches(authorization: string | undefined, token: string): boolean {
  const presented = Buffer.from(authorization?.startsWith("Bearer ") ? authorization.slice(7) : "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Stream-only events, stamped here instead of by the bus so they are never stored for replay. */
function ephemeral(
  event: Extract<HarnessEventInput, { type: "stream.hello" | "stream.resync" }>,
): HarnessEvent {
  return { ...event, id: newId("evt"), at: new Date().toISOString() } as HarnessEvent;
}

/** API routes that skip the bearer token. (Webhooks live outside /api at /hooks/ and carry their own secret.) */
const PUBLIC_ROUTES = new Set(["/api/health"]);

export async function buildServer(services: Services, modules: RouteModule[] = []): Promise<FastifyInstance> {
  const { config, bus } = services;
  const startedAt = new Date().toISOString();
  const app = Fastify({ logger: false, forceCloseConnections: true, bodyLimit: 32 * 1024 * 1024 });

  await app.register(cors, {
    origin: config.uiOrigins.length > 0 ? config.uiOrigins : false,
    allowedHeaders: ["Authorization", "Content-Type", "Last-Event-ID"],
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    maxAge: 600,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!LOOPBACK_HOSTNAMES.has(hostnameOf(request.headers.host))) {
      return fail(reply, 403, "forbidden_host", "Requests must be addressed to the loopback host.");
    }
    // Decided on the route that matched, not only the raw URL: the router decodes "/%61pi/…" to "/api/…".
    const route = request.routeOptions.url ?? "";
    const path = request.url.split("?")[0] ?? "";
    if (!(route.startsWith("/api/") || path.startsWith("/api/")) || request.method === "OPTIONS") return;
    if (PUBLIC_ROUTES.has(route)) return;
    if (!tokenMatches(request.headers.authorization, config.token)) {
      return fail(reply, 401, "unauthorized", "Missing or wrong token.");
    }
  });

  app.setErrorHandler((error: { statusCode?: number; code?: string; message: string }, request, reply) => {
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) console.error("[harness]", request.method, request.url, error);
    return status === 500
      ? fail(reply, 500, "internal", "Something went wrong in the harness.")
      : fail(reply, status, error.code ?? "bad_request", error.message);
  });

  app.get(
    "/api/health",
    async () => ({ ok: true, name: APP_NAME, version: APP_VERSION, startedAt }) satisfies HealthResponse,
  );

  // ---- events (SSE) ---------------------------------------------------------------------------------------
  // Open streams and how to unsubscribe each from the bus.
  const streams = new Map<ServerResponse, () => void>();

  app.get("/api/events", (request, reply) => {
    const headers: OutgoingHttpHeaders = {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, headers);

    const write = (event: HarnessEvent) => {
      if (res.writableEnded || res.destroyed) return;
      const idLine = EPHEMERAL_EVENTS.has(event.type) ? "" : `id: ${event.id}\n`;
      res.write(`${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    res.write("retry: 2000\n\n");
    write(ephemeral({ type: "stream.hello", version: APP_VERSION, startedAt }));
    const lastId = request.headers["last-event-id"];
    if (typeof lastId === "string" && lastId) {
      const missed = bus.since(lastId);
      if (missed === null) write(ephemeral({ type: "stream.resync" }));
      else missed.forEach(write);
    }

    streams.set(res, bus.subscribe(write));
    request.raw.on("close", () => {
      streams.get(res)?.();
      streams.delete(res);
    });
  });

  const heartbeat = setInterval(() => bus.publish({ type: "heartbeat" }), config.heartbeatMs);
  heartbeat.unref();
  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const [res, unsubscribe] of streams) {
      unsubscribe();
      res.end();
    }
    streams.clear();
    for (const dispose of services.disposers.toReversed()) await dispose();
  });

  registerBotRoutes(app, services);
  registerSecretRoutes(app, services);
  registerChatRoutes(app, services);
  registerDiscussionRoutes(app, services);
  registerRaceRoutes(app, services);
  registerCodingRoutes(app, services);
  registerJobRoutes(app, services);
  registerClientRoutes(app, services);
  registerRuntimeRoutes(app, services);
  registerAgentRoutes(app, services.agent);
  registerProviderRoutes(app, services, services.providers);
  registerTeamRoutes(app, services);
  registerRoutineRoutes(app, services, services.routines);
  registerConnectorRoutes(app, services.connectors);
  registerVaultRoutes(app, services.vaultService);
  registerComputerRoutes(app, services.computer, services);
  registerBrowserRoutes(app, services.browser);
  registerLibraryRoutes(app, services);
  registerVoiceRoutes(app, services, services.fetchImpl);
  for (const register of modules) register(app, services);

  // ---- built UI (packaged app) ----------------------------------------------------------------------------
  if (config.uiDist) {
    await app.register(fastifyStatic, { root: config.uiDist, prefix: "/" });
    app.addHook("onSend", async (request, reply, payload) => {
      if (!request.url.startsWith("/api/")) {
        reply.header("content-security-policy", UI_CSP);
        reply.header("x-content-type-options", "nosniff");
      }
      return payload;
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isPage = request.method === "GET" && !request.url.startsWith("/api/");
    if (config.uiDist && isPage) return reply.sendFile("index.html");
    return fail(reply, 404, "not_found", "Not found.");
  });

  return app;
}

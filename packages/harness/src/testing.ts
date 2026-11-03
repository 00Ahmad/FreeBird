import type { FastifyInstance } from "fastify";

import { openStore, type Store } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { EventBus } from "./bus";
import type { HarnessConfig } from "./config";
import { settingsNameIndex } from "./index";
import { buildServer, type RouteModule } from "./server";
import { createServices, type Services } from "./services";

const TEST_TOKEN = "t".repeat(64);
export const auth = { authorization: `Bearer ${TEST_TOKEN}` };

const testConfig = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  host: "127.0.0.1",
  port: 0,
  token: TEST_TOKEN,
  dataDir: ":memory:",
  uiOrigins: ["http://127.0.0.1:5173"],
  uiDist: null,
  heartbeatMs: 60_000,
  vault: "memory",
  keyringService: "test",
  previousKeyringService: null,
  ...over,
});

type FakeHandler = (body: any) => Response | Promise<Response>;

/** A fetch that serves Ollama-style paths from handlers and records request bodies. */
export function fakeFetch(handlers: Record<string, FakeHandler>) {
  const calls: { url: string; path: string; body: any; headers: Headers }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url: url.toString(), path: url.pathname, body, headers: new Headers(init?.headers) });
    const handler = handlers[url.pathname] ?? handlers[`${url.host}${url.pathname}`];
    return handler ? handler(body) : new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

export const ndjson = (rows: unknown[]) =>
  new Response(new Blob([rows.map((row) => JSON.stringify(row)).join("\n") + "\n"]).stream());

/** Ollama with one installed tool-capable model whose chat replies come from `reply`. */
export function fakeOllama(
  reply: FakeHandler = () => ndjson([{ message: { content: "Hi!" } }, { done: true }]),
) {
  return {
    "/api/version": () => Response.json({ version: "0.0.0-test" }),
    "/api/tags": () =>
      Response.json({
        models: [
          {
            name: "test:1b",
            size: 1,
            capabilities: ["completion", "tools"],
            details: { context_length: 8192 },
          },
        ],
      }),
    "/api/ps": () => Response.json({ models: [] }),
    "/api/chat": reply,
  } satisfies Record<string, FakeHandler>;
}

export interface TestHarness {
  app: FastifyInstance;
  store: Store;
  bus: EventBus;
  services: Services;
  calls: ReturnType<typeof fakeFetch>["calls"];
  close(): Promise<void>;
}

export async function makeHarness(
  options: {
    config?: Partial<HarnessConfig>;
    handlers?: Record<string, FakeHandler>;
    modules?: RouteModule[];
    setup?(services: Services): void;
  } = {},
): Promise<TestHarness> {
  const store = openStore(":memory:");
  const bus = new EventBus();
  const vault = new Vault(new MemoryBackend(), settingsNameIndex(store.settings));
  const { impl, calls } = fakeFetch(options.handlers ?? fakeOllama());
  const services = createServices({ config: testConfig(options.config), store, vault, bus, fetchImpl: impl });
  options.setup?.(services);
  const app = await buildServer(services, options.modules);
  return {
    app,
    store,
    bus,
    services,
    calls,
    async close() {
      await app.close();
      store.close();
    },
  };
}

/** Resolves with the first event matching `match` (or rejects after a timeout). */
export function nextEvent<T>(bus: EventBus, match: (event: any) => T | undefined | false, timeoutMs = 3000) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("Timed out waiting for event"));
    }, timeoutMs);
    const off = bus.subscribe((event) => {
      const value = match(event);
      if (value) {
        clearTimeout(timer);
        off();
        resolve(value);
      }
    });
  });
}

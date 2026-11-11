import { createServer } from "node:net";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config";
import { listenOn } from "./index";

const open: FastifyInstance[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const portOf = (url: string) => Number(new URL(url).port);

/** A port nothing is using right now. */
async function freePort(): Promise<number> {
  const probe = Fastify();
  await probe.listen({ host: "127.0.0.1", port: 0 });
  const port = (probe.server.address() as { port: number }).port;
  await probe.close();
  return port;
}

/** Holds a port, as another program would. */
async function occupy(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return (server.address() as { port: number }).port;
}

async function start(config: { port: number; preferredPort?: number }) {
  const app = Fastify();
  open.push(app);
  return portOf(await listenOn(app, { host: "127.0.0.1", ...config }));
}

describe("which port the harness listens on", () => {
  it("takes the preferred port when it is free", async () => {
    const wanted = await freePort();
    expect(await start({ port: 0, preferredPort: wanted })).toBe(wanted);
  });

  it("falls back to another free port when the preferred one is busy", async () => {
    const busy = await occupy();
    const got = await start({ port: 0, preferredPort: busy });
    expect(got).toBeGreaterThan(0);
    expect(got).not.toBe(busy);
  });

  it("picks a random port when none is preferred", async () => {
    expect(await start({ port: 0 })).toBeGreaterThan(0);
  });

  it("ignores the preference when an exact port is asked for", async () => {
    const exact = await freePort();
    const other = await freePort();
    expect(await start({ port: exact, preferredPort: other })).toBe(exact);
  });
});

describe("the port settings", () => {
  const env = { MROG_TOKEN: "t".repeat(64) };

  it("reads the preferred port", () => {
    expect(loadConfig({ ...env, MROG_PORT: "0", MROG_PREFERRED_PORT: "51234" }).preferredPort).toBe(51234);
  });

  it("never fails because of a bad preference", () => {
    for (const bad of ["abc", "0", "-5", "70000", "1.5", ""]) {
      const config = loadConfig({ ...env, MROG_PORT: "0", MROG_PREFERRED_PORT: bad });
      expect(config.preferredPort).toBeUndefined();
      expect(config.port).toBe(0);
    }
  });

  it("still rejects a bad MROG_PORT", () => {
    expect(() => loadConfig({ ...env, MROG_PORT: "70000" })).toThrow(/Invalid MROG_PORT/);
  });
});

import type { FastifyInstance, FastifyReply } from "fastify";

import { SecretName, SetSecretInput, type SecretList } from "@mrog/shared";

import { fail, parse } from "../http";
import type { Services } from "../services";

/** Runs a keychain call; on failure sends a 503 and returns undefined. */
function vaultCall<T>(reply: FastifyReply, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    console.error("[harness] vault error", error);
    void fail(reply, 503, "vault_unavailable", "The system keychain could not be used.");
    return undefined;
  }
}

/** Names only ever leave the harness, never values. */
export function registerSecretRoutes(app: FastifyInstance, { vault, bus }: Services) {
  app.get("/api/secrets", async () => ({ names: vault.names() }) satisfies SecretList);

  app.put<{ Params: { name: string } }>("/api/secrets/:name", async (request, reply) => {
    const name = parse(SecretName, request.params.name, reply);
    if (!name) return reply;
    const input = parse(SetSecretInput, request.body, reply);
    if (!input) return reply;
    if (vaultCall(reply, () => (vault.set(name, input.value), true)) === undefined) return reply;
    bus.publish({ type: "secrets.changed", names: vault.names() });
    return reply.code(204).send();
  });

  app.delete<{ Params: { name: string } }>("/api/secrets/:name", async (request, reply) => {
    const name = parse(SecretName, request.params.name, reply);
    if (!name) return reply;
    const deleted = vaultCall(reply, () => vault.delete(name));
    if (deleted === undefined) return reply;
    if (!deleted) return fail(reply, 404, "not_found", "No secret has this name.");
    bus.publish({ type: "secrets.changed", names: vault.names() });
    return reply.code(204).send();
  });
}

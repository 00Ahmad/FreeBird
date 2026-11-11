import type { FastifyInstance, FastifyReply } from "fastify";

import { isSecretTooLong, SECRET_TOO_LONG, SecretName, SetSecretInput, type SecretList } from "@mrog/shared";
import { SecretTooLongError } from "@mrog/vault";

import { fail, parse } from "../http";
import type { Services } from "../services";

/** Runs a keychain call; on failure sends a 503 (400 for a value too long) and returns undefined. */
function vaultCall<T>(reply: FastifyReply, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if (error instanceof SecretTooLongError) {
      void fail(reply, 400, error.code, error.message);
      return undefined;
    }
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
    // Said in plain words here; the schema would only report it as an invalid request.
    if (isSecretTooLong((request.body as { value?: unknown } | null)?.value))
      return fail(reply, 400, "secret_too_long", SECRET_TOO_LONG);
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

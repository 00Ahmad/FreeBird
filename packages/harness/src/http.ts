import type { FastifyReply } from "fastify";
import type { z } from "zod";

import type { ApiError } from "@mrog/shared";

export function fail(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
  issues?: ApiError["issues"],
) {
  const body: ApiError = { error, message, ...(issues ? { issues } : {}) };
  return reply.code(status).send(body);
}

/** Parsed value, or undefined after sending a 400 with the validation issues. */
export function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
): z.infer<S> | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  void fail(reply, 400, "invalid_request", "The request is not valid.", issues);
  return undefined;
}

/** Runs a call that may throw; on failure sends `status` with the error's message and returns undefined. */
export async function attempt<T>(
  reply: FastifyReply,
  fn: () => T | Promise<T>,
  status = 503,
  code = "unavailable",
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    void fail(reply, status, (error as { code?: string }).code ?? code, (error as Error).message);
    return undefined;
  }
}

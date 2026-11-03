import { z } from "zod";

export const APP_NAME = "FreeBird";
export const APP_VERSION = "0.0.2";

export const HealthResponse = z.object({
  ok: z.literal(true),
  name: z.literal(APP_NAME),
  version: z.string(),
  startedAt: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/** Secret names become keychain entries and env var names, so keep them to a safe charset. */
export const SecretName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "Use UPPER_SNAKE_CASE, 2–64 characters");

export const SetSecretInput = z.object({ value: z.string().min(1).max(16_384) });

export const SecretList = z.object({ names: z.array(z.string()) });
export type SecretList = z.infer<typeof SecretList>;

/** Line the harness prints on stdout once it is listening, so a parent process can read its port. */
export const READY_PREFIX = "MROG_READY ";
export const ReadyLine = z.object({ url: z.string(), version: z.string() });
export type ReadyLine = z.infer<typeof ReadyLine>;

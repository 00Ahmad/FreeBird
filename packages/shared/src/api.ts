import { z } from "zod";

export const APP_NAME = "FreeBird";
export const APP_VERSION = "0.0.6";

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

/**
 * The longest secret the keychain is sure to hold, in UTF-16 units. Windows Credential Manager stops at 1,280 and
 * refuses more, so this is the limit everywhere, whatever the system.
 */
export const MAX_SECRET_LENGTH = 1280;

/** What the app says when a secret is longer than that. */
export const SECRET_TOO_LONG = `A secret can be at most ${MAX_SECRET_LENGTH.toLocaleString("en-US")} characters long.`;

/** True for text too long to be stored as one secret (checked before a request is parsed, to answer in plain words). */
export const isSecretTooLong = (value: unknown): boolean =>
  typeof value === "string" && value.length > MAX_SECRET_LENGTH;

export const SetSecretInput = z.object({ value: z.string().min(1).max(MAX_SECRET_LENGTH, SECRET_TOO_LONG) });

export const SecretList = z.object({ names: z.array(z.string()) });
export type SecretList = z.infer<typeof SecretList>;

/** Line the harness prints on stdout once it is listening, so a parent process can read its port. */
export const READY_PREFIX = "MROG_READY ";
export const ReadyLine = z.object({ url: z.string(), version: z.string() });
export type ReadyLine = z.infer<typeof ReadyLine>;

import { ApiError } from "@mrog/shared";

import { harnessInfo } from "./harness";

const rawMessage = (raw: unknown): string | null =>
  raw && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string"
    ? (raw as { message: string }).message
    : null;

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
    /** The answer as the server sent it, for fields ApiError doesn't know (a 409 that says needsReplace, say). */
    readonly raw: unknown = null,
  ) {
    super(body?.message ?? rawMessage(raw) ?? `Request failed (${status})`);
  }
}

/** JSON request to the harness API; throws ApiRequestError on a non-2xx answer. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const harness = harnessInfo();
  if (!harness)
    throw new ApiRequestError(0, { error: "no_harness", message: "The harness address is unknown." });
  const res = await fetch(`${harness.url}/api${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${harness.token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const parsed = ApiError.safeParse(json);
    throw new ApiRequestError(res.status, parsed.success ? parsed.data : null, json);
  }
  return json as T;
}

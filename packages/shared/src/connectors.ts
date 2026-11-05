import { z } from "zod";

/** Environment values may reference a vault secret as "vault:NAME" so keys never sit in plain config. */
export const ConnectorTransport = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().trim().min(1).max(500),
    args: z.array(z.string().max(2000)).max(50),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)),
  }),
  z.object({
    type: z.literal("http"),
    url: z.url(),
    headers: z.record(z.string(), z.string().max(4000)),
  }),
]);
export type ConnectorTransport = z.infer<typeof ConnectorTransport>;

/** A connected app: any MCP server, local (stdio) or remote (HTTP). */
export const ConnectorConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/),
  name: z.string().min(1).max(60),
  transport: ConnectorTransport,
  enabled: z.boolean(),
  /** Per-tool toggles: tools listed here are hidden from bots. */
  disabledTools: z.array(z.string()),
  /** Ask before each use (default) or let bots use it freely. */
  askBeforeUse: z.boolean(),
});
export type ConnectorConfig = z.infer<typeof ConnectorConfig>;

export const AddConnectorInput = ConnectorConfig.omit({
  id: true,
  enabled: true,
  disabledTools: true,
}).extend({
  askBeforeUse: z.boolean().optional(),
});
export type AddConnectorInput = z.infer<typeof AddConnectorInput>;

export const UpdateConnectorInput = ConnectorConfig.omit({ id: true }).partial();
export type UpdateConnectorInput = z.infer<typeof UpdateConnectorInput>;

/** "auth": the app wants the user to sign in (OAuth) before it can be used. */
export const ConnectorState = z.enum(["off", "connecting", "connected", "error", "auth"]);

export const ConnectorView = ConnectorConfig.extend({
  state: ConnectorState,
  error: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), description: z.string(), enabled: z.boolean() })),
});
export type ConnectorView = z.infer<typeof ConnectorView>;

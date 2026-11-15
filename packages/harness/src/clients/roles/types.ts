import type { Avatar, ClientRole } from "@mrog/shared";

/**
 * A Client Bot role, as data: its name, look, the only tools it may use and its standing rules. Each role's task
 * builders live in the same file as its spec.
 */
export interface RoleSpec {
  role: ClientRole;
  name: string;
  avatar: Avatar;
  /** Pages are untrusted text, so each role's tool list is as short as it can be. */
  tools: readonly string[];
  visual?: boolean;
  rules: string;
}

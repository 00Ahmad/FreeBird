import { z } from "zod";

export const PermissionRule = z.object({
  id: z.string(),
  /** Tool name, e.g. "write_file" or "run_command". */
  tool: z.string().min(1),
  /** Optional prefix the action's summary must start with (e.g. a command like "git status"). */
  match: z.string().nullable(),
  decision: z.enum(["allow", "ask"]),
  createdAt: z.iso.datetime(),
});
export type PermissionRule = z.infer<typeof PermissionRule>;

export const Permissions = z.object({
  /** "Execution on this computer": commands always ask, always run, or never run. */
  localExecution: z.enum(["ask", "always", "never"]),
  rules: z.array(PermissionRule),
});
export type Permissions = z.infer<typeof Permissions>;

export const DEFAULT_PERMISSIONS: Permissions = { localExecution: "ask", rules: [] };

export const ApprovalDecision = z.enum(["allow_once", "always", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const NewPermissionRule = PermissionRule.pick({ tool: true, match: true, decision: true });

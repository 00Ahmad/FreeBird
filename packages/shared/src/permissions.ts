import { z } from "zod";

export const PermissionRule = z.object({
  id: z.string(),
  /** Tool name, e.g. "write_file" or "run_command". */
  tool: z.string().min(1),
  /** Optional prefix the action's summary must start with (e.g. a command like "git status"). */
  match: z.string().nullable(),
  /**
   * The summary must equal `match` exactly instead of starting with it. Rules made by "Always allow" are exact
   * (that one action, not everything that begins the same way); rules a person types are prefixes. Rules saved
   * before this existed have no value and stay prefixes.
   */
  exact: z.boolean().optional(),
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

/**
 * Badge on a card that cuts off part of what the bot asked to do. Nobody can approve for good what they could not
 * see, so such a card never offers "Always allow".
 */
export const PARTLY_HIDDEN_BADGE = "Part of this isn't shown";

/** Whether a saved rule covers an action with this summary: equal for an exact rule, otherwise a prefix (or anything). */
export const ruleMatches = (rule: Pick<PermissionRule, "match" | "exact">, summary: string) =>
  !rule.match || (rule.exact === true ? summary === rule.match : summary.startsWith(rule.match));

export const ApprovalDecision = z.enum(["allow_once", "always", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const NewPermissionRule = PermissionRule.pick({ tool: true, match: true, decision: true });

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

/**
 * What makes the rest of a command line do more than its start says: a second command (; & | or a new line),
 * redirection (< >), a command run inside it ($( ), ( ), backticks) or text run as code (iex, Invoke-Expression,
 * PowerShell's -EncodedCommand and its short forms, which also take /, – and — in place of -).
 */
const RUNS_MORE =
  /[;&|`<>()\r\n\x85\p{Zl}\p{Zp}]|(?<![\w-])(?:iex|Invoke-Expression)(?![\w-])|(?<![\w\p{Pd}])[\p{Pd}/]e(?:c|n\w*)?(?![\w-])/iu;

/** Whether text after a command rule's start would chain, redirect or hide another command. */
export const runsMore = (rest: string) => RUNS_MORE.test(rest);

/**
 * Whether a saved rule covers an action with this summary: equal for an exact rule, otherwise a prefix (or anything).
 * For a command, pass its text as `command`: a typed rule "npm" then covers "npm install lodash" but not
 * "npm i; Remove-Item -Recurse ~", since what follows the rule's start must not run anything else.
 */
export const ruleMatches = (
  rule: Pick<PermissionRule, "match" | "exact">,
  summary: string,
  options: { command?: string } = {},
) => {
  if (rule.exact === true) return !rule.match || summary === rule.match;
  if (rule.match && !summary.startsWith(rule.match)) return false;
  if (options.command === undefined) return true;
  const start = rule.match?.length ?? 0;
  return start >= options.command.length || !runsMore(options.command.slice(start));
};

export const ApprovalDecision = z.enum(["allow_once", "always", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const NewPermissionRule = PermissionRule.pick({ tool: true, match: true, decision: true });

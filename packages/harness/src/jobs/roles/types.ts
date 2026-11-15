import type { Avatar, JobRole } from "@mrog/shared";

/**
 * A Job Bot role, as data: its name, look, the only tools it may use and its standing rules. The loop doesn't change
 * to add or change a role. Each role's task builders live in the same file as its spec.
 */
export interface RoleSpec {
  role: JobRole;
  /** "Interviewer": its bot is named "<Job Bot> Interviewer". */
  name: string;
  avatar: Avatar;
  /** The tools it has, and nothing else. Job pages are untrusted text, so the lists are as short as they can be. */
  tools: readonly string[];
  /** A Visual Bot (works from screenshots). */
  visual?: boolean;
  /** Its standing rules, added to its prompt. */
  rules: string;
}

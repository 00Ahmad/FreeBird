import { z } from "zod";

/** How bots work through a task (Settings → General). */
export const AgentSettings = z.object({
  /** Most tool-using steps in one reply before the bot stops and reports what it has. */
  maxSteps: z.number().int().min(5).max(80),
  /** Before the final answer of a tool-using task, the bot checks it against the request once. */
  selfCheck: z.boolean(),
  /** For tasks with several steps, the bot writes a checklist first and ticks it off. */
  planning: z.boolean(),
});
export type AgentSettings = z.infer<typeof AgentSettings>;

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { maxSteps: 25, selfCheck: true, planning: true };

export const PlanStepStatus = z.enum(["todo", "doing", "done"]);
export type PlanStepStatus = z.infer<typeof PlanStepStatus>;

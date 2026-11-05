import type { ToolHost, ToolOutcome } from "@mrog/engine";
import type { JsonSchema, ToolCall } from "@mrog/providers";

import { argsSchema, type Risk, type ToolContext, type ToolSpec } from "./types";

export interface ApprovalRequest {
  call: ToolCall;
  spec: ToolSpec;
  args: unknown;
  risk: Risk;
}

/** "timeout": nobody answered the card in time. That is not the user saying no, and the bot is told so. */
export type Approver = (request: ApprovalRequest) => Promise<"allow" | "deny" | "timeout">;

/** What the bot is told when a call isn't run, and why: a refusal and silence mean different things. */
export const DENIED_RESULT = "The user denied this action. Do not retry it.";
export const TIMED_OUT_RESULT =
  "Nobody answered the approval request in time, so this was not run. Don't retry it unless the user asks for it again.";

/** Things the host tells its owner about a call as it goes. */
export interface HostHooks {
  /** Right before a call that changes something outside the chat runs (after any approval). */
  outward?(call: ToolCall): void;
  /** Takes the user's known secret values out of a result or error before the model or the chat sees it. */
  scrub?(text: string): string;
}

const MAX_RESULT = 20_000;

/**
 * Small models often send `"2"` for 2, `"true"` for true, `null` for "not given", or a number just outside the
 * allowed range. Fix those against the tool's schema before validating, instead of failing the call.
 */
export function normalizeArgs(args: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<
    string,
    { type?: string; minimum?: number; maximum?: number }
  >;
  // Some models wrap the real arguments: {"function": "x", "parameters": {...}}.
  for (const wrapper of ["parameters", "arguments", "args", "input"]) {
    const inner = args?.[wrapper];
    if (!(wrapper in properties) && inner && typeof inner === "object" && !Array.isArray(inner)) {
      args = { ...(inner as Record<string, unknown>) };
      break;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    const prop = properties[key];
    if (value === null || value === "") {
      if (prop?.type !== "string") continue;
    }
    if (prop && (prop.type === "number" || prop.type === "integer")) {
      const raw = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        let number = prop.type === "integer" ? Math.round(raw) : raw;
        if (prop.minimum !== undefined) number = Math.max(prop.minimum, number);
        if (prop.maximum !== undefined) number = Math.min(prop.maximum, number);
        out[key] = number;
        continue;
      }
    }
    if (prop?.type === "boolean" && typeof value === "string" && /^(true|false)$/i.test(value)) {
      out[key] = value.toLowerCase() === "true";
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Turns tool specs into the engine's ToolHost: validates arguments, asks for approval when needed, runs. */
export function createToolHost(
  specs: ToolSpec[],
  context: Omit<ToolContext, "signal">,
  approve: Approver,
  hooks: HostHooks = {},
): ToolHost {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const schemas = new Map(specs.map((spec) => [spec.name, argsSchema(spec)]));
  // Secrets the bot's commands get from the Vault must never come back to the model (e.g. `echo $env:PASSWORD`).
  const secrets = Object.values(context.env ?? {})
    .filter((value) => value.length >= 4)
    .toSorted((a, b) => b.length - a.length);
  const masked = (text: string) => secrets.reduce((out, value) => out.replaceAll(value, "[hidden]"), text);
  // The command's own secrets first (they may be short), then everything the app knows is secret.
  const hide = (text: string) => (hooks.scrub ? hooks.scrub(masked(text)) : masked(text));
  return {
    definitions: () =>
      specs.map((spec) => ({
        name: spec.name,
        description: spec.description,
        parameters: schemas.get(spec.name)!,
      })),
    async execute(asked, signal): Promise<ToolOutcome> {
      // Models sometimes drop a tool's prefix ("click" for browser_click); accept it when only one tool fits.
      const shortened = specs.filter((candidate) => candidate.name.endsWith(`_${asked.name}`));
      const spec = byName.get(asked.name) ?? (shortened.length === 1 ? shortened[0] : undefined);
      if (!spec) {
        return {
          status: "error",
          result: `There is no tool named "${asked.name}". Tools: ${[...byName.keys()].join(", ")}.`,
        };
      }
      const call = asked.name === spec.name ? asked : { ...asked, name: spec.name };
      const normalized = normalizeArgs(call.arguments, schemas.get(spec.name)!);
      const parsed = spec.args.safeParse(spec.prepare ? spec.prepare(normalized) : normalized);
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`,
        );
        return { status: "error", result: `Invalid arguments for ${call.name}: ${issues.join("; ")}` };
      }
      const ctx: ToolContext = { ...context, signal };
      let risk: Risk;
      try {
        risk = await spec.risk(parsed.data, ctx);
      } catch (error) {
        return { status: "error", result: (error as Error).message };
      }
      if (risk.level === "ask") {
        const decision = await approve({ call, spec, args: parsed.data, risk });
        if (decision === "deny") return { status: "denied", result: DENIED_RESULT };
        if (decision === "timeout") return { status: "denied", result: TIMED_OUT_RESULT };
      }
      // Saved by the owner before the call starts: if the app dies during it, the restart knows it may have happened.
      if (risk.outward ?? risk.level === "ask") hooks.outward?.(call);
      try {
        const output = await spec.run(parsed.data, ctx);
        const result = hide(typeof output === "string" ? output : output.text);
        return {
          status: "done",
          result: result.length > MAX_RESULT ? `${result.slice(0, MAX_RESULT)}\n…(cut)` : result,
          ...(typeof output !== "string" && output.images.length > 0 ? { images: output.images } : {}),
        };
      } catch (error) {
        if (signal.aborted) throw error;
        return { status: "error", result: hide((error as Error).message) };
      }
    },
  };
}

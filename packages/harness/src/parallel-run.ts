import { runTurn, type ToolHost, type ToolOutcome, type TurnSink } from "@mrog/engine";
import { ProviderError, type ChatMessage, type ChatProvider } from "@mrog/providers";
import type { MessagePart, ModelCapability, Usage } from "@mrog/shared";

import { keepKnownLinks } from "./discussion";
import {
  clipForLane,
  laneHeader,
  laneKnownLinks,
  laneNote,
  LANE_STAGGER_MS,
  plainLaneNote,
  parseRoles,
  rolesRequest,
  type LaneRole,
} from "./parallel-lanes";

/** The history with a note added to its newest user message (or as one, when the newest message isn't the user's). */
export function withNote(history: ChatMessage[], note: string): ChatMessage[] {
  const last = history.at(-1);
  if (last?.role !== "user") return [...history, { role: "user", content: note }];
  return [...history.slice(0, -1), { ...last, content: `${last.content}\n\n${note}` }];
}

const THINK_END = "</think>";

/** What the lane runner needs from the turn it runs inside. */
export interface LanesContext {
  /** The one reply's parts, which every lane writes into (each part tagged with its lane). */
  parts: MessagePart[];
  /** Saves and announces the whole reply. */
  publish(): void;
  /** Announces text added to one part, and marks the reply as needing a save. */
  delta(partIndex: number, kind: "text" | "reasoning", text: string): void;
  /** Shows the bot as working. */
  working(): void;
  /** False once the reply is gone (the chat was cleared): nothing more is written. */
  alive(): boolean;
  signal: AbortSignal;
  /** Takes requests through the group's slot. */
  provider: ChatProvider;
  model: string;
  capabilities: ModelCapability[];
  contextWindow: number;
  local: { numCtx: number; keepAlive: string } | undefined;
  think: boolean;
  system: string;
  /** The chat up to the user's question. */
  history: ChatMessage[];
  /** What the user asked, to know which links they gave. */
  question: string;
  steps: number;
  staggerMs?: number;
  /** One short question to the model, no tools (picks the roles). */
  ask(system: string, user: string): Promise<string>;
  /**
   * A role's tools: only search and opening pages, with its own browser tab (undefined when it has none). Left out
   * altogether, the roles run without tools: a note without tool lines, and no link check.
   */
  tools?(lane: number, signal: AbortSignal): ToolHost | undefined;
  scrub?(text: string): string;
  /** A line for the top of the reply (the memory warning), or null. */
  warning: string | null;
}

/**
 * The three roles as three conversations side by side. Each lane has its own model conversation, its own tool host and
 * step count and its own abort line, writes only parts tagged with its number, and never sees another lane's messages or
 * results. One lane failing leaves the others running. Resolves when every lane is over; throws only when stopped.
 */
export async function runLanes(ctx: LanesContext): Promise<{ usage: Usage; allFailed: boolean }> {
  const { parts, signal } = ctx;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  // Phase 1: the roles. A reply that can't be read gives the fallback roles; only Stop ends the turn here.
  const request = rolesRequest(ctx.question);
  let roles: LaneRole[];
  try {
    roles = parseRoles(await ctx.ask(request.system, request.user));
  } catch (error) {
    if (signal.aborted) throw error;
    roles = parseRoles("");
  }
  if (ctx.warning) parts.push({ type: "text", text: ctx.warning });
  const headers = roles.map((role, i): MessagePart => ({
    type: "text",
    lane: i + 1,
    text: laneHeader(i + 1, role.role, role.focus),
  }));
  parts.push(...headers);
  ctx.publish();
  /** Whether a lane wrote an answer (text that isn't its heading). */
  const hasAnswer = (lane: number) =>
    parts.some(
      (part) => part.type === "text" && part.lane === lane && !headers.includes(part) && part.text.trim(),
    );

  const failed = new Set<number>();

  const runOne = async (lane: number, role: LaneRole) => {
    const index = lane - 1;
    if (index > 0 && (ctx.staggerMs ?? LANE_STAGGER_MS) > 0)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, index * (ctx.staggerMs ?? LANE_STAGGER_MS));
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
    if (signal.aborted) return;

    // Its own abort line, chained to the turn's: Stop stops every lane.
    const own = new AbortController();
    const stop = () => own.abort();
    signal.addEventListener("abort", stop, { once: true });
    const prefix = `L${lane}-`;
    // The whole results the screen shows; the model reads them cut.
    const whole = new Map<string, string>();

    const host = ctx.tools?.(lane, own.signal);
    const definitions = host?.definitions() ?? [];
    const tools: ToolHost | undefined =
      host && definitions.length > 0
        ? {
            definitions: () => definitions,
            // The id carries the lane, so an approval card or a result can only ever reach this lane's part.
            execute: async (call, callSignal): Promise<ToolOutcome> => {
              const outcome = await host.execute({ ...call, id: `${prefix}${call.id}` }, callSignal);
              whole.set(call.id, outcome.result);
              return { ...outcome, result: clipForLane(outcome.result) };
            },
          }
        : undefined;

    const lastOfLane = () => parts.findLast((part) => "lane" in part && part.lane === lane);
    const push = (part: MessagePart) => {
      parts.push(part);
      return parts.length - 1;
    };

    let reasoningFrom: { part: MessagePart | null; length: number } | null = null;
    const append = (kind: "text" | "reasoning", text: string) => {
      const last = lastOfLane();
      let target: { type: "text" | "reasoning"; text: string; lane?: number };
      if (last && last.type === kind && !headers.includes(last)) target = last;
      else {
        target = { type: kind, lane, text: "" };
        push(target as MessagePart);
        // Announced whole, with its lane, before any text streams into it: a delta carries no lane of its own.
        ctx.publish();
      }
      target.text += text;
      const at = parts.indexOf(target as MessagePart);
      // Some models write their reasoning into the answer and end it with "</think>": that part is reasoning.
      const close = kind === "text" ? target.text.indexOf(THINK_END) : -1;
      if (close !== -1) {
        const thought = target.text
          .slice(0, close)
          .replace(/^\s*<think>/, "")
          .trim();
        target.text = target.text.slice(close + THINK_END.length).trimStart();
        if (thought) parts.splice(at, 0, { type: "reasoning", lane, text: thought });
        ctx.publish();
        return;
      }
      ctx.delta(at, kind, text);
    };

    const sink: TurnSink = {
      text: (text) => {
        reasoningFrom = null;
        ctx.working();
        if (ctx.alive()) append("text", text);
      },
      reasoning: (text) => {
        if (!reasoningFrom) {
          const last = lastOfLane();
          reasoningFrom =
            last?.type === "reasoning" ? { part: last, length: last.text.length } : { part: null, length: 0 };
        }
        if (!ctx.alive()) return;
        append("reasoning", text);
        reasoningFrom.part ??= lastOfLane() ?? null;
      },
      // The attempt that streamed it failed and is retried: drop it so it isn't read twice.
      discardReasoning: () => {
        if (!reasoningFrom) return;
        const { part, length } = reasoningFrom;
        reasoningFrom = null;
        if (part?.type === "reasoning") {
          if (length > 0) part.text = part.text.slice(0, length);
          else if (parts.includes(part)) parts.splice(parts.indexOf(part), 1);
        }
        ctx.publish();
      },
      toolStart: (call) => {
        reasoningFrom = null;
        push({
          type: "tool",
          lane,
          callId: `${prefix}${call.id}`,
          name: call.name,
          args:
            call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
              ? (call.arguments as Record<string, unknown>)
              : { value: call.arguments },
          status: "running",
          ...(call.signature ? { signature: call.signature } : {}),
        });
        ctx.working();
        ctx.publish();
      },
      toolEnd: (callId, outcome) => {
        reasoningFrom = null;
        const part = parts.find((p) => p.type === "tool" && p.callId === `${prefix}${callId}`);
        if (part?.type === "tool") {
          part.status = outcome.status;
          part.result = (whole.get(callId) ?? outcome.result).slice(0, 20_000);
          delete part.approval;
        }
        ctx.publish();
      },
    };

    try {
      const result = await runTurn({
        provider: ctx.provider,
        model: ctx.model,
        capabilities: ctx.capabilities,
        system: ctx.system,
        history: withNote(
          ctx.history,
          ctx.tools
            ? laneNote({ index: lane, ...role, tools: definitions.map((d) => d.name), steps: ctx.steps })
            : plainLaneNote({ index: lane, ...role }),
        ),
        contextWindow: ctx.contextWindow,
        tools,
        maxSteps: ctx.steps,
        stepLimitNote: false,
        selfCheck: false,
        think: ctx.think,
        local: ctx.local,
        signal: own.signal,
        sink,
      });
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
    } catch (error) {
      // Stop ends the whole turn; any other failure is this lane's alone.
      if (signal.aborted || (error instanceof ProviderError && error.code === "aborted")) return;
      failed.add(lane);
      const text = (error as Error).message;
      parts.push({
        type: "error",
        lane,
        code: error instanceof ProviderError ? error.code : "unknown",
        message: ctx.scrub ? ctx.scrub(text) : text,
      });
      if (!(error instanceof ProviderError)) console.error("[turns] a role failed", error);
    } finally {
      signal.removeEventListener("abort", stop);
      // This role is over, whichever way it ended: its heading says so.
      const header = headers[index];
      if (header?.type === "text") header.laneDone = true;
      for (const part of parts)
        if (
          part.type === "tool" &&
          part.lane === lane &&
          (part.status === "running" || part.status === "pending_approval")
        ) {
          part.status = "error";
          part.result = "Stopped before it finished.";
        }
      if (ctx.alive()) ctx.publish();
    }
  };

  await Promise.allSettled(roles.map((role, i) => runOne(i + 1, role)));
  if (signal.aborted) throw new ProviderError("aborted", "Stopped.");

  // Each lane's links are checked against its own pages only: it can't cite what another lane opened. Without tools
  // there are no pages to check against (as in the one-request mode), so an address from memory stays.
  for (const part of parts) {
    if (part.type !== "text" || !part.lane || headers.includes(part)) continue;
    const own = parts.filter((other) => "lane" in other && other.lane === part.lane);
    part.text = (
      ctx.tools ? keepKnownLinks(part.text, laneKnownLinks(own, ctx.question)) : part.text
    ).trimStart();
  }
  ctx.publish();

  return { usage, allFailed: [1, 2, 3].every((lane) => failed.has(lane) || !hasAnswer(lane)) };
}

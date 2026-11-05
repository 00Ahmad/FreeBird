import {
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type StreamChunk,
  type ToolCall,
  type ToolDef,
} from "@mrog/providers";
import type { ModelCapability, ToolStatus, Usage } from "@mrog/shared";

import { dropOldPictures, shrinkOldResults } from "./budget";
import { estimateToolTokens, fitHistory, withoutPictures, writeToolUse } from "./history";
import { FenceFilter, parseToolCalls, reactInstructions, startsToolCall } from "./react";

export interface ToolOutcome {
  status: Extract<ToolStatus, "done" | "error" | "denied">;
  result: string;
  /** Pictures that came with the result (screenshots), passed on to models that can see. */
  images?: { mediaType: string; data: string }[];
}

/** Where the engine gets tools. Approval, sandboxing and execution all live behind `execute`. */
export interface ToolHost {
  definitions(): ToolDef[];
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
}

/** How a running turn reports progress (the harness turns these into message parts and events). */
export interface TurnSink {
  text(delta: string): void;
  reasoning(delta: string): void;
  /** The reasoning shown since the step began came from an attempt that failed and is being retried. */
  discardReasoning?(): void;
  toolStart(call: ToolCall): void;
  toolEnd(callId: string, outcome: ToolOutcome): void;
}

export interface RunTurnOptions {
  provider: ChatProvider;
  model: string;
  capabilities: ModelCapability[];
  system: string;
  /** Conversation so far, ending with the newest user message. */
  history: ChatMessage[];
  contextWindow: number;
  tools?: ToolHost;
  maxSteps?: number;
  /** Add the "Stopped after N steps" note when the steps run out (default true). */
  stepLimitNote?: boolean;
  think?: boolean;
  local?: { numCtx: number; keepAlive: string };
  signal: AbortSignal;
  sink: TurnSink;
  /** Messages the user sent while this turn ran; folded in between steps. */
  steer?: () => ChatMessage[];
  /** Check the answer against the request once before finishing, when the task took several tool calls. */
  selfCheck?: boolean;
}

export interface TurnResult {
  usage: Usage;
  finishReason: string | null;
  steps: number;
  droppedHistory: number;
}

/** A reply whose last sentence says what the model is about to do, cut off before it did it. */
export const announcesMove = (text: string) =>
  /\b(I'll|I will|I'm going to|let me|next,? I|now I)\b[^.!?]*$/i.test(text.trim());

const CONTINUE_NUDGE: ChatMessage = {
  role: "user",
  content:
    "(You stopped without replying. If the request isn't finished, continue with your tools; otherwise tell me the result.)",
};

const NO_TOOLS_NUDGE: ChatMessage = {
  role: "user",
  content: "(Your last tool call could not be read. Answer in plain text without calling tools.)",
};

const BROKEN_CALL_NUDGE: ChatMessage = {
  role: "user",
  content:
    "(Your tool call was cut off or couldn't be read. Write it again, complete and on its own, or answer without tools.)",
};

const OUT_OF_STEPS_NUDGE: ChatMessage = {
  role: "user",
  content:
    "(You've used all your steps for this turn. Don't call any more tools. Reply now with what you found so far, as complete as you can, and say plainly what is still missing or didn't work.)",
};

const SELF_CHECK_NUDGE: ChatMessage = {
  role: "user",
  content:
    "(Before you finish, check your answer against my request. Did you do every part of it? Is every fact and number from a page or tool result you actually saw, with its source? If something is missing or wrong, fix it now with your tools, then give only the corrections or additions. If the answer is complete and correct, reply with just: OK)",
};

const NO_PROGRESS_NUDGE: ChatMessage = {
  role: "user",
  content:
    "(You've made the same tool call with the same result several times in a row, so it is not getting anywhere. Don't call it again. Reply now with what you found so far, say plainly what didn't work, and suggest a different approach if there is one.)",
};

/** The same call (same arguments) with the same outcome this many times in a row ends the turn. */
export const NO_PROGRESS_REPEATS = 3;

/** FNV-1a over a string, sampling long ones (pictures) so a repeat check never costs a pass over megabytes. */
function fingerprint(text: string): string {
  const stride = Math.max(1, Math.floor(text.length / 4096));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += stride) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** Same value, same text: object keys in any order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * What one tool call did, for noticing a bot that keeps doing the same thing. The result counts, not only the call:
 * scrolling or looking at a page repeats the same arguments on purpose, and what comes back is what tells them apart
 * (pictures included).
 */
export function callSignature(call: ToolCall, outcome: ToolOutcome): string {
  const pictures = (outcome.images ?? []).map((image) => fingerprint(image.data)).join(",");
  return [call.name, stable(call.arguments), outcome.status, fingerprint(outcome.result), pictures].join("|");
}

/** Tool calls a task needs before its answer is worth a self-check. */
const SELF_CHECK_MIN_CALLS = 3;

/** "OK" (or nothing at all) in reply to the self-check: the answer stands. */
const isOk = (reply: string) => /^\W*(ok\W*)?$/i.test(reply.trim());

/** How many times a step whose written tool call can't be read is retried before the text is shown as is. */
const BROKEN_CALL_RETRIES = 2;

/** Screenshots kept in the conversation; older ones are replaced by a note. */
const KEEP_PICTURES = 2;

/** Room kept free for the reply itself. */
const REPLY_RESERVE = 1024;

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { provider, model, capabilities, signal, sink, tools } = options;
  const maxSteps = options.maxSteps ?? 12;
  const toolDefs = tools?.definitions() ?? [];
  const nativeTools = toolDefs.length > 0 && capabilities.includes("tools");
  const textTools = toolDefs.length > 0 && !nativeTools;
  const vision = capabilities.includes("vision");

  const system = textTools ? `${options.system}\n\n${reactInstructions(toolDefs)}` : options.system;
  const toolTokens = nativeTools ? estimateToolTokens(toolDefs) : 0;
  const budget = Math.max(
    512,
    options.contextWindow - Math.ceil(system.length / 3.5) - toolTokens - REPLY_RESERVE,
  );
  let history = options.history;
  // Pictures the user attached earlier would be re-sent every turn to a model that can't see them.
  if (!vision) history = withoutPictures(history);
  // A model without native tools reads earlier tool use only in the written form it uses itself.
  if (!capabilities.includes("tools")) history = writeToolUse(history);
  const fitted = fitHistory(history, budget);
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...fitted.messages];
  // Everything sent each step (system prompt included) must fit beside the tool definitions and the reply.
  const room = Math.max(1024, options.contextWindow - REPLY_RESERVE - toolTokens);

  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let usedTools = false;
  let nudged = false;
  let brokenCalls = 0;
  let toolCalls = 0;
  let checked = false;
  /** The step whose reply answers the self-check. */
  let checkStep = 0;
  let finishReason: string | null = null;
  const think = capabilities.includes("thinking") ? options.think : undefined;
  /** The last tool call's signature and how many calls in a row had it. */
  let lastSignature = "";
  let repeats = 0;
  /** The step on which the bot was found going round in circles. */
  let stuckAt = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) throw new ProviderError("aborted", "Stopped.");
    dropOldPictures(messages, KEEP_PICTURES);
    shrinkOldResults(messages, room);
    let text = "";
    const calls: ToolCall[] = [];
    const thinking: Record<string, unknown>[] = [];
    // Any model may write a tool call as text (it's the only way for models without native tools), so hide
    // such blocks from the chat whenever tools are on offer.
    const filter = toolDefs.length > 0 ? new FenceFilter() : null;
    let shown = "";
    // The self-check reply is held back: a plain "OK" is never shown, anything else is.
    const checking = checked && step === checkStep;
    let held = "";
    const out = (delta: string) => {
      if (checking) held += delta;
      else sink.text(delta);
    };

    // A model sometimes writes a tool call the runtime can't parse. Retry the step once as-is, then once
    // without tools so it answers in plain text, before giving up.
    let attempt = 0;
    let reasoned = false;
    const stream = async function* (): AsyncIterable<StreamChunk> {
      for (;;) {
        const withTools = nativeTools && attempt < 2;
        try {
          yield* provider.chat({
            model,
            messages: withTools || !nativeTools ? messages : [...messages, NO_TOOLS_NUDGE],
            tools: withTools ? toolDefs : undefined,
            think,
            local: options.local,
            signal,
          });
          return;
        } catch (error) {
          const retryable =
            error instanceof ProviderError && error.code === "bad_output" && !text && calls.length === 0;
          if (!retryable || attempt >= (nativeTools ? 2 : 1)) throw error;
          attempt += 1;
          // The failed attempt's thinking belongs to a reply that never happened: don't send it back with the
          // retry's tool calls, and let the chat drop the reasoning it already showed.
          thinking.length = 0;
          if (reasoned) sink.discardReasoning?.();
          reasoned = false;
        }
      }
    };

    for await (const chunk of stream()) {
      if (chunk.type === "text") {
        text += chunk.text;
        const visible = filter ? filter.push(chunk.text) : chunk.text;
        if (visible) {
          shown += visible;
          out(visible);
        }
      } else if (chunk.type === "reasoning") {
        reasoned = true;
        sink.reasoning(chunk.text);
      } else if (chunk.type === "tool_call") {
        calls.push(chunk.call);
      } else if (chunk.type === "thinking_block") {
        thinking.push(chunk.block);
      } else {
        finishReason = chunk.finishReason;
        if (chunk.usage) {
          usage.inputTokens += chunk.usage.inputTokens;
          usage.outputTokens += chunk.usage.outputTokens;
        }
      }
    }
    let spoken = text;
    if (filter) {
      const rest = filter.flush();
      if (rest) {
        shown += rest;
        out(rest);
      }
      if (calls.length === 0) {
        const written = parseToolCalls(text);
        if (written.calls.length > 0) {
          calls.push(...written.calls);
          spoken = written.cleaned;
        } else if (shown.length < text.length) {
          // A tool call was started but can't be read (usually cut off mid-way): ask for it again rather than
          // ending the turn with half a call as the answer. If it keeps happening, show what was held back.
          if (
            brokenCalls < BROKEN_CALL_RETRIES &&
            step < maxSteps &&
            startsToolCall(text.slice(shown.length))
          ) {
            brokenCalls += 1;
            if (checking) checkStep = step + 1;
            messages.push({ role: "assistant", content: text }, BROKEN_CALL_NUDGE);
            continue;
          }
          out(text.slice(shown.length));
        }
      }
    }

    if (checking) {
      // "OK" means the answer stands. Corrections are shown under a heading; work continues normally.
      if (calls.length === 0 && isOk(held)) {
        return { usage, finishReason, steps: step, droppedHistory: fitted.dropped };
      }
      if (held.trim()) sink.text(calls.length === 0 ? `\n\n**After checking:** ${held.trim()}` : held);
    }

    if (calls.length === 0 || !tools) {
      // On the last step a new message is left waiting rather than answered with the out-of-steps reply: the turn
      // ends normally and the caller starts a fresh one for whatever is still unread.
      const steered = step < maxSteps ? (options.steer?.() ?? []) : [];
      if (
        steered.length === 0 &&
        options.selfCheck &&
        tools &&
        !checked &&
        text.trim() &&
        toolCalls >= SELF_CHECK_MIN_CALLS &&
        step < maxSteps
      ) {
        checked = true;
        checkStep = step + 1;
        messages.push({ role: "assistant", content: text }, SELF_CHECK_NUDGE);
        continue;
      }
      // Small models sometimes go quiet right after using tools, or announce their next move ("I'll click…") and
      // stop there; ask once to carry on instead of ending the turn.
      if (
        steered.length === 0 &&
        usedTools &&
        !nudged &&
        tools &&
        step < maxSteps &&
        (!text.trim() || announcesMove(text))
      ) {
        nudged = true;
        messages.push({ role: "assistant", content: text }, CONTINUE_NUDGE);
        continue;
      }
      if (steered.length === 0) return { usage, finishReason, steps: step, droppedHistory: fitted.dropped };
      messages.push({ role: "assistant", content: text }, ...steered);
      continue;
    }
    usedTools = true;
    toolCalls += calls.length;

    // A model without native tools wrote its calls as text: keep that text, since such models can't read toolCalls
    // and OpenAI-style APIs reject toolCalls that aren't followed by tool messages.
    messages.push(
      textTools
        ? { role: "assistant", content: text }
        : {
            role: "assistant",
            content: spoken,
            toolCalls: calls,
            ...(thinking.length > 0 ? { thinking } : {}),
          },
    );
    // Tool results must directly follow the call that asked for them (OpenAI and Anthropic reject anything in
    // between), so pictures from a batch of calls go after its last result.
    const pictures: ChatMessage[] = [];
    for (const call of calls) {
      // Stop also stops the calls still waiting in this batch.
      if (signal.aborted) throw new ProviderError("aborted", "Stopped.");
      sink.toolStart(call);
      let outcome: ToolOutcome;
      try {
        outcome = await tools.execute(call, signal);
      } catch (error) {
        if (signal.aborted) throw new ProviderError("aborted", "Stopped.");
        outcome = { status: "error", result: `Tool failed: ${(error as Error).message}` };
      }
      sink.toolEnd(call.id, outcome);
      const signature = callSignature(call, outcome);
      repeats = signature === lastSignature ? repeats + 1 : 1;
      lastSignature = signature;
      if (repeats >= NO_PROGRESS_REPEATS && !stuckAt) stuckAt = step;
      // The host says why a call wasn't run (the user said no, or nobody answered in time): those are different
      // facts for the bot. Only a host that gave no reason gets the usual refusal.
      let content =
        outcome.status === "denied"
          ? outcome.result.trim() || "The user denied this action. Do not retry it."
          : outcome.result;
      const images = outcome.images ?? [];
      if (images.length > 0 && !vision) {
        content += "\n(A picture came with this result, but this model can't see pictures. Use text tools.)";
      }
      if (textTools) {
        messages.push({
          role: "user",
          content: `Result of ${call.name}:\n${content}`,
          ...(vision && images.length > 0 ? { images } : {}),
        });
      } else {
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
        // Not every API takes pictures in tool messages; send them after the results, as the user's.
        if (vision && images.length > 0) {
          pictures.push({ role: "user", content: `(Picture from ${call.name})`, images });
        }
      }
    }
    messages.push(...pictures);
    // Going round in circles ends the turn here, after the whole batch has its results (APIs reject a tool call
    // that has none). Like running out of steps, a message sent meanwhile waits for a fresh turn.
    if (stuckAt) break;
    // After the last step only the out-of-steps reply is left; a new message waits for a fresh turn instead.
    if (step < maxSteps) messages.push(...(options.steer?.() ?? []));
  }

  // Out of steps, or stuck repeating itself: one last call without tools, so the turn ends with what was found
  // instead of nothing.
  if (!signal.aborted) {
    shrinkOldResults(messages, room - 200);
    try {
      const filter = toolDefs.length > 0 ? new FenceFilter() : null;
      sink.text("\n\n");
      for await (const chunk of provider.chat({
        model,
        messages: [...messages, stuckAt ? NO_PROGRESS_NUDGE : OUT_OF_STEPS_NUDGE],
        think,
        local: options.local,
        signal,
      })) {
        if (chunk.type === "text") {
          const visible = filter ? filter.push(chunk.text) : chunk.text;
          if (visible) sink.text(visible);
        } else if (chunk.type === "reasoning") sink.reasoning(chunk.text);
        else if (chunk.type === "done" && chunk.usage) {
          usage.inputTokens += chunk.usage.inputTokens;
          usage.outputTokens += chunk.usage.outputTokens;
        }
      }
      if (filter) sink.text(filter.flush());
    } catch {
      if (signal.aborted) throw new ProviderError("aborted", "Stopped.");
      // The summary is a courtesy; the note below still explains why the turn ended.
    }
  }
  if (stuckAt) {
    if (options.stepLimitNote !== false)
      sink.text(
        `\n\n_Stopped: the same step gave the same result ${NO_PROGRESS_REPEATS} times in a row. Ask me to continue, or tell me what to try differently._`,
      );
    return { usage, finishReason: "no_progress", steps: stuckAt, droppedHistory: fitted.dropped };
  }
  if (options.stepLimitNote !== false)
    sink.text(`\n\n_Stopped after ${maxSteps} steps. Ask me to continue if there's more to do._`);
  return { usage, finishReason: "max_steps", steps: maxSteps, droppedHistory: fitted.dropped };
}

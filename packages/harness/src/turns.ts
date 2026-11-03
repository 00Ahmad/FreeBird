import {
  askWith,
  compactHistory,
  estimateToolTokens,
  runTurn,
  summarizeWith,
  toChatHistory,
  type CompactCache,
  type ToolHost,
  type ToolOutcome,
  type TurnSink,
} from "@mrog/engine";
import type { ModelRuntime, Priority } from "@mrog/model-runtime";
import { ProviderError, type ChatMessage, type ChatProvider, type ProviderRegistry } from "@mrog/providers";
import {
  messageText,
  type Bot,
  type Message,
  type MessagePart,
  type SendMessageInput,
  type Thread,
  type ThreadActivity,
} from "@mrog/shared";
import type { Store } from "@mrog/store";

import type { EventBus } from "./bus";
import type { ModelCatalog } from "./catalog";
import { buildSystemPrompt } from "./prompt";

/** Where a delegated helper's cards (approvals, questions, secrets) show: the coordinator's message. */
export interface Surface {
  threadId: string;
  messageId: string;
  /** The coordinator, shown as working while it waits. */
  botId: string;
}

/** How a turn was started. */
export interface TurnInfo {
  /** Working on a task another bot handed over: no delegation tools, so chains can't form. */
  delegated: boolean;
  surface?: Surface;
}

interface TurnOptions {
  /** Stops this turn when the turn that started it stops. */
  parentSignal?: AbortSignal;
  delegated?: boolean;
  surface?: Surface;
}

/** Supplies per-turn tools and prompt additions (Phase 2+); the chat MVP runs without any. */
interface TurnExtensions {
  tools?(
    bot: Bot,
    thread: Thread,
    messageId: string,
    signal: AbortSignal,
    info: TurnInfo,
  ): ToolHost | undefined;
  promptExtras?(bot: Bot, thread: Thread, info: TurnInfo): { memory?: string[]; extra?: string[] };
  /** Group chats: which bots answer a user message. */
  responders?(thread: Thread, message: Message): Promise<Bot[]>;
  /** How long a turn may run and whether it checks its answer (Settings → General). */
  turnOptions?(
    bot: Bot,
    thread: Thread,
    info: TurnInfo,
  ): { maxSteps?: number; selfCheck?: boolean; think?: boolean; stepLimitNote?: boolean };
  /** Waits for what a local model needs first, e.g. Ollama that is still starting. */
  beforeModel?(): Promise<void>;
  /** After any turn ends (e.g. to tidy up the helpers a coordinator made). */
  onTurnEnd?(thread: Thread, bot: Bot, message: Message, info: TurnInfo): void;
  /**
   * Before the model starts: a note added to the newest user message for this turn only (e.g. a coordinator's plan
   * to hand parts of the job to helpers). `ask` puts one short question to the turn's own model.
   */
  beforeTurn?(context: {
    bot: Bot;
    thread: Thread;
    info: TurnInfo;
    latest: Message | undefined;
    tools: string[];
    ask(system: string, user: string): Promise<string>;
  }): Promise<string | null>;
}

interface ActiveTurn {
  controller: AbortController;
  botId: string;
  steer: ChatMessage[];
  info: TurnInfo;
  /** How it was started, so a follow-up turn for a late message runs the same way. */
  options: TurnOptions;
  /** Settles when the turn has finished (however it ended). */
  done: Promise<void>;
  /** The user's next turn, queued while this stopped one winds down; more messages join it. */
  next?: Promise<Message>;
}

const logStartFailure = (error: unknown) => console.error("[turns] a turn failed to run", error);

/** Tool arguments as a plain object: models sometimes send an array or a bare value. */
const asArgs = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };

/** A user message as the model reads it, pictures included. */
function toChatMessage(message: Message): ChatMessage {
  const images = message.parts.flatMap((part) =>
    part.type === "image" ? [{ mediaType: part.mediaType, data: part.data }] : [],
  );
  return { role: "user", content: messageText(message), ...(images.length > 0 ? { images } : {}) };
}

const SAVE_EVERY_MS = 750;
const THINK_END = "</think>";
/** How long preparing a turn (one short question to the model) may take before the turn starts without it. */
const BEFORE_TURN_TIMEOUT_MS = 45_000;

/** The history with a note added to its newest user message (or as one, when the newest message isn't the user's). */
function withNote(history: ChatMessage[], note: string): ChatMessage[] {
  const last = history.at(-1);
  if (last?.role !== "user") return [...history, { role: "user", content: note }];
  return [...history.slice(0, -1), { ...last, content: `${last.content}\n\n${note}` }];
}

export class TurnManager {
  /** Keyed by `${threadId}:${botId}` so several bots can work in one group thread. */
  private readonly active = new Map<string, ActiveTurn>();
  private readonly activity = new Map<string, { botId: string | null; activity: ThreadActivity }>();
  /** Counts Stops (and Clear chat, delete) per thread, so a group's round of answers ends with the first. */
  private readonly stops = new Map<string, number>();
  extensions: TurnExtensions = {};

  constructor(
    private readonly deps: {
      store: Store;
      bus: EventBus;
      runtime: ModelRuntime;
      registry: ProviderRegistry;
      catalog: ModelCatalog;
    },
  ) {}

  activities(): Record<string, { botId: string | null; activity: ThreadActivity }> {
    return Object.fromEntries(this.activity);
  }

  isRunning(threadId: string, botId: string): boolean {
    return this.active.has(`${threadId}:${botId}`);
  }

  isBusy(threadId: string): boolean {
    return [...this.active.keys()].some((key) => key.startsWith(`${threadId}:`));
  }

  setActivity(threadId: string, botId: string | null, activity: ThreadActivity) {
    if (activity === "idle") this.activity.delete(threadId);
    else this.activity.set(threadId, { botId, activity });
    this.deps.bus.publish({ type: "thread.activity", threadId, botId, activity });
  }

  /** Saves the user's message and starts (or steers) the bots that should answer. */
  async send(thread: Thread, input: SendMessageInput): Promise<Message> {
    const { store, bus } = this.deps;
    const parts: MessagePart[] = [];
    if (input.text) parts.push({ type: "text", text: input.text });
    for (const image of input.images ?? []) parts.push({ type: "image", ...image });
    const message = store.messages.create({
      threadId: thread.id,
      role: "user",
      parts,
      replyToId: input.replyToId,
    });
    bus.publish({ type: "message.created", message });

    if (thread.kind === "group") {
      const stops = this.stops.get(thread.id) ?? 0;
      const stopped = () => (this.stops.get(thread.id) ?? 0) !== stops;
      // Picking who answers can wait on the shared model, so it happens after the message is saved and shown.
      void (async () => {
        const responders = (await this.extensions.responders?.(thread, message)) ?? [];
        if (stopped()) return;
        // One after another, so each bot sees what the previous one said. Stop or Clear chat ends the round.
        for (const bot of this.steerOrFresh(thread, message, responders)) {
          if (stopped()) break;
          await this.start(thread, bot, "user").catch(() => {});
        }
      })().catch(logStartFailure);
    } else {
      const members = thread.memberIds.flatMap((id) => store.bots.get(id) ?? []);
      for (const bot of this.steerOrFresh(thread, message, members))
        this.start(thread, bot, "user").catch(logStartFailure);
    }
    return message;
  }

  /** Hands the message to responders that are mid-turn; returns the ones that need a new turn. */
  private steerOrFresh(thread: Thread, message: Message, responders: Bot[]): Bot[] {
    const fresh: Bot[] = [];
    for (const bot of responders) {
      const running = this.active.get(`${thread.id}:${bot.id}`);
      // A bot that's mid-turn gets the new message between steps instead of starting over. A turn that was
      // stopped never reads it, so the message starts a new turn (which waits for the stopped one to end).
      if (running && !running.controller.signal.aborted) {
        running.steer.push(toChatMessage(message));
      } else fresh.push(bot);
    }
    return fresh;
  }

  stop(threadId: string): boolean {
    this.stops.set(threadId, (this.stops.get(threadId) ?? 0) + 1);
    let stopped = false;
    for (const [key, turn] of this.active) {
      if (key.startsWith(`${threadId}:`)) {
        turn.controller.abort();
        stopped = true;
      }
    }
    return stopped;
  }

  stopBot(botId: string): void {
    for (const turn of this.active.values()) if (turn.botId === botId) turn.controller.abort();
  }

  stopAll(): void {
    for (const turn of this.active.values()) turn.controller.abort();
  }

  /** Runs one bot's turn in a thread; resolves when it finishes, fails or is stopped. */
  start(thread: Thread, bot: Bot, priority: Priority = "user", options: TurnOptions = {}): Promise<Message> {
    const key = `${thread.id}:${bot.id}`;
    // One turn per bot per thread: a second one (a routine firing mid-reply, a message after Stop) waits its turn.
    const existing = this.active.get(key);
    if (existing) {
      // Every message sent while a stopped turn winds down is answered by one new turn, not one turn each.
      const joins = priority === "user" && !options.delegated && existing.controller.signal.aborted;
      if (joins && existing.next) return existing.next;
      const next = existing.done.then(() => this.start(thread, bot, priority, options));
      if (joins) existing.next = next;
      return next;
    }
    const info: TurnInfo = { delegated: options.delegated ?? false, surface: options.surface };
    const turn: ActiveTurn = {
      controller: new AbortController(),
      botId: bot.id,
      steer: [],
      info,
      options,
      done: Promise.resolve(),
    };
    const stopWithParent = () => turn.controller.abort();
    if (options.parentSignal?.aborted) turn.controller.abort();
    options.parentSignal?.addEventListener("abort", stopWithParent, { once: true });
    this.active.set(key, turn);
    const running = this.run(thread, bot, turn, priority)
      .then((message) => {
        try {
          this.extensions.onTurnEnd?.(thread, bot, message, info);
        } catch (error) {
          console.error("[turns] onTurnEnd failed", error);
        }
        return message;
      })
      .finally(() => {
        options.parentSignal?.removeEventListener("abort", stopWithParent);
        if (this.active.get(key) === turn) this.active.delete(key);
        if (!this.isBusy(thread.id)) this.setActivity(thread.id, null, "idle");
        // A message that arrived after the bot's last step still deserves an answer, given the same way.
        if (turn.steer.length > 0 && !turn.controller.signal.aborted && !options.parentSignal?.aborted) {
          const fresh = this.deps.store.bots.get(bot.id);
          if (fresh) this.start(thread, fresh, priority, options).catch(logStartFailure);
        }
      });
    turn.done = running.then(
      () => {},
      () => {},
    );
    return running;
  }

  /**
   * The local provider with each request holding a slot on the shared model only while it streams. A turn
   * waiting for the user (an approval, a question, a secret) or for its helpers holds no slot, so it never keeps
   * other bots, routines or helpers off the model.
   */
  private withSlot(
    provider: ChatProvider,
    priority: Priority,
    threadId: string,
    botId: string,
  ): ChatProvider {
    const { runtime } = this.deps;
    const acquire = async (signal?: AbortSignal) => {
      let queued = false;
      let before: ThreadActivity | undefined;
      const release = await runtime.acquire(priority, {
        signal,
        onQueued: () => {
          queued = true;
          before = this.activity.get(threadId)?.activity;
          this.setActivity(threadId, botId, "queued");
        },
      });
      // Back to what the chat showed before the wait.
      if (queued) this.setActivity(threadId, botId, before && before !== "queued" ? before : "thinking");
      return release;
    };
    return {
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      local: provider.local,
      listModels: (signal) => provider.listModels(signal),
      async *chat(request) {
        const release = await acquire(request.signal);
        try {
          yield* provider.chat(request);
        } finally {
          release();
        }
      },
    };
  }

  private async run(thread: Thread, bot: Bot, turn: ActiveTurn, priority: Priority): Promise<Message> {
    const { store, bus, runtime, registry, catalog } = this.deps;
    const signal = turn.controller.signal;
    const ref = bot.model ?? runtime.settings.sharedModel;

    let message = store.messages.create({
      threadId: thread.id,
      role: "bot",
      botId: bot.id,
      parts: [],
      status: "streaming",
      model: ref,
    });
    bus.publish({ type: "message.created", message });
    this.setActivity(thread.id, bot.id, "thinking");

    const parts: MessagePart[] = [];
    // False once the row is gone ("Clear chat" mid-turn): nothing more is saved or shown, so it can't reappear.
    let exists = true;
    const persist = (patch: Parameters<Store["messages"]["update"]>[1]) => {
      if (!exists) return;
      const saved = store.messages.update(message.id, patch);
      if (saved) message = saved;
      else exists = false;
    };
    let dirty = false;
    const save = () => {
      if (!dirty) return;
      dirty = false;
      persist({ parts: structuredClone(parts) });
    };
    const saver = setInterval(save, SAVE_EVERY_MS);
    const publishFull = () => {
      dirty = true;
      save();
      if (exists) bus.publish({ type: "message.updated", message });
    };

    const appendDelta = (kind: "text" | "reasoning", text: string) => {
      const last = parts.at(-1);
      let target: { type: "text" | "reasoning"; text: string };
      if (last && (last.type === "text" || last.type === "reasoning") && last.type === kind) {
        target = last;
      } else {
        target = { type: kind, text: "" };
        parts.push(target as MessagePart);
      }
      target.text += text;
      dirty = true;
      // Some models write their reasoning into the answer and end it with "</think>": that part is reasoning.
      // Only the new text (and a tag split across chunks) can hold it, so only the tail is searched.
      const from = Math.max(0, target.text.length - text.length - THINK_END.length + 1);
      const close =
        kind === "text" && target.text.includes(THINK_END, from) ? target.text.lastIndexOf(THINK_END) : -1;
      if (close !== -1) {
        const thought = target.text
          .slice(0, close)
          .replace(/^\s*<think>/, "")
          .trim();
        target.text = target.text.slice(close + THINK_END.length).trimStart();
        if (thought)
          parts.splice(parts.indexOf(target as MessagePart), 0, { type: "reasoning", text: thought });
        publishFull();
        return;
      }
      if (!exists) return;
      bus.publish({
        type: "message.delta",
        threadId: thread.id,
        messageId: message.id,
        partIndex: parts.length - 1,
        kind,
        text,
      });
    };

    // Where the reasoning streamed since the last answer text or tool call starts, in case its attempt is retried.
    let reasoningFrom: { index: number; length: number } | null = null;
    const sink: TurnSink = {
      text: (text) => {
        reasoningFrom = null;
        this.setActivityOnce(thread.id, bot.id, "working");
        appendDelta("text", text);
      },
      reasoning: (text) => {
        if (!reasoningFrom) {
          const last = parts.at(-1);
          reasoningFrom =
            last?.type === "reasoning"
              ? { index: parts.length - 1, length: last.text.length }
              : { index: parts.length, length: 0 };
        }
        appendDelta("reasoning", text);
      },
      // The attempt that streamed it failed and is retried: drop it so the user doesn't read it twice.
      discardReasoning: () => {
        if (!reasoningFrom) return;
        const { index, length } = reasoningFrom;
        reasoningFrom = null;
        const part = parts[index];
        if (part?.type === "reasoning" && length > 0) {
          part.text = part.text.slice(0, length);
          parts.splice(index + 1);
        } else parts.splice(index);
        publishFull();
      },
      toolStart: (call) => {
        reasoningFrom = null;
        parts.push({
          type: "tool",
          callId: call.id,
          name: call.name,
          args: asArgs(call.arguments),
          status: "running",
        });
        this.setActivity(thread.id, bot.id, "working");
        publishFull();
      },
      toolEnd: (callId, outcome: ToolOutcome) => {
        reasoningFrom = null;
        const part = parts.find((p) => p.type === "tool" && p.callId === callId);
        if (part?.type === "tool") {
          part.status = outcome.status;
          part.result = outcome.result.slice(0, 20_000);
          delete part.approval;
        }
        publishFull();
      },
    };
    // Tools may change a part's status (approval cards) through this hook.
    this.partHooks.set(message.id, { parts, publish: publishFull });

    try {
      if (!ref) {
        throw new ProviderError(
          "model_missing",
          "No model is selected. Pick a shared model in Settings → Local model.",
        );
      }
      const resolved = registry.resolve(ref);
      const { model } = resolved;
      // Only a local model needs Ollama up; a cloud bot doesn't wait for it to start.
      if (resolved.provider.local) await this.extensions.beforeModel?.();
      const info = await catalog.info(ref);
      if (!info) throw new ProviderError("model_missing", `The model ${ref} is not available.`);
      const settings = runtime.settings;
      const local = resolved.provider.local ? runtime.localOptions() : undefined;
      const provider = resolved.provider.local
        ? this.withSlot(resolved.provider, priority, thread.id, bot.id)
        : resolved.provider;
      const contextWindow = provider.local
        ? Math.min(settings.numCtx, info.contextWindow ?? settings.numCtx)
        : (info.contextWindow ?? 32_768);

      const history = store.messages.list(thread.id, { limit: 400 }).filter((m) => m.id !== message.id);
      const names = new Map(store.bots.list().map((b) => [b.id, b.name]));
      const extras = this.extensions.promptExtras?.(bot, thread, turn.info) ?? {};
      const system = buildSystemPrompt(bot, {
        thread,
        teammates: thread.memberIds.filter((id) => id !== bot.id).flatMap((id) => store.bots.get(id) ?? []),
        now: new Date(),
        ...extras,
      });
      const host = this.extensions.tools?.(bot, thread, message.id, signal, turn.info);
      // The same definitions on every step, so they are built and measured once per turn.
      const definitions = host?.definitions() ?? [];
      const tools: ToolHost | undefined = host && {
        definitions: () => definitions,
        execute: (call, callSignal) => host.execute(call, callSignal),
      };

      // Fold old history into a cached summary when it no longer fits the context window.
      const toolTokens = estimateToolTokens(definitions);
      const budget = contextWindow - Math.ceil(system.length / 3.5) - toolTokens - 1024;
      const summaryKey = `summary:${thread.id}:${bot.id}`;
      const chatHistory = toChatHistory(history, bot.id, names);
      const compacted = await compactHistory(
        chatHistory,
        budget,
        (text) => summarizeWith(provider, model, text, { signal, local }),
        store.settings.get<CompactCache>(summaryKey),
      ).catch((error: unknown) => {
        // A failed summary shouldn't fail every turn from now on: the turn trims old history instead.
        if (signal.aborted) throw error;
        console.warn("[turns] summarizing history failed", error);
        return { messages: chatHistory, cache: undefined };
      });
      if (compacted.cache) store.settings.set(summaryKey, compacted.cache);
      const thinks = info.capabilities.includes("thinking");
      const note = await this.extensions
        .beforeTurn?.({
          bot,
          thread,
          info: turn.info,
          latest: history.at(-1),
          tools: definitions.map((definition) => definition.name),
          ask: (question, text) =>
            askWith(provider, model, question, text, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(BEFORE_TURN_TIMEOUT_MS)]),
              local,
              maxTokens: 300,
              ...(thinks ? { think: false } : {}),
            }),
        })
        .catch((error: unknown) => {
          if (signal.aborted) throw error;
          console.warn("[turns] preparing the turn failed", error);
          return null;
        });
      const result = await runTurn({
        provider,
        model,
        capabilities: info.capabilities,
        system,
        history: note ? withNote(compacted.messages, note) : compacted.messages,
        contextWindow,
        tools,
        think: settings.think,
        local,
        signal,
        sink,
        steer: () => turn.steer.splice(0),
        ...this.extensions.turnOptions?.(bot, thread, turn.info),
      });

      save();
      persist({ parts, status: "done", usage: result.usage });
    } catch (error) {
      const stopped = signal.aborted || (error instanceof ProviderError && error.code === "aborted");
      if (!stopped) {
        const code = error instanceof ProviderError ? error.code : "unknown";
        parts.push({ type: "error", code, message: (error as Error).message });
        if (!(error instanceof ProviderError)) console.error("[turns] turn failed", error);
      }
      for (const part of parts) {
        if (part.type === "tool" && (part.status === "running" || part.status === "pending_approval")) {
          part.status = "error";
          part.result = "Stopped before it finished.";
        }
        // Nobody can answer these any more.
        if (
          (part.type === "question" && part.answer === undefined) ||
          (part.type === "secret" && !part.saved)
        )
          part.expired = true;
      }
      persist({ parts, status: stopped ? "stopped" : "error" });
    } finally {
      clearInterval(saver);
      this.partHooks.delete(message.id);
      this.activityShown.delete(`${thread.id}:${bot.id}`);
    }
    if (exists) bus.publish({ type: "message.updated", message });
    return message;
  }

  /** Live parts of a streaming message, for tools that update their own card (approvals, questions). */
  readonly partHooks = new Map<string, { parts: MessagePart[]; publish(): void }>();

  private readonly activityShown = new Set<string>();
  private setActivityOnce(threadId: string, botId: string, activity: ThreadActivity) {
    const key = `${threadId}:${botId}`;
    if (this.activityShown.has(key)) return;
    this.activityShown.add(key);
    this.setActivity(threadId, botId, activity);
  }
}

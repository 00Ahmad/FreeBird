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
  parallelInstructions,
  parseModelRef,
  type Bot,
  type Message,
  type MessagePart,
  type SendMessageInput,
  type Thread,
  type ThreadActivity,
  type Usage,
} from "@mrog/shared";
import type { Store } from "@mrog/store";

import type { EventBus } from "./bus";
import type { ModelCatalog } from "./catalog";
import { forHistory, memoryWarning } from "./parallel-lanes";
import { runLanes, withNote } from "./parallel-run";
import { buildSystemPrompt } from "./prompt";
import { withWatchdog, type WatchdogLimits } from "./watchdog";

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
  /** Nobody is watching to answer an approval card (a racer): a call that needs one is refused at once. */
  unattended?: boolean;
  /** Parallel Bots with tools, one role's own run: only these tools are offered, and it has a browser tab of its own. */
  onlyTools?: string[];
  /** The role (1 to 3) this run is for. */
  lane?: number;
}

interface TurnOptions {
  /** Stops this turn when the turn that started it stops. */
  parentSignal?: AbortSignal;
  delegated?: boolean;
  surface?: Surface;
  /**
   * A message this turn answers again, because it failed or stalled: the new turn is built from the conversation
   * without it (it may hold half a reply, which a model would carry on or answer instead of the user).
   */
  retryOf?: string;
  /**
   * Keep a local model for the whole turn instead of one reply at a time: bots that never wait for the user (racers)
   * then finish one after another, and the model doesn't re-read each one's conversation (or swap models) between
   * steps.
   */
  wholeTurn?: boolean;
  /**
   * Works on its own with nobody to answer an approval card (racers, whose chats the user isn't looking at). A call
   * that would need one is refused instead of waiting for an answer that can't come, while this turn holds the model.
   */
  unattended?: boolean;
  /**
   * The turn answers only the newest message, not the conversation before it: a task that stands on its own (a Coding
   * Bot's roles get one card at a time), so the chat can grow without the turn's cost growing with it.
   */
  standalone?: boolean;
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
  ): {
    maxSteps?: number;
    selfCheck?: boolean;
    think?: boolean;
    stepLimitNote?: boolean;
    /**
     * Tell Ollama `think: false` even when its model list doesn't say the model thinks (some do, like MiMo v2.6, and
     * would otherwise spend most of a turn on it).
     */
    thinkOff?: boolean;
  };
  /** Waits for what a local model needs first, e.g. Ollama that is still starting. */
  beforeModel?(): Promise<void>;
  /** Takes the user's secret values out of text the turn saves that didn't come through the tool host (errors). */
  scrub?(text: string): string;
  /**
   * A message the user sent that something other than a model turn answers (a Coding Bot's chat goes to its project
   * service). True: no bot replies to it.
   */
  handles?(thread: Thread, message: Message): boolean;
  /** Why a bot never runs a model turn (it has no model: a Coding Bot), or null. Every way of starting a turn checks. */
  refuses?(bot: Bot): string | null;
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
  /** The reply it is writing; known once the turn has started. */
  messageId?: string;
  /** Answering a Parallel Bots message: one request with no tools, nothing steered in. */
  parallel: boolean;
  /** Parallel Bots with tools: the three roles each run on their own, with search and opening pages. */
  parallelTools: boolean;
  steer: ChatMessage[];
  info: TurnInfo;
  /** How it was started, so a follow-up turn for a late message runs the same way. */
  options: TurnOptions;
  /** Settles when the turn has finished (however it ended). */
  done: Promise<void>;
  /**
   * The user's next turn, queued while this one runs or winds down; every message sent meanwhile joins it. `stops` is
   * the thread's Stop count when it was queued: a Stop since then cancels it, so a later message needs a turn of its own.
   */
  next?: { turn: Promise<Message>; stops: number };
}

/** A queued turn that never started: Stop or Clear chat came first, or its bot or chat was deleted meanwhile. */
export class TurnCancelled extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TurnCancelled";
  }
}

const logStartFailure = (error: unknown) => {
  if (!(error instanceof TurnCancelled)) console.error("[turns] a turn failed to run", error);
};

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

/**
 * The conversation for a turn that answers again (`retryOf` is set), without this bot's unfinished replies to the
 * user's latest message. Not only the one being retried: a retry that itself failed leaves another half-written reply
 * behind, and the one before it is still there. Left in, the history would end on the bot's own words instead of the
 * user's message, and the model would carry on mid-sentence, or answer nothing. Finished replies, and other bots' replies in
 * a group, stay.
 */
export function withoutFailedReplies(
  messages: Message[],
  botId: string,
  retryOf: string | undefined,
): Message[] {
  if (!retryOf) return messages;
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  return messages.filter(
    (message, index) =>
      message.id !== retryOf &&
      !(index > lastUser && message.role === "bot" && message.botId === botId && message.status !== "done"),
  );
}

export class TurnManager {
  /** Keyed by `${threadId}:${botId}` so several bots can work in one group thread. */
  private readonly active = new Map<string, ActiveTurn>();
  private readonly activity = new Map<string, { botId: string | null; activity: ThreadActivity }>();
  /** Counts Stops (and Clear chat, delete) per thread, so a group's round of answers ends with the first. */
  private readonly stops = new Map<string, number>();
  extensions: TurnExtensions = {};
  /** How long preparing a turn may take, once the model is free (tests shorten it). */
  beforeTurnTimeoutMs = BEFORE_TURN_TIMEOUT_MS;
  /** How far apart Parallel Bots roles start (tests shorten it). */
  laneStaggerMs: number | undefined;

  constructor(
    private readonly deps: {
      store: Store;
      bus: EventBus;
      runtime: ModelRuntime;
      registry: ProviderRegistry;
      catalog: ModelCatalog;
      /** How long a model may stay silent before its request is ended (tests shorten it). */
      watchdog?: Partial<WatchdogLimits>;
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
      parallel: input.parallel === true,
      parallelTools: input.parallel === true && input.parallelTools === true,
    });
    bus.publish({ type: "message.created", message });
    if (this.extensions.handles?.(thread, message)) return message;

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
      // stopped never reads it, so the message starts a new turn (which waits for the stopped one to end). A
      // Parallel Bots message, or a turn answering one, takes no part in that: the reply is one request, and a
      // step that read another message would be a second one.
      if (running && !running.controller.signal.aborted && !message.parallel && !running.parallel) {
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

  /**
   * Answers the user again where `retryOf` failed, stalled or never got going. If that very reply is still being
   * written, it is stopped first (a restart); if the bot is busy with anything else, nothing starts. Clicking twice
   * gives one new turn, not two: the second joins the first.
   */
  retry(thread: Thread, bot: Bot, retryOf: string): { started: boolean } {
    const running = this.active.get(`${thread.id}:${bot.id}`);
    if (running && !running.controller.signal.aborted) {
      if (running.messageId !== retryOf) return { started: false };
      running.controller.abort();
    }
    this.start(thread, bot, "user", { retryOf }).catch(logStartFailure);
    return { started: true };
  }

  stopAll(): void {
    for (const turn of this.active.values()) turn.controller.abort();
  }

  /** Runs one bot's turn in a thread; resolves when it finishes, fails or is stopped. */
  start(thread: Thread, bot: Bot, priority: Priority = "user", options: TurnOptions = {}): Promise<Message> {
    const refused = this.extensions.refuses?.(bot);
    if (refused) return Promise.reject(new TurnCancelled(refused));
    const key = `${thread.id}:${bot.id}`;
    // One turn per bot per thread: a second one (a routine firing mid-reply, a message after Stop) waits its turn.
    const existing = this.active.get(key);
    if (existing) {
      // Every message sent while a turn is running or winding down is answered by one new turn, not one turn each:
      // it reads the whole conversation, so the first of them to start answers the rest too.
      const joins = priority === "user" && !options.delegated;
      const stops = this.stops.get(thread.id) ?? 0;
      if (joins && existing.next?.stops === stops) return existing.next.turn;
      const next = existing.done.then(() => {
        // Stop or Clear chat since it was queued ends it too: the user doesn't want it answered any more.
        if ((this.stops.get(thread.id) ?? 0) !== stops) throw new TurnCancelled("Stopped before it started.");
        // The bot and the chat as they are now: the user may have changed its tools or instructions while it waited.
        const freshBot = this.deps.store.bots.get(bot.id);
        const freshThread = this.deps.store.threads.get(thread.id);
        if (!freshBot || !freshThread) throw new TurnCancelled("The bot or its chat was deleted.");
        return this.start(freshThread, freshBot, priority, options);
      });
      if (joins) existing.next = { turn: next, stops };
      return next;
    }
    const info: TurnInfo = {
      delegated: options.delegated ?? false,
      surface: options.surface,
      ...(options.unattended ? { unattended: true } : {}),
    };
    // Only a turn answering the user's own message can be parallel: a routine or a handed-over task never answers it.
    const asked =
      priority === "user" && !options.delegated ? this.asksParallel(thread, bot, options.retryOf) : null;
    const turn: ActiveTurn = {
      controller: new AbortController(),
      botId: bot.id,
      // Only a turn answering the user's own message can be parallel: a routine or a handed-over task never answers it.
      parallel: asked !== null,
      parallelTools: asked?.parallelTools === true,
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
   * Whether the user's newest message asked for Parallel Bots and this bot hasn't answered it yet (a reply being
   * tried again doesn't count as an answer). Decided from the message rather than from how the turn started, so a
   * turn that waited, a retry and a model switch all answer it the same way. Only a reply of that kind answers it: a
   * routine that replied in between is not the answer.
   */
  private asksParallel(thread: Thread, bot: Bot, retryOf?: string): { parallelTools: boolean } | null {
    if (thread.kind === "group") return null;
    const recent = this.deps.store.messages.list(thread.id, { limit: 30 });
    const asked = recent.findLastIndex((message) => message.role === "user");
    if (asked === -1 || !recent[asked]!.parallel) return null;
    const answered = recent
      .slice(asked + 1)
      .some(
        (message) =>
          message.role === "bot" && message.botId === bot.id && message.parallel && message.id !== retryOf,
      );
    return answered ? null : { parallelTools: recent[asked]!.parallelTools };
  }

  /**
   * The local provider with each request holding a slot on the shared model only while it streams. A turn
   * waiting for the user (an approval, a question, a secret) or for its helpers holds no slot, so it never keeps
   * other bots, routines or helpers off the model.
   */
  /** Waits for a shared-model slot, showing "queued" in the chat meanwhile. */
  private async acquireSlot(
    priority: Priority,
    threadId: string,
    botId: string,
    signal?: AbortSignal,
  ): Promise<() => void> {
    let queued = false;
    let before: ThreadActivity | undefined;
    const release = await this.deps.runtime.acquire(priority, {
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
  }

  private withSlot(
    provider: ChatProvider,
    priority: Priority,
    threadId: string,
    botId: string,
  ): ChatProvider {
    const acquire = (signal?: AbortSignal) => this.acquireSlot(priority, threadId, botId, signal);
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
      parallel: turn.parallel,
      parallelTools: turn.parallelTools,
      parts: [],
      status: "streaming",
      model: ref,
    });
    bus.publish({ type: "message.created", message });
    turn.messageId = message.id;
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
    let releaseTurnSlot: (() => void) | undefined;

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
      // A Visual Bot only has screenshots to go by. Ollama says for sure what a model can do; other providers'
      // lists are guesses from the model's name, so those are let through rather than wrongly refused.
      if (bot.visual && !info.capabilities.includes("vision") && parseModelRef(ref).providerId === "ollama")
        throw new ProviderError(
          "needs_vision",
          `${bot.name} is a Visual Bot and works from screenshots, but ${resolved.model} can't see pictures. Pick a model that can, such as qwen3.5:9b.`,
        );
      const settings = runtime.settings;
      const local = resolved.provider.local ? runtime.localOptions() : undefined;
      if (resolved.provider.local && turn.options.wholeTurn)
        releaseTurnSlot = await this.acquireSlot(priority, thread.id, bot.id, signal);
      // Silence from the model ends its request with a "stalled" error. The watchdog sits inside the queue for the
      // shared model, so waiting for a slot never counts as silence.
      const guarded = withWatchdog(resolved.provider, this.deps.watchdog);
      const provider =
        resolved.provider.local && !releaseTurnSlot
          ? this.withSlot(guarded, priority, thread.id, bot.id)
          : guarded;
      const contextWindow = provider.local
        ? Math.min(settings.numCtx, info.contextWindow ?? settings.numCtx)
        : (info.contextWindow ?? 32_768);

      const earlier = withoutFailedReplies(
        store.messages.list(thread.id, { limit: 400 }).filter((m) => m.id !== message.id),
        bot.id,
        turn.options.retryOf,
      );
      const history = turn.options.standalone ? earlier.slice(-1) : earlier;
      const names = new Map(store.bots.list().map((b) => [b.id, b.name]));
      const extras = this.extensions.promptExtras?.(bot, thread, turn.info) ?? {};
      const system = buildSystemPrompt(bot, {
        thread,
        teammates: thread.memberIds.filter((id) => id !== bot.id).flatMap((id) => store.bots.get(id) ?? []),
        now: new Date(),
        // One request with no tools: guidance about using them would only make a model write tool calls into its reply.
        ...(turn.parallel ? { memory: extras.memory } : extras),
      });
      const host = turn.parallel
        ? undefined
        : this.extensions.tools?.(bot, thread, message.id, signal, turn.info);
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
      // A reply whose roles ran with tools goes back to the model as just their answers, never their searches.
      const chatHistory = toChatHistory(forHistory(history), bot.id, names);
      // Parallel Bots is one request, so a long chat isn't summarized first (that would be a second one): the turn
      // keeps the newest messages that fit instead.
      const compacted = turn.parallel
        ? { messages: chatHistory, cache: undefined }
        : await compactHistory(
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
      // Ollama is always told: its model list leaves thinking out for some models that do think (Ornith 1.5, MiMo
      // v2.6), and the planner's few tokens would all go on thinking. Ollama accepts it from any model.
      const thinksAnyway = resolved.provider.kind === "ollama" || info.capabilities.includes("thinking");
      const note = turn.parallel
        ? null
        : await this.extensions
            .beforeTurn?.({
              bot,
              thread,
              info: turn.info,
              latest: history.at(-1),
              tools: definitions.map((definition) => definition.name),
              ask: async (question, text) => {
                // The time limit is for the model's own work: the slot on the shared model is waited for first, with
                // only the turn's signal, so other bots holding it for a while don't use the time up.
                const release =
                  resolved.provider.local && !releaseTurnSlot
                    ? await this.acquireSlot(priority, thread.id, bot.id, signal)
                    : undefined;
                try {
                  return await askWith(guarded, model, question, text, {
                    signal: AbortSignal.any([signal, AbortSignal.timeout(this.beforeTurnTimeoutMs)]),
                    local,
                    maxTokens: 300,
                    ...(thinksAnyway ? { think: false } : {}),
                  });
                } finally {
                  release?.();
                }
              },
            })
            .catch((error: unknown) => {
              if (signal.aborted) throw error;
              console.warn("[turns] preparing the turn failed", error);
              return null;
            });
      // What is added to the newest user message for this one request: the plan a coordinator made, or the form
      // Parallel Bots asks the reply to take.
      const added = turn.parallel ? parallelInstructions() : note;
      const { thinkOff, ...turnOptions } = this.extensions.turnOptions?.(bot, thread, turn.info) ?? {};
      let usage: Usage;
      let status: "done" | "error" = "done";
      // On a cloud model (no shared slot to hold), Parallel Bots asks the three roles in separate requests at the same
      // time instead of one combined request; a local model keeps the single request.
      const separate =
        turn.parallel && !turn.parallelTools && !resolved.provider.local && settings.parallelSeparateOnCloud;
      if (turn.parallelTools || separate) {
        const laneSteps = settings.parallelSteps;
        const lanes = settings.parallelLanes;
        const lastUser = history.findLast((m) => m.role === "user");
        // One slot for the whole turn, shared by the roles' requests (see RequestGroup).
        const group = runtime.group(priority, {
          lanes,
          local: resolved.provider.local,
          signal,
          onQueued: () => this.setActivity(thread.id, bot.id, "queued"),
        });
        const grouped: ChatProvider = {
          id: guarded.id,
          label: guarded.label,
          kind: guarded.kind,
          local: guarded.local,
          listModels: (listSignal) => guarded.listModels(listSignal),
          async *chat(request) {
            const release = await group.acquire(request.signal);
            try {
              yield* guarded.chat(request);
            } finally {
              release();
            }
          },
        };
        let warning: string | null = null;
        if (turn.parallelTools && resolved.provider.kind === "ollama" && lanes > 1) {
          const loaded = await runtime.ollama
            .ps(AbortSignal.timeout(1500))
            .then((list) => list.find((entry) => entry.name === model))
            .catch(() => undefined);
          warning = memoryWarning({ lanes, loaded, numCtx: settings.numCtx });
        }
        const outcome = await runLanes({
          parts,
          publish: publishFull,
          delta: (partIndex, kind, text) => {
            dirty = true;
            if (exists)
              bus.publish({
                type: "message.delta",
                threadId: thread.id,
                messageId: message.id,
                partIndex,
                kind,
                text,
              });
          },
          working: () => this.setActivityOnce(thread.id, bot.id, "working"),
          alive: () => exists,
          signal,
          provider: grouped,
          model,
          capabilities: info.capabilities,
          contextWindow,
          local,
          think: settings.think,
          system,
          history: compacted.messages,
          question: lastUser ? messageText(lastUser) : "",
          steps: laneSteps,
          staggerMs: this.laneStaggerMs,
          ask: (instruction, question) =>
            askWith(grouped, model, instruction, question, {
              signal,
              local,
              maxTokens: 300,
              ...(thinksAnyway ? { think: false } : {}),
            }),
          tools: turn.parallelTools
            ? (lane, laneSignal) =>
                this.extensions.tools?.(bot, thread, message.id, laneSignal, {
                  ...turn.info,
                  lane,
                  onlyTools: ["web_search", "fetch_url"],
                })
            : undefined,
          scrub: this.extensions.scrub,
          warning,
        });
        usage = outcome.usage;
        status = outcome.allFailed ? "error" : "done";
      } else {
        const result = await runTurn({
          provider,
          model,
          capabilities:
            thinkOff && resolved.provider.kind === "ollama" && !info.capabilities.includes("thinking")
              ? [...info.capabilities, "thinking"]
              : info.capabilities,
          system,
          history: added ? withNote(compacted.messages, added) : compacted.messages,
          contextWindow,
          tools,
          think: settings.think,
          local,
          signal,
          sink,
          steer: () => turn.steer.splice(0),
          ...turnOptions,
        });
        usage = result.usage;
      }

      save();
      persist({ parts, status, usage });
    } catch (error) {
      const stopped = signal.aborted || (error instanceof ProviderError && error.code === "aborted");
      if (!stopped) {
        const code = error instanceof ProviderError ? error.code : "unknown";
        // A provider or a connected app can put a key or token into its error text.
        const text = (error as Error).message;
        parts.push({
          type: "error",
          code,
          message: this.extensions.scrub ? this.extensions.scrub(text) : text,
        });
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
      releaseTurnSlot?.();
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

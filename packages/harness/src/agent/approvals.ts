import { randomUUID } from "node:crypto";

import {
  DEFAULT_PERMISSIONS,
  Permissions,
  type ApprovalDecision,
  type MessagePart,
  type PermissionRule,
} from "@mrog/shared";
import type { Store } from "@mrog/store";
import { BADGES, type AskChoices, type ApprovalRequest, type Risk } from "@mrog/tools";

import type { EventBus } from "../bus";
import type { TurnManager } from "../turns";

const PERMISSIONS_KEY = "permissions";

/** How long an approval card waits for an answer before the call is dropped, unrun. Questions never time out. */
export const APPROVAL_TIMEOUT_MS = 15 * 60_000;

/** What an approval came to, and who settled it. A timeout is not a refusal: the bot is told which it was. */
export type Verdict = "allow" | "deny" | "timeout";
type DecidedBy = NonNullable<Extract<MessagePart, { type: "tool" }>["decidedBy"]>;

interface Pending {
  /** The user's answer from the card. */
  answer(decision: "allow" | "deny"): void;
  request: ApprovalRequest;
  canAlways: boolean;
}

/**
 * "Always allow" is offered for general actions only, and never for one that may buy, send or change something
 * on a site or touches sign-in: allowing one such click or login must not allow every later one.
 */
const canAlways = (risk: Risk) =>
  risk.kind === "general" &&
  !risk.badges.some(
    (badge) => badge === BADGES.acts || badge === BADGES.security || badge === BADGES.secrets,
  );

export interface TurnScope {
  threadId: string;
  messageId: string;
  botId: string;
  groupChat: boolean;
  signal: AbortSignal;
  /** Set for a delegated helper: its cards appear in the coordinator's message under this name. */
  asBot?: string;
}

/**
 * Decides risky tool calls: the local-execution policy first, then saved rules, then the user through an
 * approval card on the call's own message.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  /** How long a card waits for an answer (tests shorten it). */
  timeoutMs: number;

  constructor(
    private readonly deps: { store: Store; bus: EventBus; turns: TurnManager; timeoutMs?: number },
  ) {
    this.timeoutMs = deps.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  }

  permissions(): Permissions {
    return this.deps.store.settings.cached(PERMISSIONS_KEY, (saved) => {
      const parsed = Permissions.safeParse(saved);
      return parsed.success ? parsed.data : DEFAULT_PERMISSIONS;
    });
  }

  savePermissions(next: Permissions): Permissions {
    const valid = Permissions.parse(next);
    this.deps.store.settings.set(PERMISSIONS_KEY, valid);
    this.deps.bus.publish({ type: "data.changed", keys: ["permissions"] });
    return valid;
  }

  addRule(rule: Omit<PermissionRule, "id" | "createdAt">): PermissionRule {
    const created: PermissionRule = { ...rule, id: randomUUID(), createdAt: new Date().toISOString() };
    const current = this.permissions();
    this.savePermissions({ ...current, rules: [...current.rules, created] });
    return created;
  }

  /** A saved rule for this action, most specific (longest match) first. */
  private ruleFor(tool: string, risk: Risk): PermissionRule | undefined {
    return this.permissions()
      .rules.filter((rule) => rule.tool === tool && (!rule.match || risk.summary.startsWith(rule.match)))
      .toSorted((a, b) => (b.match?.length ?? 0) - (a.match?.length ?? 0))[0];
  }

  /** What the local-execution policy or a saved rule decides without asking, and which of them; undefined when the user must. */
  private settledBy(
    tool: string,
    risk: Risk,
  ): { decision: "allow" | "deny"; source: "policy" | "rule" } | undefined {
    // Giving secrets to a command is never settled without the user: not by "always allow commands", not by a rule.
    // "Never allow commands" still refuses it.
    if (risk.badges.includes(BADGES.secrets)) {
      return risk.kind === "terminal" && this.permissions().localExecution === "never"
        ? { decision: "deny", source: "policy" }
        : undefined;
    }
    if (risk.kind === "terminal") {
      const policy = this.permissions().localExecution;
      if (policy === "never") return { decision: "deny", source: "policy" };
      if (policy === "always") return { decision: "allow", source: "policy" };
    }
    return this.ruleFor(tool, risk)?.decision === "allow" ? { decision: "allow", source: "rule" } : undefined;
  }

  /** What the local-execution policy or a saved rule decides without asking; undefined when the user must. */
  settled(tool: string, risk: Risk): "allow" | "deny" | undefined {
    return this.settledBy(tool, risk)?.decision;
  }

  /** Notes on the call's card who decided it (shown nowhere yet, but kept on the message for the record). */
  private note(request: ApprovalRequest, scope: TurnScope, source: DecidedBy) {
    const part = this.deps.turns.partHooks
      .get(scope.messageId)
      ?.parts.find((p) => p.type === "tool" && p.callId === request.call.id);
    if (part?.type === "tool") part.decidedBy = source;
  }

  async decide(request: ApprovalRequest, scope: TurnScope): Promise<Verdict> {
    const settled = this.settledBy(request.call.name, request.risk);
    if (settled) {
      this.note(request, scope, settled.source);
      return settled.decision;
    }
    // Group chats can't show approval cards.
    if (scope.groupChat) {
      this.note(request, scope, "group_chat");
      return "deny";
    }
    return this.ask(request, scope);
  }

  private ask(request: ApprovalRequest, scope: TurnScope): Promise<Verdict> {
    // Stopped already: no card nobody could answer.
    if (scope.signal.aborted) return Promise.resolve("deny");
    const id = `apr_${randomUUID().replaceAll("-", "")}`;
    const hook = this.deps.turns.partHooks.get(scope.messageId);
    let part = hook?.parts.find((p) => p.type === "tool" && p.callId === request.call.id);
    // A helper's call lives in its own message; show a copy of it in the coordinator's message.
    const mirrored = !!hook && part?.type !== "tool" && !!scope.asBot;
    if (mirrored) {
      part = {
        type: "tool",
        callId: `${request.call.id}@${scope.botId}`,
        name: `${scope.asBot} · ${request.call.name}`,
        args: request.call.arguments,
        status: "pending_approval",
      };
      hook!.parts.push(part);
    }
    if (!hook || part?.type !== "tool") return Promise.resolve("deny");

    part.status = "pending_approval";
    const always = canAlways(request.risk);
    part.approval = {
      id,
      kind: request.risk.kind,
      summary: request.risk.summary,
      badges: request.risk.badges,
      canAlways: always,
    };
    hook.publish();
    this.deps.turns.setActivity(scope.threadId, scope.botId, "waiting_user");

    return new Promise((resolve) => {
      // The user's answer, Stop and the clock can all arrive at once; only the first one counts.
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (verdict: Verdict, source: DecidedBy) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        scope.signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        const allowed = verdict === "allow";
        if (mirrored) {
          part.status = allowed ? "done" : "denied";
          part.result = allowed
            ? `Approved. ${scope.asBot} is running it in its own chat.`
            : verdict === "timeout"
              ? "Nobody answered in time, so it was not run."
              : "Denied.";
        } else {
          part.status = allowed ? "running" : "denied";
        }
        part.decidedBy = source;
        delete part.approval;
        hook.publish();
        this.deps.turns.setActivity(scope.threadId, scope.botId, "working");
        resolve(verdict);
      };
      const onAbort = () => finish("deny", "stopped");
      scope.signal.addEventListener("abort", onAbort, { once: true });
      // A card left unanswered must not hold a turn (and a model slot's worth of work) for ever.
      timer = setTimeout(() => finish("timeout", "timeout"), this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        answer: (decision) => finish(decision, "user"),
        request,
        canAlways: always,
      });
    });
  }

  /** Returns false when the approval is gone (answered, expired or stopped). */
  respond(id: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    // "Always" allows this same action again (the card's summary), not everything the tool can do. Where it
    // isn't offered (terminal commands, site actions, logins) it counts as allowing once.
    if (decision === "always" && pending.canAlways)
      this.addRule({
        tool: pending.request.call.name,
        match: pending.request.risk.summary,
        decision: "allow",
      });
    pending.answer(decision === "deny" ? "deny" : "allow");
    return true;
  }
}

/** ask_user: shows a question card on the message and waits for the typed answer. */
export class QuestionBroker {
  private readonly pending = new Map<string, (answer: string) => void>();

  constructor(private readonly deps: { turns: TurnManager }) {}

  ask(question: string, scope: TurnScope, choices: AskChoices = {}): Promise<string> {
    if (scope.signal.aborted) return Promise.reject(new Error("Stopped."));
    const hook = this.deps.turns.partHooks.get(scope.messageId);
    if (!hook) return Promise.resolve("(no answer: the question could not be shown)");
    const questionId = `q_${randomUUID().replaceAll("-", "")}`;
    const text = scope.asBot ? `${scope.asBot} asks: ${question}` : question;
    const options = choices.options && choices.options.length >= 2 ? choices.options : undefined;
    const part: Extract<MessagePart, { type: "question" }> = {
      type: "question",
      questionId,
      question: text,
      // A helper's question is shown in its coordinator's message with the same choices.
      ...(options ? { options, ...(choices.multiple ? { multiple: true } : {}) } : {}),
    };
    hook.parts.push(part);
    hook.publish();
    this.deps.turns.setActivity(scope.threadId, scope.botId, "waiting_user");
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(questionId);
        // A helper's question sits in its coordinator's message, which may go on: close the card there too.
        part.expired = true;
        hook.publish();
        reject(new Error("Stopped."));
      };
      scope.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(questionId, (answer) => {
        scope.signal.removeEventListener("abort", onAbort);
        this.pending.delete(questionId);
        part.answer = answer;
        hook.publish();
        this.deps.turns.setActivity(scope.threadId, scope.botId, "working");
        resolve(answer);
      });
      // What was asked for happened by itself: answered as if the user had replied.
      void choices.until?.then(
        (answer) => this.pending.get(questionId)?.(answer),
        () => {},
      );
    });
  }

  respond(questionId: string, answer: string): boolean {
    const answerFn = this.pending.get(questionId);
    if (!answerFn) return false;
    answerFn(answer);
    return true;
  }
}

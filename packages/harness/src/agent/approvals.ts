import { randomUUID } from "node:crypto";

import {
  DEFAULT_PERMISSIONS,
  Permissions,
  type ApprovalDecision,
  type MessagePart,
  type PermissionRule,
} from "@mrog/shared";
import type { Store } from "@mrog/store";
import { BADGES, type ApprovalRequest, type Risk } from "@mrog/tools";

import type { EventBus } from "../bus";
import type { TurnManager } from "../turns";

const PERMISSIONS_KEY = "permissions";

interface Pending {
  resolve(decision: "allow" | "deny"): void;
  request: ApprovalRequest;
  canAlways: boolean;
}

/**
 * "Always allow" is offered for general actions only, and never for one that may buy, send or change something
 * on a site or touches sign-in: allowing one such click or login must not allow every later one.
 */
const canAlways = (risk: Risk) =>
  risk.kind === "general" && !risk.badges.some((badge) => badge === BADGES.acts || badge === BADGES.security);

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

  constructor(private readonly deps: { store: Store; bus: EventBus; turns: TurnManager }) {}

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

  /** What the local-execution policy or a saved rule decides without asking; undefined when the user must. */
  settled(tool: string, risk: Risk): "allow" | "deny" | undefined {
    if (risk.kind === "terminal") {
      const policy = this.permissions().localExecution;
      if (policy === "never") return "deny";
      if (policy === "always") return "allow";
    }
    return this.ruleFor(tool, risk)?.decision === "allow" ? "allow" : undefined;
  }

  async decide(request: ApprovalRequest, scope: TurnScope): Promise<"allow" | "deny"> {
    const settled = this.settled(request.call.name, request.risk);
    if (settled) return settled;
    // Group chats can't show approval cards (UI-SPEC §7).
    if (scope.groupChat) return "deny";
    return this.ask(request, scope);
  }

  private ask(request: ApprovalRequest, scope: TurnScope): Promise<"allow" | "deny"> {
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
      const finish = (decision: "allow" | "deny") => {
        scope.signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        if (mirrored) {
          part.status = decision === "allow" ? "done" : "denied";
          part.result =
            decision === "allow" ? `Approved. ${scope.asBot} is running it in its own chat.` : "Denied.";
        } else {
          part.status = decision === "allow" ? "running" : "denied";
        }
        delete part.approval;
        hook.publish();
        this.deps.turns.setActivity(scope.threadId, scope.botId, "working");
        resolve(decision);
      };
      const onAbort = () => finish("deny");
      scope.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: finish, request, canAlways: always });
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
    pending.resolve(decision === "deny" ? "deny" : "allow");
    return true;
  }
}

/** ask_user: shows a question card on the message and waits for the typed answer. */
export class QuestionBroker {
  private readonly pending = new Map<string, (answer: string) => void>();

  constructor(private readonly deps: { turns: TurnManager }) {}

  ask(question: string, scope: TurnScope): Promise<string> {
    if (scope.signal.aborted) return Promise.reject(new Error("Stopped."));
    const hook = this.deps.turns.partHooks.get(scope.messageId);
    if (!hook) return Promise.resolve("(no answer: the question could not be shown)");
    const questionId = `q_${randomUUID().replaceAll("-", "")}`;
    const text = scope.asBot ? `${scope.asBot} asks: ${question}` : question;
    const part: Extract<MessagePart, { type: "question" }> = { type: "question", questionId, question: text };
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
    });
  }

  respond(questionId: string, answer: string): boolean {
    const answerFn = this.pending.get(questionId);
    if (!answerFn) return false;
    answerFn(answer);
    return true;
  }
}

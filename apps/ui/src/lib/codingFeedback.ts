import {
  CODING_ROLES,
  isCodingBusy,
  type CodingColumn,
  type CodingProject,
  type CodingRole,
  type CodingStatus,
} from "@mrog/shared";

import { roleLabel, roundText, type StatusTone } from "./coding";
import { isSlowCard } from "./codingWork";
import { cardsByRef, needsFixing, progressText, qaFailures } from "./codingBoard";

/** What the screen shows about the work going on, drawn from the project alone (the server sets `active` and `log`). */
type Feedback = Pick<CodingProject, "status" | "nodes" | "edges" | "cards" | "active" | "log">;

/** The role at work: what the server says, or, when it says nothing, the role the status belongs to. */
export function activeRole(project: Pick<CodingProject, "status" | "active">): CodingRole | null {
  if (project.active) return project.active.role;
  switch (project.status) {
    case "planning":
      return "planner";
    case "developing":
      return "developer";
    case "qa":
      return "qa";
    default:
      return null;
  }
}

/** What a card is about, in a few words: the file's path, or the connector's label and description. */
export function cardLabel(
  project: Pick<Feedback, "nodes" | "edges" | "cards">,
  cardId: string | null,
): string | null {
  const card = project.cards.find((candidate) => candidate.id === cardId);
  if (!card) return null;
  if (card.kind === "file") return project.nodes.find((node) => node.id === card.ref)?.path ?? card.title;
  const index = project.edges.findIndex((edge) => edge.id === card.ref);
  return index >= 0 ? `e${index + 1}: ${project.edges[index]!.description}` : card.title;
}

export interface RoleChip {
  role: CodingRole;
  label: string;
  /** The one at work now. */
  active: boolean;
  /** The card it is on, or null (planning, or between cards). */
  work: string | null;
}

/** Planner, Developer and QA, with the one at work marked and the card it is on. */
export function workingStrip(project: Feedback): RoleChip[] {
  const current = activeRole(project);
  return CODING_ROLES.map((role) => ({
    role,
    label: roleLabel(role),
    active: role === current,
    work: role === current && project.active ? cardLabel(project, project.active.cardId) : null,
  }));
}

export interface Progress {
  done: number;
  total: number;
  /** 0 to 100, whole numbers. */
  percent: number;
  /** "7 of 12 cards done". */
  text: string;
}

export function cardProgress(project: Pick<Feedback, "cards">): Progress {
  const total = project.cards.length;
  const done = project.cards.filter((card) => card.column === "done").length;
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    text: progressText(done, total).replace("done", total === 1 ? "card done" : "cards done"),
  };
}

/**
 * Cards QA sent back: those with a failing QA comment (or a finding of the whole-project check) from the round that
 * counts. A pass, or a note that a card is back in QA, is no failure. While QA is checking, the round that counts is
 * the one in progress (its comments carry the next number, so far); otherwise it is the last round finished.
 */
export function roundFailures(project: Pick<CodingProject, "cards" | "round" | "status">): number {
  const counted = project.status === "qa" ? project.round + 1 : project.round;
  if (counted <= 0) return 0;
  return project.cards.filter((card) => qaFailures(card).some((comment) => comment.round === counted)).length;
}

/** "Round 2 of 5", with how many cards failed: "Round 2 of 5 · 3 cards failed so far" (or "in the last round"). */
export function roundSummary(
  project: Pick<CodingProject, "cards" | "round" | "maxRounds" | "status">,
): string {
  const failed = roundFailures(project);
  const base = roundText(project);
  if (failed === 0) return base;
  return `${base} · ${failed} ${failed === 1 ? "card" : "cards"} failed ${project.status === "qa" ? "so far" : "in the last round"}`;
}

export type BannerIcon = "message" | "working" | "hand" | "code" | "search" | "check" | "pause" | "alert";

export interface Banner {
  tone: StatusTone;
  icon: BannerIcon;
  /** One plain line about what is going on. */
  line: string;
  /** What the user should do next, when there is something. */
  next: string | null;
}

/** One plain line for each status, with the next step for the user. */
export function statusBanner(
  project: Pick<CodingProject, "status" | "cards" | "autoApprove" | "error" | "outputFolder" | "round">,
): Banner {
  const open = project.cards.filter((card) => card.column !== "done").length;
  switch (project.status) {
    case "setup":
      return {
        tone: "idle",
        icon: "message",
        line: "Ready for your brief.",
        next: "Describe what to build in the chat.",
      };
    case "planning":
      return {
        tone: "busy",
        icon: "working",
        line: "The Planner is drawing the files and connections.",
        next: null,
      };
    case "awaiting_approval":
      return {
        tone: "wait",
        icon: "hand",
        line: "Plan ready: approve it or ask for changes.",
        next: project.autoApprove
          ? "Auto-approve is on, but you can still approve or change the plan now."
          : "Look it over, then press Approve.",
      };
    case "developing":
      return { tone: "busy", icon: "code", line: "The Developer is writing the code.", next: null };
    case "qa":
      return { tone: "busy", icon: "search", line: "QA is checking the finished cards.", next: null };
    case "needs_you":
      return {
        tone: "wait",
        icon: "hand",
        line: `Round limit reached: ${open} ${open === 1 ? "card" : "cards"} still to pass.`,
        next: "Allow more rounds and resume, or tell the bot in the chat what to change.",
      };
    case "done":
      return {
        tone: "ok",
        icon: "check",
        line: "Finished: every card passed QA.",
        next: `The files are in ${project.outputFolder}.`,
      };
    case "stopped":
      return {
        tone: "idle",
        icon: "pause",
        line: "Stopped. Nothing is running.",
        next: "Press Resume to carry on.",
      };
    case "error":
      return {
        tone: "bad",
        icon: "alert",
        line: project.error ? "It stopped with an error." : "Something went wrong.",
        next: "Fix the cause, then press Resume.",
      };
  }
}

/** What to say in a view that has nothing to draw yet. */
export function emptyPlanText(status: CodingStatus, what: "diagram" | "board" | "checklist"): string {
  if (status === "setup")
    return `Describe what to build in the chat. The ${what} appears here once there is a plan.`;
  if (status === "planning") return "The Planner is drawing the files and connections…";
  if (status === "error") return "The project stopped before there was a plan. Details are above.";
  return `There is no plan yet, so the ${what} is empty.`;
}

/** How one file or connector looks in the diagram. */
export interface NodeMark {
  column: CodingColumn;
  /** Someone is working on its card right now: it gets the moving ring. */
  working: boolean;
  /** QA sent it back and it waits to be fixed: marked. */
  sentBack: boolean;
  /** Passed QA: ticked. */
  done: boolean;
  /** A connector whose card is in progress or in QA: its junction lights up. */
  lit: boolean;
  /** Its card has taken 10 minutes or more. */
  slow: boolean;
}

export const NO_MARK: NodeMark = {
  column: "todo",
  working: false,
  sentBack: false,
  done: false,
  lit: false,
  slow: false,
};

export type CornerKind = "sentBack" | "done" | "slow";

/** The one small mark a node shows on its corner: QA sending it back and passing it win over being slow. */
export function cornerKind(mark: NodeMark | undefined): CornerKind | null {
  if (!mark) return null;
  if (mark.sentBack) return "sentBack";
  if (mark.done) return "done";
  return mark.slow ? "slow" : null;
}

/**
 * A mark for every node and edge that has a card, by node or edge id. `now` lets the turn running on a card count
 * towards "slow"; without it only finished turns do (a picture of the plan as saved).
 */
export function diagramMarks(project: Feedback, now = 0): Map<string, NodeMark> {
  const busy = isCodingBusy(project.status);
  const marks = new Map<string, NodeMark>();
  for (const card of cardsByRef(project.cards).values()) {
    marks.set(card.ref, {
      column: card.column,
      working: busy && (project.active?.cardId === card.id || card.column === "in_progress"),
      sentBack: needsFixing(card),
      done: card.column === "done",
      lit: card.kind === "connector" && (card.column === "in_progress" || card.column === "qa"),
      slow: isSlowCard(card, project, now),
    });
  }
  return marks;
}

export interface LogLine {
  at: string;
  text: string;
}

/** The newest lines first, at most `limit`. */
export function recentLog(project: Pick<CodingProject, "log">, limit = 20): LogLine[] {
  return (project.log ?? [])
    .filter((line) => line.text.trim())
    .slice(-limit)
    .toReversed();
}

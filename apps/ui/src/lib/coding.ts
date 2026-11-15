import {
  CODING_ROLES,
  DEFAULT_MAX_ROUNDS,
  isCodingBusy,
  MAX_ROUNDS_LIMIT,
  type CodingProject,
  type CodingRole,
  type CodingStatus,
  type CreateCodingBotInput,
} from "@mrog/shared";

/** The Coding panel's tabs, in the order they are shown. */
export const CODING_TABS = ["diagram", "board", "checklist"] as const;
export type CodingTab = (typeof CODING_TABS)[number];

export const TAB_LABEL: Record<CodingTab, string> = {
  diagram: "Diagram",
  board: "Board",
  checklist: "Checklist",
};

/** Left / Right / Home / End move between tabs (wrapping), as a tab list should. */
export function nextTab(current: CodingTab, key: string): CodingTab | null {
  const at = CODING_TABS.indexOf(current);
  switch (key) {
    case "ArrowRight":
      return CODING_TABS[(at + 1) % CODING_TABS.length]!;
    case "ArrowLeft":
      return CODING_TABS[(at - 1 + CODING_TABS.length) % CODING_TABS.length]!;
    case "Home":
      return CODING_TABS[0];
    case "End":
      return CODING_TABS[CODING_TABS.length - 1]!;
    default:
      return null;
  }
}

const STATUS_LABEL: Record<CodingStatus, string> = {
  setup: "Waiting for the brief",
  planning: "Planning",
  awaiting_approval: "Waiting for your approval",
  developing: "Writing code",
  qa: "QA review",
  needs_you: "Needs you",
  done: "Done",
  stopped: "Stopped",
  error: "Error",
};

const ROLE_LABEL: Record<CodingRole, string> = { planner: "Planner", developer: "Developer", qa: "QA" };
export const roleLabel = (role: CodingRole): string => ROLE_LABEL[role];

export const statusLabel = (status: CodingStatus): string => STATUS_LABEL[status];

/** How a status chip looks: working, waiting for you, finished well, failed, or idle. */
export type StatusTone = "busy" | "wait" | "ok" | "bad" | "idle";

export function statusTone(status: CodingStatus): StatusTone {
  if (isCodingBusy(status)) return "busy";
  switch (status) {
    case "awaiting_approval":
    case "needs_you":
      return "wait";
    case "done":
      return "ok";
    case "error":
      return "bad";
    default:
      return "idle";
  }
}

/** The plan can be approved (or sent back with changes) only while it waits for you. */
export const canApprove = (status: CodingStatus): boolean => status === "awaiting_approval";
export const canRevise = canApprove;
/** Stop is for work in progress; a project that is waiting for you is already paused. */
export const canStop = (status: CodingStatus): boolean => isCodingBusy(status);
/** Resume picks up a stopped project, one that hit the round limit, or one that failed. */
export const canResume = (status: CodingStatus): boolean =>
  status === "stopped" || status === "needs_you" || status === "error";

/**
 * "Round 2 of 5", or that the limit was reached. `round` counts the QA rounds finished, so while the team is writing
 * code or checking it the round in progress is the next one (the same count the bot's own status messages use).
 */
export function roundText(project: Pick<CodingProject, "round" | "maxRounds" | "status">): string {
  const { round, maxRounds, status } = project;
  if (status === "needs_you" && round >= maxRounds) return "Round limit reached";
  if (status === "developing" || status === "qa")
    return `Round ${Math.min(round + 1, maxRounds)} of ${maxRounds}`;
  if (round <= 0) return `Up to ${maxRounds} QA ${maxRounds === 1 ? "round" : "rounds"}`;
  return `Round ${Math.min(round, maxRounds)} of ${maxRounds}`;
}

/** Junction labels in the diagram, the legend and the cards: e1, e2, … by the edge's place in the plan. */
export const edgeLabel = (index: number): string => `e${index + 1}`;

const ROUNDS_BOUNDS = `Use a whole number from 1 to ${MAX_ROUNDS_LIMIT}.`;

/** A round limit typed into a field, or null when it isn't a whole number in range. */
export function parseRounds(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_ROUNDS_LIMIT ? value : null;
}

export function roundsProblem(text: string): string | null {
  return parseRounds(text) === null ? ROUNDS_BOUNDS : null;
}

/**
 * What pressing Resume should do with the round-limit field: a message when it can't, otherwise the new limit to save
 * first (null when it is unchanged). A project at its limit needs a limit above the rounds already used, or it would
 * stop again at once.
 */
export function resumePlan(
  project: Pick<CodingProject, "round" | "maxRounds" | "status">,
  draft: string,
): { problem: string | null; raiseTo: number | null } {
  const value = parseRounds(draft);
  if (value === null) return { problem: ROUNDS_BOUNDS, raiseTo: null };
  if (project.status === "needs_you" && value <= project.round)
    return { problem: `Allow more than ${project.round} rounds to carry on.`, raiseTo: null };
  return { problem: null, raiseTo: value === project.maxRounds ? null : value };
}

/** An absolute path: `C:\x`, `C:/x`, a network `\\server\share`, or `/x`. The server still checks the folder. */
export const isAbsolutePath = (path: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");

export function folderProblem(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return "Choose an output folder.";
  if (trimmed.length > 500) return "That path is too long.";
  if (!isAbsolutePath(trimmed)) return "Use the full path of the folder, like C:\\Projects\\my-app.";
  return null;
}

export interface CodingForm {
  name: string;
  outputFolder: string;
  planner: string | null;
  developer: string | null;
  qa: string | null;
  autoApprove: boolean;
  /** As typed. */
  maxRounds: string;
}

export const DEFAULT_CODING_FORM: CodingForm = {
  name: "Coding Bot",
  outputFolder: "",
  planner: null,
  developer: null,
  qa: null,
  autoApprove: false,
  maxRounds: String(DEFAULT_MAX_ROUNDS),
};

/**
 * The longest Coding Bot name, the server's limit: its roles are named after it ("<name> Developer" is the longest),
 * and a bot's name is at most 60 characters.
 */
export const MAX_CODING_NAME = 49;

/** The Coding Bot's name and its three roles' names, each of which must be free. */
export const teamNames = (name: string): string[] => {
  const base = name.trim();
  return [base, ...CODING_ROLES.map((role) => `${base} ${roleLabel(role)}`)];
};

/** The first name of the team that another bot already has (the server compares without case), or null. */
export function takenName(name: string, existing: readonly string[]): string | null {
  const taken = new Set(existing.map((other) => other.trim().toLowerCase()));
  return teamNames(name).find((candidate) => taken.has(candidate.toLowerCase())) ?? null;
}

/** "Coding Bot", or "Coding Bot 2", 3, … when that one (or one of its roles' names) is taken. */
export function defaultCodingName(existing: readonly string[]): string {
  const base = DEFAULT_CODING_FORM.name;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!takenName(name, existing)) return name;
  }
}

/** What's wrong with the dialog's fields, or null when the bot can be created. `existing` are the other bots' names. */
export function codingFormProblem(form: CodingForm, existing: readonly string[] = []): string | null {
  if (!form.name.trim()) return "Give the bot a name.";
  if (form.name.trim().length > MAX_CODING_NAME)
    return `Use a shorter name (${MAX_CODING_NAME} characters at most): the team's bots are named after it.`;
  const taken = takenName(form.name, existing);
  if (taken) return `A bot called “${taken}” already exists. Pick another name.`;
  return folderProblem(form.outputFolder) ?? roundsProblem(form.maxRounds);
}

/** The request body for a valid form. */
export function codingInput(form: CodingForm): CreateCodingBotInput {
  return {
    name: form.name.trim(),
    outputFolder: form.outputFolder.trim(),
    roles: {
      planner: { model: form.planner },
      developer: { model: form.developer },
      qa: { model: form.qa },
    },
    autoApprove: form.autoApprove,
    maxRounds: parseRounds(form.maxRounds) ?? DEFAULT_MAX_ROUNDS,
  };
}

/** The composer's placeholder and an optional hint line above it, by what the project is waiting for. */
export function composerCopy(
  status: CodingStatus | undefined,
  title: string,
): { placeholder: string; hint: string | null } {
  switch (status) {
    case "setup":
      return {
        placeholder: "Describe what to build",
        hint: "Your first message is the brief: what to build, what to use, and anything it must do.",
      };
    case "awaiting_approval":
      return {
        placeholder: "Type changes you want, or approve the plan",
        hint: "Changes you type go to the Planner. Approve the plan in the panel to start writing code.",
      };
    default:
      return { placeholder: `Message ${title}`, hint: null };
  }
}

export const MIN_PANEL_WIDTH = 360;
export const DEFAULT_PANEL_WIDTH = 560;
/** The chat beside the panel keeps at least this much room: its messages and the message box stay usable. */
export const MIN_CHAT_WIDTH = 320;

/** The sidebar's width, as App lays it out (`grid-cols-[264px_…]`, or 60px when compact). */
export const sidebarWidth = (compact: boolean): number => (compact ? 60 : 264);

export interface PanelFit {
  width: number;
  /**
   * The window is too narrow for the panel beside the chat: it lies over the chat as a drawer instead (opened and
   * closed with the Coding panel button), rather than squeezing the chat to nothing.
   */
  overlay: boolean;
}

/**
 * How wide the panel can be. Beside the chat it is at least MIN_PANEL_WIDTH and leaves the chat MIN_CHAT_WIDTH of
 * what the sidebar leaves; when both can't fit, it becomes a drawer over the chat, as wide as asked but never wider
 * than the room there is.
 */
export function fitPanel(width: number, viewport: number, sidebar: number): PanelFit {
  const room = Math.max(0, Math.floor(viewport - sidebar));
  const wanted = Math.max(MIN_PANEL_WIDTH, Math.round(width));
  const besideMax = room - MIN_CHAT_WIDTH;
  if (besideMax >= MIN_PANEL_WIDTH) return { width: Math.min(wanted, besideMax), overlay: false };
  return { width: Math.min(wanted, room), overlay: true };
}

/** The panel width for a window and sidebar: see fitPanel. */
export const clampPanelWidth = (width: number, viewport: number, sidebar: number): number =>
  fitPanel(width, viewport, sidebar).width;

/** Whether the panel fits beside the chat in this window. */
export const panelFits = (viewport: number, sidebar: number): boolean =>
  !fitPanel(MIN_PANEL_WIDTH, viewport, sidebar).overlay;

/**
 * The panel to show when a chat opens. A Coding Bot's chat opens with its Coding panel unless the user closed it
 * before, or the window is too narrow for it beside the chat (it would cover the chat); any other chat keeps
 * whatever panel was open.
 */
export function panelOnOpen<P>(isCoding: boolean, codingOpen: boolean, panel: P, fits = true): P | "coding" {
  return isCoding && codingOpen && fits ? "coding" : panel;
}

/** A plan can be imported, or the models changed, whenever the team isn't in the middle of a step. */
export const canImportPlan = (status: CodingStatus): boolean => !isCodingBusy(status);
export const canEditModels = canImportPlan;

import { describe, expect, it } from "vitest";

import { CodingStatus, CreateCodingBotInput, DEFAULT_MAX_ROUNDS, MAX_ROUNDS_LIMIT } from "@mrog/shared";

import {
  CODING_TABS,
  canApprove,
  canEditModels,
  canImportPlan,
  canResume,
  canRevise,
  canStop,
  clampPanelWidth,
  codingFormProblem,
  codingInput,
  composerCopy,
  DEFAULT_CODING_FORM,
  defaultCodingName,
  edgeLabel,
  fitPanel,
  folderProblem,
  MAX_CODING_NAME,
  MIN_CHAT_WIDTH,
  MIN_PANEL_WIDTH,
  nextTab,
  panelFits,
  panelOnOpen,
  sidebarWidth,
  takenName,
  teamNames,
  parseRounds,
  resumePlan,
  roundsProblem,
  roundText,
  statusLabel,
  statusTone,
  type CodingForm,
} from "./coding";

const STATUSES = CodingStatus.options;

describe("status rules", () => {
  it("labels every status", () => {
    for (const status of STATUSES) expect(statusLabel(status).length).toBeGreaterThan(2);
    expect(statusLabel("awaiting_approval")).toBe("Waiting for your approval");
    expect(statusLabel("needs_you")).toBe("Needs you");
  });

  it("only lets the plan be approved or sent back while it waits for you", () => {
    expect(STATUSES.filter(canApprove)).toEqual(["awaiting_approval"]);
    expect(STATUSES.filter(canRevise)).toEqual(["awaiting_approval"]);
  });

  it("stops only work in progress", () => {
    expect(STATUSES.filter(canStop)).toEqual(["planning", "developing", "qa"]);
  });

  it("resumes a stopped project, one at its round limit, or one that failed", () => {
    expect(STATUSES.filter(canResume)).toEqual(["needs_you", "stopped", "error"]);
  });

  it("never offers Stop and Resume together", () => {
    for (const status of STATUSES) expect(canStop(status) && canResume(status)).toBe(false);
  });

  it("gives every status a tone, and failures and finishes stand out", () => {
    expect(statusTone("developing")).toBe("busy");
    expect(statusTone("awaiting_approval")).toBe("wait");
    expect(statusTone("needs_you")).toBe("wait");
    expect(statusTone("done")).toBe("ok");
    expect(statusTone("error")).toBe("bad");
    expect(statusTone("stopped")).toBe("idle");
    expect(statusTone("setup")).toBe("idle");
  });
});

describe("round text", () => {
  it("counts the round in progress, the way the bot's own messages do", () => {
    expect(roundText({ round: 0, maxRounds: 5, status: "developing" })).toBe("Round 1 of 5");
    expect(roundText({ round: 1, maxRounds: 5, status: "developing" })).toBe("Round 2 of 5");
    expect(roundText({ round: 1, maxRounds: 5, status: "qa" })).toBe("Round 2 of 5");
    expect(roundText({ round: 4, maxRounds: 5, status: "qa" })).toBe("Round 5 of 5");
    // Never past the limit.
    expect(roundText({ round: 5, maxRounds: 5, status: "qa" })).toBe("Round 5 of 5");
  });

  it("counts the rounds finished when nothing is running", () => {
    expect(roundText({ round: 2, maxRounds: 5, status: "stopped" })).toBe("Round 2 of 5");
    expect(roundText({ round: 2, maxRounds: 5, status: "done" })).toBe("Round 2 of 5");
  });

  it("says what the limit is before any round", () => {
    expect(roundText({ round: 0, maxRounds: 5, status: "planning" })).toBe("Up to 5 QA rounds");
    expect(roundText({ round: 0, maxRounds: 1, status: "setup" })).toBe("Up to 1 QA round");
  });

  it("says when the limit was reached", () => {
    expect(roundText({ round: 5, maxRounds: 5, status: "needs_you" })).toBe("Round limit reached");
    // Raised and waiting: not at the limit any more.
    expect(roundText({ round: 5, maxRounds: 8, status: "needs_you" })).toBe("Round 5 of 8");
  });

  it("labels connectors e1, e2, … by place", () => {
    expect([0, 1, 9].map(edgeLabel)).toEqual(["e1", "e2", "e10"]);
  });
});

describe("round limit", () => {
  it("accepts whole numbers from 1 to the limit", () => {
    expect(parseRounds("1")).toBe(1);
    expect(parseRounds(" 5 ")).toBe(5);
    expect(parseRounds(String(MAX_ROUNDS_LIMIT))).toBe(MAX_ROUNDS_LIMIT);
  });

  it("refuses anything else", () => {
    for (const text of ["", "0", "-1", "2.5", "abc", "1e2", String(MAX_ROUNDS_LIMIT + 1), "00000"])
      expect(parseRounds(text), text).toBeNull();
    expect(roundsProblem("0")).toMatch(/1 to 20/);
    expect(roundsProblem("3")).toBeNull();
  });

  it("resumes without a change when the limit is as it was", () => {
    expect(resumePlan({ round: 2, maxRounds: 5, status: "stopped" }, "5")).toEqual({
      problem: null,
      raiseTo: null,
    });
  });

  it("saves a new limit before resuming", () => {
    expect(resumePlan({ round: 5, maxRounds: 5, status: "needs_you" }, "8")).toEqual({
      problem: null,
      raiseTo: 8,
    });
  });

  it("will not resume a project at its limit without raising it above the rounds used", () => {
    const plan = resumePlan({ round: 5, maxRounds: 5, status: "needs_you" }, "5");
    expect(plan.problem).toMatch(/more than 5/);
    expect(plan.raiseTo).toBeNull();
    expect(resumePlan({ round: 5, maxRounds: 5, status: "needs_you" }, "3").problem).not.toBeNull();
  });

  it("rejects a limit that isn't a number", () => {
    expect(resumePlan({ round: 1, maxRounds: 5, status: "stopped" }, "x").problem).not.toBeNull();
  });
});

describe("the new Coding Bot form", () => {
  const good: CodingForm = { ...DEFAULT_CODING_FORM, outputFolder: "C:\\Projects\\todo-app" };

  it("is valid with a folder, and the defaults match the server's", () => {
    expect(DEFAULT_CODING_FORM.maxRounds).toBe(String(DEFAULT_MAX_ROUNDS));
    expect(DEFAULT_CODING_FORM.autoApprove).toBe(false);
    expect(codingFormProblem(good)).toBeNull();
  });

  it("needs an output folder", () => {
    expect(folderProblem("")).toBe("Choose an output folder.");
    expect(folderProblem("   ")).toBe("Choose an output folder.");
    expect(codingFormProblem(DEFAULT_CODING_FORM)).toBe("Choose an output folder.");
  });

  it("wants the full path of the folder", () => {
    for (const path of ["C:\\Projects\\app", "D:/work/app", "/home/me/app", "\\\\server\\share\\app"])
      expect(folderProblem(path), path).toBeNull();
    for (const path of ["app", "./app", "..\\app", "~/app", "Projects\\app", "C:app", "C:"])
      expect(folderProblem(path), path).not.toBeNull();
  });

  it("needs a name that fits, with room for its roles' names", () => {
    expect(codingFormProblem({ ...good, name: "  " })).toBe("Give the bot a name.");
    // The server's limit, so "<name> Developer" is still a bot name of 60 characters at most.
    expect(MAX_CODING_NAME).toBe(49);
    expect(codingFormProblem({ ...good, name: "x".repeat(50) })).toMatch(/49 characters/);
    expect(codingFormProblem({ ...good, name: "x".repeat(49) })).toBeNull();
    for (const name of teamNames("x".repeat(MAX_CODING_NAME))) expect(name.length).toBeLessThanOrEqual(60);
  });

  it("refuses a name that the bot or one of its roles would share with another bot", () => {
    const existing = ["Helper", "coding bot developer"];
    expect(codingFormProblem({ ...good, name: "helper" }, existing)).toMatch(/“helper” already exists/);
    expect(codingFormProblem({ ...good, name: "Coding Bot" }, existing)).toMatch(
      /“Coding Bot Developer” already exists/,
    );
    expect(codingFormProblem({ ...good, name: "Builder" }, existing)).toBeNull();
    expect(teamNames(" Builder ")).toEqual(["Builder", "Builder Planner", "Builder Developer", "Builder QA"]);
    expect(takenName("Builder", existing)).toBeNull();
  });

  it("offers a default name nobody has yet", () => {
    expect(defaultCodingName([])).toBe("Coding Bot");
    expect(defaultCodingName(["Coding Bot", "Coding Bot Planner"])).toBe("Coding Bot 2");
    expect(defaultCodingName(["coding bot", "Coding Bot 2 QA"])).toBe("Coding Bot 3");
  });

  it("checks the round limit", () => {
    expect(codingFormProblem({ ...good, maxRounds: "0" })).toMatch(/1 to 20/);
    expect(codingFormProblem({ ...good, maxRounds: "" })).toMatch(/1 to 20/);
  });

  it("builds a request the server's schema accepts", () => {
    const input = codingInput({
      ...good,
      name: "  Builder ",
      outputFolder: " C:\\Projects\\todo-app ",
      developer: "ollama:qwen3:8b",
      autoApprove: true,
      visualQa: true,
      maxRounds: "7",
    });
    expect(input).toEqual({
      name: "Builder",
      outputFolder: "C:\\Projects\\todo-app",
      roles: {
        planner: { model: null },
        developer: { model: "ollama:qwen3:8b" },
        qa: { model: null },
      },
      autoApprove: true,
      visualQa: true,
      maxRounds: 7,
    });
    expect(CreateCodingBotInput.safeParse(input).success).toBe(true);
  });
});

describe("the composer while the project waits", () => {
  it("asks for the brief first", () => {
    expect(composerCopy("setup", "Coder").placeholder).toBe("Describe what to build");
    expect(composerCopy("setup", "Coder").hint).toMatch(/brief/);
  });

  it("invites changes to the plan", () => {
    expect(composerCopy("awaiting_approval", "Coder").placeholder).toBe(
      "Type changes you want, or approve the plan",
    );
  });

  it("is an ordinary message box otherwise", () => {
    for (const status of [...STATUSES.filter((s) => s !== "setup" && s !== "awaiting_approval"), undefined])
      expect(composerCopy(status, "Coder")).toEqual({ placeholder: "Message Coder", hint: null });
  });
});

describe("the panel", () => {
  it("has the three tabs in order and moves between them with the arrow keys", () => {
    expect([...CODING_TABS]).toEqual(["diagram", "board", "checklist"]);
    expect(nextTab("diagram", "ArrowRight")).toBe("board");
    expect(nextTab("checklist", "ArrowRight")).toBe("diagram");
    expect(nextTab("diagram", "ArrowLeft")).toBe("checklist");
    expect(nextTab("board", "Home")).toBe("diagram");
    expect(nextTab("board", "End")).toBe("checklist");
    expect(nextTab("board", "a")).toBeNull();
  });

  it("keeps its width readable and leaves room for the chat", () => {
    const sidebar = sidebarWidth(false);
    expect(clampPanelWidth(100, 1400, sidebar)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(560, 1400, sidebar)).toBe(560);
    // The chat keeps its room next to the sidebar.
    expect(clampPanelWidth(5000, 1400, sidebar)).toBe(1400 - sidebar - MIN_CHAT_WIDTH);
    expect(clampPanelWidth(5000, 1400, sidebarWidth(true))).toBe(1400 - 60 - MIN_CHAT_WIDTH);
  });

  it("never squeezes the chat below its minimum beside the panel", () => {
    for (const viewport of [760, 900, 1024, 1280, 1920])
      for (const compact of [false, true])
        for (const wanted of [0, 360, 560, 900, 5000]) {
          const sidebar = sidebarWidth(compact);
          const fit = fitPanel(wanted, viewport, sidebar);
          const label = `${viewport} ${compact} ${wanted}`;
          if (fit.overlay) expect(fit.width, label).toBeLessThanOrEqual(viewport - sidebar);
          else {
            expect(viewport - sidebar - fit.width, label).toBeGreaterThanOrEqual(MIN_CHAT_WIDTH);
            expect(fit.width, label).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH);
          }
        }
  });

  it("lies over the chat as a drawer when the window is too narrow for both", () => {
    // The desktop app's narrowest window with the full sidebar.
    expect(fitPanel(560, 760, sidebarWidth(false))).toEqual({ width: 496, overlay: true });
    expect(panelFits(760, sidebarWidth(false))).toBe(false);
    // The compact sidebar leaves room for both.
    expect(fitPanel(560, 760, sidebarWidth(true))).toEqual({ width: 380, overlay: false });
    expect(panelFits(760, sidebarWidth(true))).toBe(true);
  });

  it("opens with a Coding Bot's chat unless the user closed it, or it doesn't fit beside the chat", () => {
    expect(panelOnOpen(true, true, null, false)).toBeNull();
    expect(panelOnOpen(true, true, "details", false)).toBe("details");
    expect(panelOnOpen(true, true, null)).toBe("coding");
    expect(panelOnOpen(true, true, "details")).toBe("coding");
    expect(panelOnOpen(true, false, null)).toBeNull();
    expect(panelOnOpen(true, false, "browser")).toBe("browser");
    expect(panelOnOpen(false, true, "details")).toBe("details");
    expect(panelOnOpen(false, true, null)).toBeNull();
  });
});

describe("plan import and model changes", () => {
  it("are for when no step is running", () => {
    expect(STATUSES.filter(canImportPlan)).toEqual([
      "setup",
      "awaiting_approval",
      "needs_you",
      "done",
      "stopped",
      "error",
    ]);
    expect(STATUSES.filter(canEditModels)).toEqual(STATUSES.filter(canImportPlan));
    for (const status of STATUSES) expect(canImportPlan(status)).toBe(!canStop(status));
  });
});

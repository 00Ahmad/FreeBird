import { describe, expect, it } from "vitest";

import {
  CodingEdge,
  CodingProject,
  CreateCodingBotInput,
  DEFAULT_MAX_ROUNDS,
  isCodingBusy,
  MAX_ROUNDS_LIMIT,
  UpdateCodingSettingsInput,
} from "./coding";
import { newId } from "./ids";

describe("a coding project's shapes", () => {
  it("lets an edge link any number of files, but at least two", () => {
    expect(CodingEdge.safeParse({ id: "e1", files: ["a", "b"], description: "x" }).success).toBe(true);
    expect(CodingEdge.safeParse({ id: "e1", files: ["a", "b", "c", "d"], description: "x" }).success).toBe(
      true,
    );
    expect(CodingEdge.safeParse({ id: "e1", files: ["a"], description: "x" }).success).toBe(false);
  });

  it("asks for an output folder and a model per role", () => {
    const roles = { planner: {}, developer: { model: "ollama:a" }, qa: { model: null } };
    expect(CreateCodingBotInput.safeParse({ name: "Coder", outputFolder: "  ", roles }).success).toBe(false);
    const ok = CreateCodingBotInput.parse({ name: "Coder", outputFolder: " C:\\work\\app ", roles });
    expect(ok.outputFolder).toBe("C:\\work\\app");
    expect(ok.maxRounds).toBeUndefined();
  });

  it("keeps the round limit between 1 and the largest allowed", () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(5);
    expect(UpdateCodingSettingsInput.safeParse({ maxRounds: 0 }).success).toBe(false);
    expect(UpdateCodingSettingsInput.safeParse({ maxRounds: MAX_ROUNDS_LIMIT + 1 }).success).toBe(false);
    expect(UpdateCodingSettingsInput.safeParse({ maxRounds: 7, autoApprove: true }).success).toBe(true);
  });

  it("knows which statuses mean it is working", () => {
    const busy = (["planning", "developing", "qa"] as const).map(isCodingBusy);
    const idle = (["setup", "awaiting_approval", "needs_you", "done", "stopped", "error"] as const).map(
      isCodingBusy,
    );
    expect(busy).toEqual([true, true, true]);
    expect(idle.some(Boolean)).toBe(false);
  });

  it("reads a whole project", () => {
    const seat = { botId: newId("bot"), model: null };
    const project = {
      botId: newId("bot"),
      status: "awaiting_approval",
      outputFolder: "C:\\work\\app",
      roles: { planner: seat, developer: seat, qa: seat },
      autoApprove: false,
      maxRounds: 5,
      round: 0,
      brief: "a todo app",
      nodes: [{ id: "n1", path: "src/app.ts", purpose: "starts the app" }],
      edges: [],
      cards: [{ id: "c1", kind: "file", ref: "n1", title: "src/app.ts", column: "todo", comments: [] }],
      note: null,
      error: null,
      startedAt: new Date().toISOString(),
    };
    expect(CodingProject.safeParse(project).success).toBe(true);
    expect(CodingProject.safeParse({ ...project, status: "thinking" }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { CodingStatus } from "@mrog/shared";

import {
  attentionBadge,
  attentionFor,
  attentionMark,
  canSee,
  needsAttention,
  shownAttention,
} from "./codingAttention";
import { project } from "./codingFixture";

const at = (status: CodingStatus, over: Partial<Parameters<typeof project>[0]> = {}) =>
  project({ status, ...over });

describe("when the Coding Bot needs the user", () => {
  it("is for a plan to approve, the round limit, a finished project and an error", () => {
    expect(CodingStatus.options.filter(needsAttention)).toEqual([
      "awaiting_approval",
      "needs_you",
      "done",
      "error",
    ]);
  });

  it("is news when the project reaches one of those", () => {
    for (const status of ["awaiting_approval", "needs_you", "done", "error"] as const) {
      const news = attentionFor("developing", at(status));
      expect(news?.status).toBe(status);
      expect(news?.body.length).toBeGreaterThan(10);
    }
  });

  it("is not news while it works, waits for a brief or is stopped", () => {
    for (const status of ["setup", "planning", "developing", "qa", "stopped"] as const)
      expect(attentionFor("awaiting_approval", at(status)), status).toBeNull();
  });

  it("is not news again while it stays in the same status", () => {
    expect(attentionFor("awaiting_approval", at("awaiting_approval"))).toBeNull();
    expect(attentionFor("needs_you", at("needs_you"))).toBeNull();
  });

  it("is not news when the last status is unknown (an update that beat the first fetch after a reload)", () => {
    expect(attentionFor(undefined, at("awaiting_approval"))).toBeNull();
    expect(attentionFor(undefined, at("done"))).toBeNull();
    expect(attentionFor(undefined, at("developing"))).toBeNull();
  });

  it("has a short sidebar badge for the same statuses", () => {
    expect(attentionBadge("awaiting_approval")).toBe("Approve the plan");
    expect(attentionBadge("developing")).toBeNull();
    expect(attentionBadge(undefined)).toBeNull();
  });
});

describe("the sidebar badge once the chat has been seen", () => {
  const log = (time: string) => [{ at: time, text: "Every card passed QA: the project is done" }];
  const finished = at("done", { log: log("2026-01-01T12:00:00.000Z") });

  it("clears Finished and Error once the chat was opened after they were reached", () => {
    expect(shownAttention(finished, undefined)).toBe("Finished");
    expect(shownAttention(finished, attentionMark(finished))).toBeNull();
    const failed = at("error", { log: log("2026-01-01T12:00:00.000Z") });
    expect(shownAttention(failed, attentionMark(failed))).toBeNull();
    expect(canSee(failed)).toBe(true);
  });

  it("shows Finished again when the project finishes another time", () => {
    const seen = attentionMark(finished);
    const again = at("done", {
      log: [...log("2026-01-01T12:00:00.000Z"), ...log("2026-01-02T08:00:00.000Z")],
    });
    expect(shownAttention(again, seen)).toBe("Finished");
    // A mark from another status never hides this one.
    expect(shownAttention(at("error", { log: finished.log }), seen)).toBe("Error");
  });

  it("keeps Approve the plan and Needs you until the project moves on", () => {
    for (const status of ["awaiting_approval", "needs_you"] as const) {
      const waiting = at(status);
      expect(canSee(waiting)).toBe(false);
      expect(shownAttention(waiting, attentionMark(waiting)), status).not.toBeNull();
    }
  });

  it("shows nothing without a project or while it works", () => {
    expect(shownAttention(undefined, undefined)).toBeNull();
    expect(shownAttention(at("developing"), undefined)).toBeNull();
    // Without a log the start time marks the run.
    expect(attentionMark(at("done"))).toBe("done@2026-01-01T09:00:00.000Z");
  });
});

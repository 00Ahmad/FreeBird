import { describe, expect, it } from "vitest";

import { CodingStatus } from "@mrog/shared";

import { attentionBadge, attentionFor, needsAttention } from "./codingAttention";
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

  it("is news when the last status is unknown", () => {
    expect(attentionFor(undefined, at("awaiting_approval"))).not.toBeNull();
    expect(attentionFor(undefined, at("developing"))).toBeNull();
  });

  it("has a short sidebar badge for the same statuses", () => {
    expect(attentionBadge("awaiting_approval")).toBe("Approve the plan");
    expect(attentionBadge("developing")).toBeNull();
    expect(attentionBadge(undefined)).toBeNull();
  });
});

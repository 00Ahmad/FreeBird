import { describe, expect, it } from "vitest";

import { ApiRequestError } from "./api";
import {
  applyRequest,
  canApplyImport,
  existingWarning,
  importFileProblem,
  importInput,
  MAX_IMPORT_BYTES,
  utf8Bytes,
  needsReplace,
  previewCounts,
  type ImportPreview,
} from "./codingImport";

const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  ok: true,
  files: 3,
  connections: 2,
  errors: [],
  existing: [],
  nodes: [],
  edges: [],
  ...over,
});

describe("what to send for an import", () => {
  it("asks for something to import", () => {
    for (const text of ["", "   \n "])
      expect(importInput(text)).toEqual({ ok: false, problem: expect.stringMatching(/first/) });
  });

  it("sends a JSON object as an object", () => {
    expect(importInput('  {"nodes": []} ')).toEqual({ ok: true, plan: { nodes: [] } });
  });

  it("sends anything else as text, for the server to find the plan in", () => {
    const reply = 'Sure! ```json\n{"nodes": []}\n``` Enjoy.';
    expect(importInput(reply)).toEqual({ ok: true, plan: reply });
    expect(importInput("[1, 2]")).toEqual({ ok: true, plan: "[1, 2]" });
    expect(importInput("not json")).toEqual({ ok: true, plan: "not json" });
  });

  it("refuses something too big to be a plan", () => {
    const result = importInput("x".repeat(MAX_IMPORT_BYTES + 1));
    expect(result.ok).toBe(false);
    expect(importInput("x".repeat(MAX_IMPORT_BYTES)).ok).toBe(true);
  });

  it("counts the paste in bytes, as the server does", () => {
    // "é" is two bytes: half a million of them are a megabyte.
    const accents = "é".repeat(MAX_IMPORT_BYTES / 2 + 1);
    expect(accents.length).toBeLessThan(MAX_IMPORT_BYTES);
    expect(importInput(accents).ok).toBe(false);
    expect(importInput("é".repeat(MAX_IMPORT_BYTES / 2)).ok).toBe(true);
    expect(utf8Bytes("a€😀")).toBe(1 + 3 + 4);
  });

  it("resets a board that has moved only after the user confirms it", () => {
    expect(applyRequest(true, false)).toBeNull();
    expect(applyRequest(true, true)).toEqual({ replace: true });
    expect(applyRequest(false, false)).toEqual({ replace: false });
  });

  it("refuses a picked file over the limit before reading it", () => {
    expect(importFileProblem({ name: "plan.json", size: MAX_IMPORT_BYTES + 1 })).toMatch(
      /^plan\.json: .*1 MB/,
    );
    expect(importFileProblem({ name: "plan.json", size: MAX_IMPORT_BYTES })).toBeNull();
  });
});

describe("the preview", () => {
  it("can be applied only when the server understood a plan with files in it", () => {
    expect(canApplyImport(preview())).toBe(true);
    expect(canApplyImport(null)).toBe(false);
    expect(canApplyImport(preview({ ok: false }))).toBe(false);
    expect(canApplyImport(preview({ errors: ["nodes[2]: the purpose is empty."] }))).toBe(false);
    expect(canApplyImport(preview({ files: 0 }))).toBe(false);
  });

  it("counts with the right plurals", () => {
    expect(previewCounts(preview())).toBe("3 files and 2 connections");
    expect(previewCounts(preview({ files: 1, connections: 1 }))).toBe("1 file and 1 connection");
    expect(previewCounts(preview({ files: 0, connections: 0 }))).toBe("0 files and 0 connections");
  });

  it("warns about files that already exist, and says how many it left out", () => {
    expect(existingWarning([])).toBeNull();
    expect(existingWarning(["a.py"])).toBe(
      "1 file already exists in the output folder and the Developer would change it: a.py.",
    );
    const many = Array.from({ length: 11 }, (_, i) => `f${i}.py`);
    const warning = existingWarning(many)!;
    expect(warning).toContain("11 files already exist");
    expect(warning).toContain("f7.py and 3 more.");
    expect(warning).not.toContain("f8.py");
  });
});

describe("an import that needs a reset", () => {
  it("is a 409 that says so", () => {
    expect(needsReplace(new ApiRequestError(409, null, { message: "x", needsReplace: true }))).toBe(true);
  });

  it("is not any other answer", () => {
    expect(needsReplace(new ApiRequestError(409, null, { message: "x" }))).toBe(false);
    expect(needsReplace(new ApiRequestError(400, null, { message: "x", needsReplace: true }))).toBe(false);
    expect(needsReplace(new ApiRequestError(409, null, null))).toBe(false);
    expect(needsReplace(new Error("boom"))).toBe(false);
  });

  it("keeps the server's message for an answer ApiError can't read", () => {
    expect(new ApiRequestError(409, null, { message: "Cards have moved." }).message).toBe(
      "Cards have moved.",
    );
    expect(new ApiRequestError(500, null, null).message).toBe("Request failed (500)");
  });
});

import { describe, expect, it } from "vitest";

import { plainError } from "./plain-error";

const err = (code: string, message = "", retryable = true) => plainError({ code, message, retryable });

describe("plain error messages", () => {
  it("says what happened in a sentence, for every code the app can produce", () => {
    const codes = [
      "provider_down",
      "model_missing",
      "invalid_key",
      "quota",
      "oom",
      "timeout",
      "stalled",
      "needs_vision",
      "bad_output",
      "bad_request",
      "interrupted",
      "unreadable",
      "unknown",
    ];
    for (const code of codes) {
      const result = err(code, "HTTP 500 internal");
      expect(result.title.length, code).toBeGreaterThan(8);
      expect(result.title, code).not.toMatch(/HTTP|ECONN|undefined|\[object/);
    }
  });

  it("offers the actions that fit", () => {
    expect(err("provider_down").actions).toEqual(["retry", "settings-model"]);
    expect(err("invalid_key").actions).toEqual(["settings-providers"]);
    expect(err("model_missing").actions).toEqual(["switch-model", "settings-model"]);
    expect(err("stalled").actions).toEqual(["retry", "switch-model"]);
    expect(err("oom").actions).toEqual(["switch-model", "settings-model"]);
  });

  it("never offers Try again when it isn't safe or isn't the latest reply", () => {
    for (const code of ["provider_down", "quota", "timeout", "stalled", "bad_output", "unknown"])
      expect(err(code, "x", false).actions, code).not.toContain("retry");
    // The other ways out are still there.
    expect(err("stalled", "", false).actions).toEqual(["switch-model"]);
    expect(err("provider_down", "", false).actions).toEqual(["settings-model"]);
  });

  it("offers no Try again for a reply cut off by a restart, however it is called", () => {
    const cut = err("interrupted", "The app closed while deploy was running", true);
    expect(cut.actions).toEqual([]);
    expect(cut.hint).toMatch(/Check before asking again/);
  });

  it("keeps the original text as details instead of dropping it", () => {
    const result = err("provider_down", "Ollama: connect ECONNREFUSED 127.0.0.1:11434");
    expect(result.detail).toBe("Ollama: connect ECONNREFUSED 127.0.0.1:11434");
    expect(result.title).not.toContain("ECONNREFUSED");
  });

  it("reads trouble in text it has no code for", () => {
    expect(err("unknown", "request to http://x failed, reason: connect ECONNREFUSED").title).toMatch(
      /couldn't connect/,
    );
    expect(err("unknown", "fetch failed").title).toMatch(/couldn't connect/);
    expect(err("unknown", "429 Too Many Requests").title).toMatch(/limiting requests/);
    expect(err("unknown", "Provider returned 503 Service Unavailable").title).toMatch(/problem on its side/);
  });

  it("tells a full context from other bad requests, whatever the code", () => {
    for (const code of ["bad_request", "unknown", "provider_down"]) {
      const result = err(code, "This model's maximum context length is 8192 tokens");
      expect(result.title, code).toMatch(/longer than the model can take/);
      expect(result.actions, code).not.toContain("retry");
    }
  });

  it("hides stack traces and error class names behind a general sentence", () => {
    const trace = "TypeError: Cannot read properties of undefined (reading 'x')\n    at foo (/app/a.js:10:5)";
    const result = err("unknown", trace);
    expect(result.title).toBe("Something went wrong.");
    expect(result.detail).toContain("TypeError");
  });

  it("shows a short plain sentence from the app as it is", () => {
    const result = err("unknown", "No model is selected. Pick a shared model in Settings → Local model.");
    expect(result.title).toBe("No model is selected. Pick a shared model in Settings → Local model.");
    expect(result.detail).toBeNull();
  });
});

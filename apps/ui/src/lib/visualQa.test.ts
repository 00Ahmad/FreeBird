import { describe, expect, it } from "vitest";

import type { ModelInfo } from "@mrog/shared";

import { visualQaWarning } from "./visualQa";

const model = (ref: string, capabilities: ModelInfo["capabilities"]): ModelInfo => ({
  ref,
  providerId: "ollama",
  id: ref.split(":").slice(1).join(":"),
  label: ref.split(":").slice(1).join(":"),
  capabilities,
  contextWindow: null,
  sizeBytes: null,
  loaded: false,
});

const roles = (qa: string | null) => ({
  roles: {
    planner: { botId: "bot_p", model: null },
    developer: { botId: "bot_d", model: null },
    qa: { botId: "bot_q", model: qa },
  },
});

describe("the Visual QA warning", () => {
  const models = [
    model("ollama:qwen3.5:9b", ["completion", "tools", "vision"]),
    model("ollama:coder:7b", ["completion", "tools"]),
  ];

  it("says nothing when QA's model sees pictures, its own or the shared one", () => {
    expect(visualQaWarning(roles("ollama:qwen3.5:9b"), null, models)).toBeNull();
    expect(visualQaWarning(roles(null), "ollama:qwen3.5:9b", models)).toBeNull();
  });

  it("says what is lost with a model that can't see pictures", () => {
    expect(visualQaWarning(roles("ollama:coder:7b"), "ollama:qwen3.5:9b", models)).toContain(
      "QA's model (coder:7b) can't see pictures",
    );
  });

  it("asks for a model when QA has none, and doesn't guess about one it can't find", () => {
    expect(visualQaWarning(roles(null), null, models)).toContain("QA has no model yet");
    expect(visualQaWarning(roles("ollama:gone:1b"), null, models)).toBeNull();
  });
});

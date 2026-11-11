import { describe, expect, it } from "vitest";

import { toAnthropicMessages, type ChatMessage } from ".";

describe("Anthropic requests start with the user", () => {
  it("adds an opening user message when the history begins with the bot", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "Hello, I am Ada." },
      { role: "user", content: "hi" },
    ];
    expect(toAnthropicMessages(history).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "(conversation start)" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello, I am Ada." }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("leaves a history that already starts with the user alone", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(toAnthropicMessages(history).messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
  });

  it("still merges tool results into the user turn after an assistant start", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", arguments: {} }] },
      { role: "tool", toolCallId: "t1", name: "x", content: "result" },
    ];
    const { messages } = toAnthropicMessages(history);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2]?.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "result" }]);
  });
});

import { describe, expect, it } from "vitest";

import { SseParser } from "./sse";

describe("SseParser", () => {
  it("parses complete frames and keeps partial ones for later", () => {
    const parser = new SseParser();
    expect(parser.push("id: 1\nevent: a\nda")).toEqual([]);
    expect(parser.push('ta: {"x":1}\n\nid: 2\n')).toEqual([{ id: "1", event: "a", data: '{"x":1}' }]);
    expect(parser.push("data: two\n\n")).toEqual([{ id: "2", data: "two" }]);
  });

  it("joins multi-line data, skips comments, reads retry", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\n\nretry: 1500\n\ndata: a\ndata: b\n\n")).toEqual([
      { retry: 1500, data: "" },
      { data: "a\nb" },
    ]);
  });

  it("handles CRLF split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push("data: x\r")).toEqual([]);
    expect(parser.push("\n\r\n")).toEqual([{ data: "x" }]);
  });
});

import { describe, expect, it } from "vitest";

import type { Message } from "@mrog/shared";

import { shortRole } from "../components/discussion/RoundTable";
import { discussionSources, linksIn, liveActivity, messageLinks } from "./discussion";

const message = (over: Partial<Message>): Message => ({
  id: "msg_1",
  threadId: "thr_1",
  role: "bot",
  botId: "bot_a",
  moderator: false,
  parallel: false,
  parts: [],
  status: "done",
  model: null,
  usage: null,
  replyToId: null,
  reactions: [],
  createdAt: "2026-11-03T10:00:00.000Z",
  ...over,
});

describe("discussion view helpers", () => {
  it("finds linked addresses in Markdown links and bare text, once each", () => {
    expect(
      linksIn("See [the report](https://a.org/r). Also https://b.com/x, and https://a.org/r again."),
    ).toEqual(["https://a.org/r", "https://b.com/x"]);
  });

  it("keeps balanced parentheses in an address", () => {
    expect(
      linksIn(
        "[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)) and (https://en.wikipedia.org/wiki/Venus_(planet)).",
      ),
    ).toEqual([
      "https://en.wikipedia.org/wiki/Mercury_(planet)",
      "https://en.wikipedia.org/wiki/Venus_(planet)",
    ]);
  });

  it("scans each message object for links once", () => {
    const first = message({ parts: [{ type: "text", text: "See https://a.org" }] });
    expect(messageLinks(first)).toBe(messageLinks(first));
    const grown = {
      ...first,
      parts: [{ type: "text" as const, text: "See https://a.org and https://b.org" }],
    };
    expect(messageLinks(grown)).toEqual(["https://a.org", "https://b.org"]);
  });

  it("lists sources with who used them, cited ones before ones only opened", () => {
    const names = new Map([["bot_a", "Ada"]]);
    const sources = discussionSources(
      [
        message({
          parts: [
            {
              type: "tool",
              callId: "c1",
              name: "fetch_url",
              args: { url: "https://opened.org/p" },
              status: "done",
            },
            { type: "text", text: "Per [this](https://www.cited.com/a) it works." },
          ],
        }),
      ],
      names,
    );
    expect(sources).toEqual([
      { url: "https://www.cited.com/a", host: "cited.com", by: ["Ada"], cited: true },
      { url: "https://opened.org/p", host: "opened.org", by: ["Ada"], cited: false },
    ]);
  });

  it("says what a speaking bot is doing", () => {
    const running = (name: string, args: Record<string, unknown>) =>
      message({ status: "streaming", parts: [{ type: "tool", callId: "c", name, args, status: "running" }] });
    expect(liveActivity(running("web_search", { query: "4-day week" }))).toBe("Searching: “4-day week”");
    expect(liveActivity(running("browser_open", { url: "https://www.example.com/a" }))).toBe(
      "Reading example.com",
    );
    expect(liveActivity(message({ status: "streaming", parts: [{ type: "text", text: "Hi" }] }))).toBe(
      "Writing…",
    );
    expect(liveActivity(undefined)).toBe("Getting ready…");
  });

  it("shortens a role to the label under a seat", () => {
    expect(shortRole("growth marketer — runs the trial")).toBe("Growth marketer");
    expect(shortRole("Skeptic: checks every source")).toBe("Skeptic");
    expect(shortRole("the one who argues for spending more on ads")).toBe("The one who argues…");
    expect(shortRole(null)).toBeNull();
  });
});

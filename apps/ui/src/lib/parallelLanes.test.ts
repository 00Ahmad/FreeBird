import { describe, expect, it } from "vitest";

import { groupByLane, type Bot, type ToolInfo } from "@mrog/shared";

import {
  FINISHING,
  FRAMES,
  MEMORY_NOTE,
  NO_LIMITS,
  SEARCH_RESULT,
  failure,
  heading,
  text,
  tool,
} from "./parallelFixture";
import {
  canAllowTools,
  laneCardState,
  laneLayout,
  laneSources,
  laneToolTitle,
  parallelLabel,
  parallelSwitchTip,
  parallelView,
  hasLanes,
  SEPARATE_ON_CLOUD_HINT,
  SEPARATE_ON_CLOUD_LABEL,
  parseBounded,
  sendsParallelTools,
  splitHeading,
  splitShared,
  stepsText,
  TOOLS_TIP,
  toolsSwitchTip,
} from "./parallelLanes";

const MAX = 6;
const lane = (
  n: 1 | 2 | 3,
  parts: ReturnType<typeof text>[],
  status: "streaming" | "done" | "error" | "stopped" = "streaming",
) => laneCardState(groupByLane(parts).lanes[n - 1]!, n, MAX, status);

describe("a lane's heading", () => {
  it("reads the role from the heading, numbered or not", () => {
    expect(splitHeading("## 1. Financial planner\nAnswer")).toEqual({
      name: "Financial planner",
      named: true,
      rest: "Answer",
    });
    expect(splitHeading("## Lawyer\n\nFirst.\nSecond.")).toEqual({
      name: "Lawyer",
      named: true,
      rest: "First.\nSecond.",
    });
    expect(splitHeading("### Role 3: **Neighbour**")).toMatchObject({
      name: "Neighbour",
      named: true,
      rest: "",
    });
    expect(splitHeading("## <Local agent>\nx").name).toBe("Local agent");
  });

  it("copes with a heading still being typed", () => {
    expect(splitHeading("")).toEqual({ name: "", named: false, rest: "" });
    expect(splitHeading("#")).toMatchObject({ named: false });
    expect(splitHeading("##")).toMatchObject({ named: false });
    expect(splitHeading("## Fin")).toMatchObject({ name: "Fin", named: true, rest: "" });
  });

  it("treats text with no heading as all answer", () => {
    expect(splitHeading("  Just an answer.")).toEqual({ name: "", named: false, rest: "Just an answer." });
  });
});

describe("a lane's sources", () => {
  it("takes the url a tool was given and the links in what it returned, once each", () => {
    const parts = [
      tool(
        1,
        "fetch_url",
        { url: "https://www.example.com/page#top" },
        "done",
        "see https://example.com/page and https://other.org/x.",
      ),
      tool(1, "web_search", { query: "q" }, "done", SEARCH_RESULT),
    ];
    expect(laneSources(parts).map((s) => s.host)).toEqual([
      "example.com",
      "other.org",
      "energysavingtrust.org.uk",
      "example.com",
      "forum.example.org",
    ]);
    // example.com/page appears twice (as the argument and in the result) but is one source.
    expect(laneSources(parts).filter((s) => s.url === "https://www.example.com/page")).toHaveLength(1);
  });

  it("ignores text that is not a web link, and leaves out trailing punctuation and fragments", () => {
    const parts = [
      tool(
        1,
        "fetch_url",
        { url: "file:///etc/passwd" },
        "done",
        "javascript:alert(1) ftp://x.org/a mailto:a@b.c",
      ),
      tool(
        1,
        "web_search",
        { query: "https://not-a-url-arg.com" },
        "done",
        "(https://a.org/b), and https://c.org/d?x=1#frag.",
      ),
    ];
    expect(laneSources(parts).map((s) => s.url)).toEqual(["https://a.org/b", "https://c.org/d?x=1"]);
  });

  it("reads only what it is given: another lane's pages never appear", () => {
    const parts = [
      tool(1, "fetch_url", { url: "https://one.example/a" }, "done", "from lane one"),
      tool(2, "fetch_url", { url: "https://two.example/b" }, "done", "from lane two"),
      text(2, "## Two\nAnswer citing https://invented.example/z"),
    ];
    const { lanes } = groupByLane(parts);
    expect(laneSources(lanes[0]!).map((s) => s.host)).toEqual(["one.example"]);
    expect(laneSources(lanes[1]!).map((s) => s.host)).toEqual(["two.example"]);
    // Only tool arguments and results count, not links the model wrote in its own answer.
    expect(laneSources(lanes[1]!).map((s) => s.host)).not.toContain("invented.example");
    expect(laneSources(lanes[2]!)).toEqual([]);
  });

  it("copes with broken input", () => {
    expect(laneSources([])).toEqual([]);
    expect(laneSources([tool(1, "fetch_url", { url: 42 as never }, "running")])).toEqual([]);
    expect(laneSources([tool(1, "fetch_url", { url: "http://" }, "done", "http://:::")])).toEqual([]);
  });
});

describe("a lane's card", () => {
  it("is starting before it has written anything", () => {
    expect(lane(1, [])).toMatchObject({
      name: "Bot 1",
      named: false,
      status: "waiting",
      stepsUsed: 0,
      hasAnswer: false,
    });
  });

  it("has no name yet while the heading is only begun, then takes the role", () => {
    expect(lane(2, [text(2, "#")]).name).toBe("Bot 2");
    expect(lane(2, [text(2, "## Inst")]).name).toBe("Inst");
    expect(lane(2, [text(2, "## 2. Installer")])).toMatchObject({ name: "Installer", status: "waiting" });
  });

  it("searches while a tool runs, counting steps", () => {
    const card = lane(2, [
      text(2, "## 2. Installer"),
      tool(2, "web_search", { query: "a" }, "done", "r"),
      tool(2, "fetch_url", { url: "https://x.org/" }, "running"),
    ]);
    expect(card).toMatchObject({
      status: "searching",
      stepsUsed: 2,
      stepsMax: MAX,
      stepsText: "step 2 of 6",
    });
    expect(card.tools).toHaveLength(2);
  });

  it("still searches between steps when it has tools but no answer yet", () => {
    expect(lane(1, [tool(1, "web_search", { query: "a" }, "done", "r")]).status).toBe("searching");
  });

  it("waits for an approval as searching", () => {
    expect(lane(1, [tool(1, "fetch_url", { url: "http://192.168.0.2/" }, "pending_approval")]).status).toBe(
      "searching",
    );
  });

  it("writes once there is answer text and no tool is running", () => {
    const card = lane(1, [
      text(1, "## Planner\n"),
      tool(1, "web_search", { query: "a" }, "done", "r"),
      text(1, "You may get"),
    ]);
    expect(card).toMatchObject({
      status: "writing",
      hasAnswer: true,
      answer: "You may get",
      name: "Planner",
    });
  });

  it("joins the answer from every text part after the heading", () => {
    const card = lane(1, [
      heading(1, "Planner", "Costs"),
      text(1, "First thoughts."),
      tool(1, "web_search", { query: "a" }, "done", "r"),
      text(1, "  After the search.  "),
    ]);
    expect(card.answer).toBe("First thoughts.\n\nAfter the search.");
  });

  it("is done when the reply has finished with an answer", () => {
    const card = lane(1, [heading(1, "Planner", "Costs"), text(1, "Answer.")], "done");
    expect(card).toMatchObject({ status: "done", focus: "Costs", answer: "Answer." });
  });

  it("is a lane with only tool parts: searching while streaming, failed when the reply ended with no answer", () => {
    const only = [tool(3, "web_search", { query: "a" }, "done", "r")];
    expect(lane(3, only, "streaming")).toMatchObject({
      status: "searching",
      hasAnswer: false,
      name: "Bot 3",
    });
    expect(lane(3, only, "done").status).toBe("failed");
    expect(lane(3, only, "error").status).toBe("failed");
    expect(lane(3, only, "stopped").status).toBe("stopped");
  });

  it("shows a lane's error as that lane's own, and marks it failed even while others run", () => {
    const card = lane(3, [text(3, "## Neighbour"), failure(3, "The search was blocked.")]);
    expect(card).toMatchObject({ status: "failed", error: "The search was blocked." });
    expect(lane(1, [text(1, "## Planner\nok")]).error).toBeNull();
  });

  it("keeps a lane's answer and its error together", () => {
    const card = lane(
      3,
      [heading(3, "N", "Focus"), text(3, "Partial answer"), failure(3, "Stopped by an error")],
      "done",
    );
    expect(card).toMatchObject({ status: "failed", hasAnswer: true, answer: "Partial answer" });
  });

  it("words the step counter", () => {
    expect(stepsText(3, 6)).toBe("step 3 of 6");
    expect(stepsText(0, 6)).toBe("No steps yet (up to 6)");
    expect(stepsText(7, 6)).toBe("step 7 of 6");
    expect(lane(1, [], "streaming").stepsText).toBe("No steps yet (up to 6)");
  });
});

describe("a reply as it streams in", () => {
  const layout = (frame: number, status: "streaming" | "done" = "streaming") =>
    laneLayout(FRAMES[frame]!, MAX, status);

  it("keeps three places for the cards while it streams, filled as the lanes start", () => {
    expect(layout(0).cards).toEqual([null, null, null]);
    const first = layout(1);
    expect(first.cards.map((c) => c && c.name)).toEqual(["Fin", null, null]);
  });

  it("fills the lanes in whatever order their parts were written", () => {
    const { cards } = layout(3);
    expect(cards.map((c) => c?.name)).toEqual(["Financial planner", "Installer", "Neighbour"]);
    expect(cards.map((c) => c?.status)).toEqual(["searching", "searching", "failed"]);
    // Lane 2's search finished before lane 1's began, yet each card has only its own.
    expect(cards[0]!.tools.map((t) => t.args.query)).toEqual(["heat pump grants"]);
    expect(cards[1]!.tools.map((t) => t.args.query)).toEqual(["heat pump install cost"]);
    expect(cards[2]!.tools.map((t) => t.args.url)).toEqual(["https://forum.example.org/t/noise"]);
  });

  it("keeps each lane's sources to its own tools", () => {
    const { cards } = layout(4);
    expect(cards[0]!.sources.map((s) => s.host)).toEqual(["gov.uk"]);
    expect(cards[1]!.sources.map((s) => s.host)).toEqual([
      "energysavingtrust.org.uk",
      "example.com",
      "forum.example.org",
    ]);
    expect(cards[2]!.sources.map((s) => s.host)).toEqual(["forum.example.org"]);
  });

  it("has the lanes writing at the same time", () => {
    const { cards } = layout(4);
    expect(cards.map((c) => c?.status)).toEqual(["writing", "writing", "failed"]);
    expect(cards.map((c) => c?.answer)).toEqual([
      "You may get £7,500 off.",
      "Around £7,000 after the grant.",
      "",
    ]);
  });

  it("shows only the lanes that wrote something once the reply has ended", () => {
    const parts = [text(1, "## One\nA"), text(3, "## Three\nC")];
    const { cards } = laneLayout(parts, MAX, "done");
    expect(cards.map((c) => c?.name)).toEqual(["One", "Three"]);
    expect(cards.map((c) => c?.index)).toEqual([1, 3]);
    // One lane only.
    expect(laneLayout([text(2, "## Solo\nA")], MAX, "done").cards).toHaveLength(1);
    expect(laneLayout([], MAX, "done").cards).toEqual([]);
  });

  it("every frame's parts end up in exactly one card or in the shared notice", () => {
    for (const frame of FRAMES) {
      const { cards, shared } = laneLayout(frame, MAX, "streaming");
      const inCards = cards.reduce((sum, c) => sum + (c ? c.tools.length : 0), 0);
      expect(inCards + shared.length).toBe(
        frame.filter((p) => p.type === "tool" || !("lane" in p) || !p.lane).length,
      );
    }
  });
});

describe("notes above the cards", () => {
  it("separates the unlaned memory note from the lanes", () => {
    const { shared, cards } = laneLayout([MEMORY_NOTE, text(1, "## One\nA")], MAX, "streaming");
    expect(shared).toEqual([MEMORY_NOTE]);
    expect(cards[0]!.name).toBe("One");
    const split = splitShared(shared);
    expect(split.notices).toHaveLength(1);
    expect(split.notices[0]).toMatch(/^Heads up: the model doesn't fit/);
    expect(split.rest).toEqual([]);
  });

  it("keeps other unlaned parts: tool rows and errors stay as they are, text becomes a notice, reasoning is dropped", () => {
    const stray = tool(1, "web_search", { query: "x" });
    const unlaned = { ...stray, lane: undefined } as typeof stray;
    const broke = { type: "error", code: "x", message: "Something broke" } as const;
    const split = splitShared([
      text(undefined, "  "),
      text(undefined, "A word of warning."),
      broke,
      { type: "reasoning", text: "hmm" },
      unlaned,
    ]);
    expect(split.notices).toEqual(["A word of warning."]);
    expect(split.rest).toEqual([broke, unlaned]);
  });
});

describe("the Allow tools switch", () => {
  const bot = (over: Partial<Pick<Bot, "visual" | "tools">> = {}) => ({
    visual: false,
    tools: NO_LIMITS,
    ...over,
  });
  const info = (name: string, over: Partial<ToolInfo> = {}): ToolInfo => ({
    name,
    description: "",
    group: "web",
    enabled: true,
    available: true,
    editable: true,
    heldBy: null,
    ...over,
  });

  it("is available for an ordinary bot", () => {
    expect(canAllowTools(bot())).toEqual({ ok: true, reason: null });
  });

  it("is off for a Visual Bot, with the reason", () => {
    const choice = canAllowTools(bot({ visual: true }));
    expect(choice.ok).toBe(false);
    expect(choice.reason).toMatch(/Visual Bot/);
  });

  it("is off when neither web_search nor fetch_url is allowed", () => {
    const choice = canAllowTools(
      bot({ tools: { allow: null, exclude: ["web_search", "fetch_url"], apps: {} } }),
    );
    expect(choice).toEqual({
      ok: false,
      reason: "This bot has web search and page fetching turned off. Turn one on under Tools in Details.",
    });
    expect(canAllowTools(bot({ tools: { allow: [], exclude: [], apps: {} } })).ok).toBe(false);
    expect(canAllowTools(bot({ tools: { allow: ["read_file"], exclude: [], apps: {} } })).ok).toBe(false);
  });

  it("is on when one of the two is allowed", () => {
    expect(canAllowTools(bot({ tools: { allow: null, exclude: ["web_search"], apps: {} } })).ok).toBe(true);
    expect(canAllowTools(bot({ tools: { allow: ["fetch_url"], exclude: [], apps: {} } })).ok).toBe(true);
    expect(canAllowTools(bot({ tools: { allow: ["web_*"], exclude: [], apps: {} } })).ok).toBe(true);
  });

  it("trusts the Details panel's list when it has loaded", () => {
    expect(
      canAllowTools(bot(), [info("web_search", { enabled: false }), info("fetch_url", { available: false })])
        .ok,
    ).toBe(false);
    expect(canAllowTools(bot(), [info("web_search", { enabled: false }), info("fetch_url")]).ok).toBe(true);
    // A tool the list does not mention falls back to the bot's own lists.
    expect(canAllowTools(bot(), [info("read_file")]).ok).toBe(true);
    expect(
      canAllowTools(bot({ tools: { allow: null, exclude: ["web_search", "fetch_url"], apps: {} } }), [
        info("read_file"),
      ]).ok,
    ).toBe(false);
  });

  it("explains what it does, and why when it cannot be used", () => {
    expect(TOOLS_TIP).toMatch(/on its own, at the same time/);
    expect(TOOLS_TIP).toMatch(/never sees the others' searches/);
    expect(TOOLS_TIP).toMatch(/Slower than one request/);
    const ok = { ok: true, reason: null };
    expect(toolsSwitchTip(ok, false)).toBe(`Allow tools: ${TOOLS_TIP}`);
    expect(toolsSwitchTip(ok, true)).toBe(`Allow tools is on. ${TOOLS_TIP}`);
    expect(toolsSwitchTip({ ok: false, reason: "No tools." }, true)).toBe("Allow tools is off: No tools.");
  });

  it("is sent only with Parallel Bots on, the switch on, and tools allowed", () => {
    const ok = { ok: true, reason: null };
    const no = { ok: false, reason: "x" };
    expect(sendsParallelTools(true, true, ok)).toBe(true);
    expect(sendsParallelTools(false, true, ok)).toBe(false);
    expect(sendsParallelTools(true, false, ok)).toBe(false);
    expect(sendsParallelTools(true, true, no)).toBe(false);
  });
});

describe("a tool row's label", () => {
  const title = (part: ReturnType<typeof tool>) => laneToolTitle(part as never);

  it("is the query for a search and the host for a page", () => {
    expect(title(tool(1, "web_search", { query: "heat pump grants" }))).toBe("web_search: heat pump grants");
    expect(title(tool(1, "fetch_url", { url: "https://www.gov.uk/boiler-upgrade-scheme?x=1" }))).toBe(
      "fetch_url: gov.uk",
    );
  });

  it("cuts a long query and copes with a url that is not one", () => {
    expect(title(tool(1, "web_search", { query: "x".repeat(100) }))).toBe(`web_search: ${"x".repeat(60)}…`);
    expect(title(tool(1, "fetch_url", { url: "not a url" }))).toBe("fetch_url: not a url");
    expect(title(tool(1, "fetch_url", { url: "y".repeat(80) }))).toBe(`fetch_url: ${"y".repeat(40)}…`);
    expect(title(tool(1, "web_search", {}))).toBe("web_search");
  });
});

describe("the Parallel Bots number settings", () => {
  it("takes whole numbers in range", () => {
    expect(parseBounded("3", 1, 3)).toBe(3);
    expect(parseBounded(" 10 ", 1, 10)).toBe(10);
    expect(parseBounded("1", 1, 10)).toBe(1);
  });

  it("refuses the rest", () => {
    for (const typed of ["", "0", "4", "-1", "2.5", "abc", "1e1", "010x"])
      expect(parseBounded(typed, 1, 3), typed).toBeNull();
    expect(parseBounded("11", 1, 10)).toBeNull();
  });
});

describe("a lane the server marked finished", () => {
  it("shows Done at once for lanes 1 and 2 while lane 3 is still writing", () => {
    const { cards } = laneLayout(FINISHING, MAX, "streaming");
    expect(cards.map((c) => c?.status)).toEqual(["done", "no_answer", "writing"]);
    expect(cards.map((c) => c?.finished)).toEqual([true, true, false]);
    expect(cards[0]!.answer).toBe("You may get £7,500 off.");
  });

  it("is No answer when it finished without writing one, and Stopped when the reply was stopped", () => {
    const parts = [
      heading(2, "Installer", "Fitting", true),
      tool(2, "web_search", { query: "a" }, "done", "r"),
    ];
    expect(lane(2, parts, "streaming").status).toBe("no_answer");
    expect(lane(2, parts, "done").status).toBe("no_answer");
    expect(lane(2, parts, "stopped").status).toBe("stopped");
  });

  it("is Failed when it finished with an error, answer or not", () => {
    expect(lane(3, [heading(3, "N", "F", true), failure(3, "Blocked")], "streaming")).toMatchObject({
      status: "failed",
      error: "Blocked",
    });
    expect(lane(3, [heading(3, "N", "F", true), text(3, "Half"), failure(3, "Blocked")]).status).toBe(
      "failed",
    );
  });

  it("keeps today's behaviour without the mark: Writing until the message ends", () => {
    const parts = [heading(1, "Planner", "Costs"), text(1, "Answer.")];
    expect(lane(1, parts, "streaming").status).toBe("writing");
    expect(lane(1, parts, "done").status).toBe("done");
  });

  it("reads the focus under the heading as the subtitle, not as answer", () => {
    const card = lane(1, [heading(1, "Financial planner", "Grants and running costs")]);
    expect(card).toMatchObject({
      name: "Financial planner",
      focus: "Grants and running costs",
      hasAnswer: false,
    });
    // While the focus is still being typed.
    expect(lane(1, [text(1, "## 1. Planner" + String.fromCharCode(10) + "Gra")]).focus).toBe("Gra");
    expect(lane(1, [text(1, "## 1. Planner")]).focus).toBe("");
    // Text with no heading has no focus: it is all answer.
    expect(lane(1, [text(1, "Plain answer")])).toMatchObject({ focus: "", answer: "Plain answer" });
  });

  it("gives tool ids per lane, so no two lanes share one", () => {
    const ids = FINISHING.flatMap((p) => (p.type === "tool" ? [p.callId] : []));
    expect(ids.every((id) => /^L[1-3]-/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("which view a Parallel Bots reply gets", () => {
  const reply = (
    parts: ReturnType<typeof text>[],
    over: { parallel?: boolean; parallelTools?: boolean } = {},
  ) => ({
    parallel: true,
    parallelTools: false,
    parts,
    ...over,
  });

  it("is lane cards when the parts carry lanes, with or without tools", () => {
    expect(parallelView(reply([heading(1, "Planner", "Costs")]))).toBe("lanes");
    expect(parallelView(reply([MEMORY_NOTE, text(3, "x")]))).toBe("lanes");
    expect(parallelView(reply([], { parallelTools: true }))).toBe("lanes");
    expect(hasLanes(FINISHING)).toBe(true);
  });

  it("is sections for the older single reply of a local model", () => {
    const old = ["## 1. A", "x", "## 2. B", "y"].join("\n");
    expect(parallelView(reply([text(undefined, old)]))).toBe("sections");
    // Nothing written yet, and no tools: it can't be told apart, so it starts as the older reply.
    expect(parallelView(reply([]))).toBe("sections");
    expect(hasLanes([MEMORY_NOTE])).toBe(false);
  });

  it("is an ordinary reply otherwise", () => {
    expect(parallelView(reply([text(undefined, "Hi")], { parallel: false }))).toBe("plain");
  });

  it("labels your message", () => {
    expect(parallelLabel({ parallelTools: false })).toBe("Parallel Bots");
    expect(parallelLabel({ parallelTools: true })).toBe("Parallel Bots with tools");
  });
});

describe("a lane card without tools", () => {
  const card = (
    parts: ReturnType<typeof text>[],
    status: "streaming" | "done" | "error" | "stopped" = "streaming",
  ) => laneCardState(groupByLane(parts).lanes[0]!, 1, MAX, status, false);

  it("has no tool rows, step counter or sources", () => {
    const state = card([heading(1, "Planner", "Costs"), text(1, "Answer")]);
    expect(state).toMatchObject({ withTools: false, tools: [], sources: [], stepsUsed: 0, focus: "Costs" });
    // Even if a tool part turned up, it is not drawn or counted.
    const stray = card([
      heading(1, "Planner", "Costs"),
      tool(1, "fetch_url", { url: "https://x.org/" }, "running"),
    ]);
    expect(stray).toMatchObject({ tools: [], sources: [], stepsUsed: 0, status: "waiting" });
  });

  it("is Starting, Writing, Done, No answer, Failed or Stopped", () => {
    expect(card([heading(1, "Planner", "Costs")]).status).toBe("waiting");
    expect(card([heading(1, "Planner", "Costs"), text(1, "Ans")]).status).toBe("writing");
    expect(card([heading(1, "Planner", "Costs", true), text(1, "Ans")]).status).toBe("done");
    expect(card([heading(1, "Planner", "Costs", true)]).status).toBe("no_answer");
    expect(card([heading(1, "Planner", "Costs", true), failure(1, "Rate limited")]).status).toBe("failed");
    expect(card([heading(1, "Planner", "Costs")], "stopped").status).toBe("stopped");
    expect(card([heading(1, "Planner", "Costs"), text(1, "Ans")], "done").status).toBe("done");
  });

  it("lays out the cards without tools", () => {
    const { cards } = laneLayout(
      [heading(1, "A", "a", true), text(1, "one"), heading(2, "B", "b"), text(2, "tw")],
      MAX,
      "streaming",
      false,
    );
    expect(cards.map((c) => c && [c.status, c.withTools])).toEqual([
      ["done", false],
      ["writing", false],
      null,
    ]);
    expect(laneLayout(FINISHING, MAX, "streaming").cards[0]!.withTools).toBe(true);
  });
});

describe("the Parallel switch and setting", () => {
  it("promises three answers from three roles, not one request", () => {
    expect(parallelSwitchTip(false)).toBe("Parallel Bots: ask once and get three answers from three roles");
    expect(parallelSwitchTip(true)).toBe(
      "Parallel Bots is on: each message gets three answers from three roles. Click to turn it off",
    );
    for (const on of [true, false]) expect(parallelSwitchTip(on)).not.toMatch(/one request/);
  });

  it("explains the cloud setting", () => {
    expect(SEPARATE_ON_CLOUD_LABEL).toBe("Parallel Bots on cloud models: ask each role separately");
    expect(SEPARATE_ON_CLOUD_HINT).toBe(
      "Faster, and the three roles can't echo each other; uses about three times the input tokens. Off: one request with three sections, like local models.",
    );
  });
});

import type { BotTools, MessagePart, ToolStatus } from "@mrog/shared";

/** Parts the way the harness writes a Parallel Bots reply with tools: one flat list, each part tagged with its lane. */

type Lane = 1 | 2 | 3;

export const text = (lane: Lane | undefined, body: string): MessagePart => ({
  type: "text",
  text: body,
  ...(lane ? { lane } : {}),
});

/** A lane's heading part (`## n. Role` and its focus line); `done` marks the role finished, as the server does. */
export const heading = (lane: Lane, role: string, focus: string, done = false): MessagePart => ({
  type: "text",
  text: `## ${lane}. ${role}\n${focus}`,
  lane,
  ...(done ? { laneDone: true } : {}),
});

export const tool = (
  lane: Lane,
  name: "web_search" | "fetch_url",
  args: Record<string, unknown>,
  status: ToolStatus = "done",
  result?: string,
): MessagePart => ({
  type: "tool",
  lane,
  // The harness prefixes tool call ids with the lane, so they never clash across lanes.
  callId: `L${lane}-${name}:${JSON.stringify(args)}`,
  name,
  args,
  status,
  ...(result === undefined ? {} : { result }),
});

export const failure = (lane: Lane, message: string): MessagePart => ({
  type: "error",
  code: "lane_failed",
  message,
  lane,
});

export const SEARCH_RESULT = [
  "1. Heat pumps explained - https://www.energysavingtrust.org.uk/heat-pumps/ - how they work",
  "2. Costs in 2026 (https://example.com/costs#table), updated monthly.",
  "3. Forum thread: https://forum.example.org/t/heat-pump-noise?page=2.",
].join("\n");

/** The note the harness may put at the top when memory looks tight. */
export const MEMORY_NOTE = text(
  undefined,
  "Heads up: the model doesn't fit on the graphics card, so three roles at once will be slow. A smaller context size in Settings may help.",
);

/**
 * A reply as it grows, frame by frame, as the screen receives it: lane 2 starts searching before lane 1 has written
 * its heading, the lanes interleave, and lane 3 fails.
 */
export const FRAMES: MessagePart[][] = [
  [],
  [text(1, "## Fin")],
  [
    heading(1, "Financial planner", "Grants and running costs"),
    heading(2, "Installer", "What fitting one involves"),
    tool(2, "web_search", { query: "heat pump install cost" }, "running"),
  ],
  [
    heading(1, "Financial planner", "Grants and running costs"),
    heading(2, "Installer", "What fitting one involves"),
    tool(2, "web_search", { query: "heat pump install cost" }, "done", SEARCH_RESULT),
    tool(1, "web_search", { query: "heat pump grants" }, "running"),
    heading(3, "Neighbour", "Noise and day-to-day life"),
    tool(3, "fetch_url", { url: "https://forum.example.org/t/noise" }, "error", "HTTP 503"),
    failure(3, "The search was blocked."),
  ],
  [
    heading(1, "Financial planner", "Grants and running costs"),
    heading(2, "Installer", "What fitting one involves"),
    tool(2, "web_search", { query: "heat pump install cost" }, "done", SEARCH_RESULT),
    tool(
      1,
      "web_search",
      { query: "heat pump grants" },
      "done",
      "Grants: https://www.gov.uk/boiler-upgrade-scheme",
    ),
    heading(3, "Neighbour", "Noise and day-to-day life"),
    tool(3, "fetch_url", { url: "https://forum.example.org/t/noise" }, "error", "HTTP 503"),
    failure(3, "The search was blocked."),
    text(2, "Around £7,000 after the grant."),
    text(1, "You may get £7,500 off."),
  ],
];

/**
 * Later in another reply: lane 1 has answered and finished, lane 2 finished without an answer, and lane 3 is still
 * writing. The message itself is still streaming.
 */
export const FINISHING: MessagePart[] = [
  heading(1, "Financial planner", "Grants and running costs", true),
  tool(
    1,
    "web_search",
    { query: "heat pump grants" },
    "done",
    "Grants: https://www.gov.uk/boiler-upgrade-scheme",
  ),
  text(1, "You may get £7,500 off."),
  heading(2, "Installer", "What fitting one involves", true),
  tool(2, "web_search", { query: "heat pump install cost" }, "error", "Search blocked"),
  heading(3, "Neighbour", "Noise and day-to-day life"),
  text(3, "Most are quieter than a fridge"),
];

export const NO_LIMITS: BotTools = { allow: null, exclude: [], apps: {} };

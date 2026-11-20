import { describe, expect, it } from "vitest";

import {
  BotId,
  BotTools,
  compareBots,
  CreateBotInput,
  DEFAULT_BOT_TOOLS,
  DEFAULT_RUNTIME_SETTINGS,
  HarnessEvent,
  MAX_IMAGE_BYTES,
  MessagePart,
  newId,
  nextRun,
  repeatsAction,
  restrictsTools,
  RuntimeSettings,
  SecretName,
  SendMessageInput,
  setToolEnabled,
  toolAllowed,
  UpdateBotInput,
  type Bot,
} from ".";

const bot = (over: Partial<Bot>): Bot => ({
  id: newId("bot"),
  name: "Bot",
  label: null,
  avatar: { shape: "circle", color: "teal" },
  isPrimary: false,
  pinned: false,
  hidden: false,
  model: null,
  instructions: "",
  section: null,
  notifications: true,
  approvalsWait: false,
  coordinator: false,
  parentId: null,
  temporary: false,
  visual: false,
  coding: false,
  job: false,
  client: false,
  clusterId: null,
  tools: DEFAULT_BOT_TOOLS,
  threadId: newId("thr"),
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
  ...over,
});

describe("bot tool lists", () => {
  const tools = (over: Partial<BotTools>): BotTools => ({ ...DEFAULT_BOT_TOOLS, ...over });

  it("allows every tool by default, including ones added later", () => {
    expect(toolAllowed(DEFAULT_BOT_TOOLS, "run_command")).toBe(true);
    expect(toolAllowed(DEFAULT_BOT_TOOLS, "some_new__tool")).toBe(true);
    expect(restrictsTools(DEFAULT_BOT_TOOLS)).toBe(false);
  });

  it("turns off what is excluded, by name or by family", () => {
    const list = tools({ exclude: ["run_command", "gmail__*"] });
    expect(toolAllowed(list, "run_command")).toBe(false);
    expect(toolAllowed(list, "read_file")).toBe(true);
    expect(toolAllowed(list, "gmail__send")).toBe(false);
    expect(toolAllowed(list, "gmail__list")).toBe(false);
    expect(toolAllowed(list, "slack__send")).toBe(true);
    // A name is not a prefix unless it says so.
    expect(toolAllowed(tools({ exclude: ["web"] }), "web_search")).toBe(true);
    expect(restrictsTools(list)).toBe(true);
  });

  it("with an allow list, only those; an empty one means no tools at all", () => {
    const list = tools({ allow: ["read_file", "browser_*"] });
    expect(toolAllowed(list, "read_file")).toBe(true);
    expect(toolAllowed(list, "browser_open")).toBe(true);
    expect(toolAllowed(list, "run_command")).toBe(false);
    expect(toolAllowed(tools({ allow: [] }), "read_file")).toBe(false);
    expect(restrictsTools(tools({ allow: [] }))).toBe(true);
  });

  it("lets exclude win over allow", () => {
    const list = tools({ allow: ["run_command", "read_file"], exclude: ["run_command"] });
    expect(toolAllowed(list, "run_command")).toBe(false);
    expect(toolAllowed(list, "read_file")).toBe(true);
    expect(toolAllowed(tools({ allow: ["gmail__*"], exclude: ["gmail__delete"] }), "gmail__delete")).toBe(
      false,
    );
  });

  it("only accepts names a tool can have, and a * only at the end", () => {
    expect(BotTools.safeParse({ allow: null, exclude: ["run_command", "gmail__*"] }).success).toBe(true);
    for (const bad of ["", " ", "a b", "*", "*x", "a*b", "../x", "x".repeat(101)])
      expect(BotTools.safeParse({ allow: null, exclude: [bad] }).success, JSON.stringify(bad)).toBe(false);
    expect(BotTools.safeParse({ exclude: Array.from({ length: 301 }, (_, i) => `t${i}`) }).success).toBe(
      false,
    );
  });

  it("switching a tool on or off in the panel changes only that name, and never wipes an allow list", () => {
    const withAllow = tools({ allow: ["read_file", "browser_*"], exclude: ["gmail__*"] });
    const off = setToolEnabled(withAllow, "read_file", false);
    expect(off).toEqual({ allow: ["read_file", "browser_*"], exclude: ["gmail__*", "read_file"], apps: {} });
    expect(toolAllowed(off, "read_file")).toBe(false);
    // On again: the name leaves the list, the allow list and the pattern are as they were.
    expect(setToolEnabled(off, "read_file", true)).toEqual(withAllow);
    // Twice is the same as once.
    expect(setToolEnabled(off, "read_file", false)).toEqual(off);
    expect(setToolEnabled(DEFAULT_BOT_TOOLS, "run_command", true)).toEqual(DEFAULT_BOT_TOOLS);
    // A new list each time: the bot's own is not changed in place.
    const original = tools({ exclude: ["a"] });
    setToolEnabled(original, "b", false);
    expect(original.exclude).toEqual(["a"]);
  });

  it("fills in what an older bot or a partial update leaves out", () => {
    expect(BotTools.parse({})).toEqual(DEFAULT_BOT_TOOLS);
    expect(BotTools.parse({ exclude: ["x"] })).toEqual({ allow: null, exclude: ["x"], apps: {} });
    expect(UpdateBotInput.safeParse({ tools: { exclude: ["run_command"] } }).success).toBe(true);
  });
});

describe("replies that must not be repeated", () => {
  const part = (over: object) =>
    ({ type: "tool", callId: "c", name: "x", args: {}, status: "done", ...over }) as never;
  it("flags a reply with a call that acted, or one cut off by a restart, and no other", () => {
    expect(repeatsAction({ parts: [part({ outward: true })] })).toBe(true);
    expect(repeatsAction({ parts: [{ type: "error", code: "interrupted", message: "x" }] })).toBe(true);
    expect(repeatsAction({ parts: [part({ outward: false }), part({})] })).toBe(false);
    expect(repeatsAction({ parts: [{ type: "error", code: "stalled", message: "x" }] })).toBe(false);
    expect(repeatsAction({ parts: [] })).toBe(false);
  });
});

describe("runtime settings for Parallel Bots with tools", () => {
  it("fills in lanes and steps for settings saved before they existed", () => {
    const { parallelLanes, parallelSteps, ...old } = DEFAULT_RUNTIME_SETTINGS;
    expect(parallelLanes).toBe(3);
    expect(parallelSteps).toBe(6);
    expect(RuntimeSettings.parse(old)).toMatchObject({ parallelLanes: 3, parallelSteps: 6 });
    const { parallelSeparateOnCloud, ...older } = DEFAULT_RUNTIME_SETTINGS;
    expect(parallelSeparateOnCloud).toBe(true);
    expect(RuntimeSettings.parse(older).parallelSeparateOnCloud).toBe(true);
  });

  it("keeps lanes between 1 and 3 and steps between 1 and 10", () => {
    expect(RuntimeSettings.safeParse({ ...DEFAULT_RUNTIME_SETTINGS, parallelLanes: 4 }).success).toBe(false);
    expect(RuntimeSettings.safeParse({ ...DEFAULT_RUNTIME_SETTINGS, parallelSteps: 11 }).success).toBe(false);
    expect(RuntimeSettings.safeParse({ ...DEFAULT_RUNTIME_SETTINGS, parallelSteps: 8 }).success).toBe(true);
  });

  it("rejects a part in a lane that doesn't exist", () => {
    expect(MessagePart.safeParse({ type: "text", text: "x", lane: 3 }).success).toBe(true);
    expect(MessagePart.safeParse({ type: "text", text: "x", lane: 4 }).success).toBe(false);
  });
});

describe("ids", () => {
  it("makes prefixed ids that validate", () => {
    const id = newId("bot");
    expect(id).toMatch(/^bot_[0-9a-f]{32}$/);
    expect(BotId.safeParse(id).success).toBe(true);
    expect(BotId.safeParse(newId("evt")).success).toBe(false);
  });
});

describe("bots", () => {
  it("trims names and rejects empty ones", () => {
    expect(CreateBotInput.parse({ name: "  Inbox  " }).name).toBe("Inbox");
    expect(CreateBotInput.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects an empty update", () => {
    expect(UpdateBotInput.safeParse({}).success).toBe(false);
    expect(UpdateBotInput.safeParse({ pinned: true }).success).toBe(true);
  });

  it("orders primary, then pinned, then oldest first", () => {
    const older = bot({ name: "older", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = bot({ name: "newer", createdAt: "2026-02-01T00:00:00.000Z" });
    const pinned = bot({ name: "pinned", pinned: true, createdAt: "2026-03-01T00:00:00.000Z" });
    const primary = bot({ name: "primary", isPrimary: true, createdAt: "2026-04-01T00:00:00.000Z" });
    const sorted = [newer, pinned, older, primary].toSorted(compareBots).map((b) => b.name);
    expect(sorted).toEqual(["primary", "pinned", "older", "newer"]);
  });
});

describe("events", () => {
  it("parses a known event and rejects an unknown type", () => {
    const at = new Date().toISOString();
    expect(HarnessEvent.safeParse({ id: newId("evt"), at, type: "heartbeat" }).success).toBe(true);
    expect(HarnessEvent.safeParse({ id: newId("evt"), at, type: "nope" }).success).toBe(false);
  });
});

describe("secret names", () => {
  it("accepts UPPER_SNAKE_CASE only", () => {
    expect(SecretName.safeParse("OPENAI_API_KEY").success).toBe(true);
    expect(SecretName.safeParse("openai").success).toBe(false);
    expect(SecretName.safeParse("../etc").success).toBe(false);
  });
});

describe("images", () => {
  it("accepts a picture of exactly the size limit, not one byte more", () => {
    const image = (bytes: number) => ({
      text: "",
      images: [{ mediaType: "image/png", data: Buffer.alloc(bytes).toString("base64") }],
    });
    expect(SendMessageInput.safeParse(image(MAX_IMAGE_BYTES)).success).toBe(true);
    expect(SendMessageInput.safeParse(image(MAX_IMAGE_BYTES + 3)).success).toBe(false);
  });
});

describe("one-time routines", () => {
  const trigger = { type: "once" as const, at: "2026-11-05T09:00:00.000Z" };
  const at = new Date(trigger.at);

  it("keep their time after an earlier Run now or an edit", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    expect(nextRun(trigger, now, new Date("2026-11-03T11:00:00Z"))).toEqual(at);
  });

  it("don't run again once they ran at or after their time", () => {
    expect(nextRun(trigger, new Date("2026-11-05T09:00:05Z"), new Date("2026-11-05T09:00:05Z"))).toBeNull();
    expect(nextRun(trigger, new Date("2026-11-06T00:00:00Z"))).toBeNull();
  });
});

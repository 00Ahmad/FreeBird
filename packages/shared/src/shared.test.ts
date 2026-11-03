import { describe, expect, it } from "vitest";

import {
  BotId,
  compareBots,
  CreateBotInput,
  HarnessEvent,
  MAX_IMAGE_BYTES,
  newId,
  nextRun,
  SecretName,
  SendMessageInput,
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
  coordinator: false,
  parentId: null,
  temporary: false,
  visual: false,
  clusterId: null,
  threadId: newId("thr"),
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
  ...over,
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

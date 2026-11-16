import { BUILTIN_SKILLS } from "@mrog/skills";
import { setToolEnabled, SKILL_TOOLS, type Bot } from "@mrog/shared";
import { afterEach, describe, expect, it } from "vitest";

import { auth, makeHarness, type TestHarness } from "../testing";
import { seedBuiltinSkills, skillHash } from "./install";
import { findSkillsTool, useSkillTool } from "./tools";

let h: TestHarness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as TestHarness;
});

const makeBot = async (name: string) =>
  (await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name } })).json()
    .bot as Bot;

describe("built-in skills", () => {
  it("are added once, shared by every bot; one you delete doesn't come back", async () => {
    h = await makeHarness();
    const shared = h.store.skills.list().filter((s) => s.botId === null);
    expect(shared.length).toBe(BUILTIN_SKILLS.length);
    expect(shared.find((s) => s.name === "code-review")!.description).toMatch(/Review code/);
    h.store.skills.delete(shared.find((s) => s.name === "summarize")!.id);
    expect(seedBuiltinSkills(h.store)).toEqual({ added: 0, updated: 0 });
    expect(h.store.skills.list().some((s) => s.name === "summarize")).toBe(false);
  });
});

describe("updating built-in skills", () => {
  it("gives an unedited built-in skill the newer text, and leaves one you edited alone", async () => {
    h = await makeHarness();
    const shared = () => h.store.skills.list().filter((s) => s.botId === null);
    const debug = shared().find((s) => s.name === "debug")!;
    const review = shared().find((s) => s.name === "code-review")!;
    // As if an older version had added older text for both, and you then edited the review one.
    const old = { description: "Old line.", prompt: "Old steps." };
    h.store.skills.update(debug.id, old);
    h.store.skills.update(review.id, { description: "My own line.", prompt: "My own steps." });
    const record = h.store.settings.get<Record<string, string>>("skills.builtin")!;
    h.store.settings.set("skills.builtin", {
      ...record,
      debug: skillHash(old),
      "code-review": skillHash(old),
    });
    expect(seedBuiltinSkills(h.store)).toEqual({ added: 0, updated: 1 });
    expect(shared().find((s) => s.name === "debug")!.prompt).toMatch(/^# Debugging/);
    expect(shared().find((s) => s.name === "code-review")!.prompt).toBe("My own steps.");
  });

  it("treats an early record of names only as added, and never replaces those", async () => {
    h = await makeHarness();
    h.store.settings.set("skills.builtin", ["debug"]);
    const debug = h.store.skills.list().find((s) => s.name === "debug")!;
    h.store.skills.update(debug.id, { prompt: "Old steps." });
    expect(seedBuiltinSkills(h.store)).toEqual({ added: 0, updated: 0 });
    expect(h.store.skills.list().find((s) => s.name === "debug")!.prompt).toBe("Old steps.");
  });
});

describe("a bot using skills by itself", () => {
  it("has the two tools and a line naming its skills, until Can use skills is switched off", async () => {
    h = await makeHarness();
    const bot = await makeBot("Helper");
    const names = h.services.agent.listTools(bot).filter((t) => t.group === "skills");
    expect(names.map((t) => t.name).toSorted()).toEqual([...SKILL_TOOLS].toSorted());
    expect(names.every((t) => t.enabled)).toBe(true);
    const thread = h.store.threads.get(bot.threadId)!;
    const lines = h.services.agent.promptSources.flatMap(
      (s) => s(bot, thread, { delegated: false }).extra ?? [],
    );
    expect(lines.some((l) => l.startsWith("You have skills:") && l.includes("code-review"))).toBe(true);

    let tools = bot.tools;
    for (const name of SKILL_TOOLS) tools = setToolEnabled(tools, name, false);
    const off = { ...bot, tools };
    expect(SKILL_TOOLS.some((name) => h.services.agent.allows(off, name))).toBe(false);
    const after = h.services.agent.promptSources.flatMap(
      (s) => s(off, thread, { delegated: false }).extra ?? [],
    );
    expect(after.some((l) => l.startsWith("You have skills:"))).toBe(false);
  });

  it("finds a skill by what it does and loads it; an unknown name gets close matches", async () => {
    h = await makeHarness();
    const bot = await makeBot("Helper");
    const list = () => h.store.skills.list(bot.id);
    const ctx = {} as never;
    const found = await findSkillsTool(list).run({ query: "review my code" } as never, ctx);
    expect(String(found).split("\n")[0]).toMatch(/^- code-review: /);
    const loaded = String(await useSkillTool(list).run({ name: "/code-review" } as never, ctx));
    expect(loaded).toMatch(/^Skill "code-review"\. Follow these steps/);
    expect(loaded).toContain("## Check before you finish");
    expect(String(await useSkillTool(list).run({ name: "code-revew" } as never, ctx))).toMatch(
      /Did you mean: code-review/,
    );
  });

  it("includes the bot's own skills with the shared ones", async () => {
    h = await makeHarness();
    const bot = await makeBot("Helper");
    h.store.skills.add({
      botId: bot.id,
      name: "standup",
      prompt: "Write my standup.",
      description: "My daily standup.",
    });
    const found = await findSkillsTool(() => h.store.skills.list(bot.id)).run(
      { query: "standup" } as never,
      {} as never,
    );
    expect(found).toBe("- standup: My daily standup.");
  });
});

describe("a team's switch (the Coding Bot's Planner, Developer and QA)", () => {
  it("holds skills off for the bots a bot made when it is switched off on that bot", async () => {
    h = await makeHarness();
    const lead = await makeBot("Lead");
    const role = h.store.bots.create(
      { name: "Lead Developer", tools: { allow: ["read_file", ...SKILL_TOOLS], exclude: [], apps: {} } },
      { parentId: lead.id, temporary: false, section: "Team" },
    );
    expect(SKILL_TOOLS.every((name) => h.services.agent.allows(role, name))).toBe(true);
    let tools = lead.tools;
    for (const name of SKILL_TOOLS) tools = setToolEnabled(tools, name, false);
    h.store.bots.update(lead.id, { tools });
    expect(SKILL_TOOLS.some((name) => h.services.agent.allows(role, name))).toBe(false);
  });
});

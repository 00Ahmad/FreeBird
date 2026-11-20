import { afterEach, describe, expect, it } from "vitest";

import { SKILL_TOOLS } from "@mrog/shared";
import { BUILTIN_SKILLS, pickAssigned } from "@mrog/skills";

import { CODING_ROLE_SKILLS } from "./coding-skills";
import { cleanTmp, codingTeam, makeCoding, post, tmp, type, until } from "./coding-testing";
import { useSkillTool } from "./skills/tools";
import { auth, makeHarness, type TestHarness } from "./testing";

/** Skills given to a Coding Bot's whole team, and to each of its roles. */

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const ONE_FILE = { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] };

const addSkill = (botId: string, name: string, prompt: string) =>
  post(h!, "/api/skills", { botId, name, prompt, description: `${name} for the team` });

describe("a Coding Bot's skills", () => {
  it("gives every role the team's skills, each role its own only, and a role's own wins a name clash", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot, project } = await makeCoding(h, tmp("out"), { autoApprove: true });
    const planner = h.store.bots.get(project.roles.planner.botId)!;
    const developer = h.store.bots.get(project.roles.developer.botId)!;
    const qa = h.store.bots.get(project.roles.qa.botId)!;

    expect((await addSkill(bot.id, "house-style", "Use tabs.")).statusCode).toBe(201);
    expect((await addSkill(developer.id, "small-commits", "Keep changes small.")).statusCode).toBe(201);
    // Same name as a built-in shared skill: the Developer's own is the one it uses.
    expect((await addSkill(developer.id, "code-review", "The Developer's own review.")).statusCode).toBe(201);

    const names = (botId: string) =>
      h!.services.skills.skillsFor(h!.store.bots.get(botId)!).map((skill) => skill.name);
    expect(names(developer.id)).toEqual(
      expect.arrayContaining(["house-style", "small-commits", "code-review"]),
    );
    expect(names(planner.id)).toContain("house-style");
    expect(names(planner.id)).not.toContain("small-commits");
    expect(names(qa.id)).toContain("house-style");
    expect(names(qa.id)).not.toContain("small-commits");
    expect(names(developer.id).filter((name) => name === "code-review")).toHaveLength(1);

    const use = useSkillTool(() => h!.services.skills.skillsFor(developer));
    expect(await use.run({ name: "code-review" }, {} as never)).toContain("The Developer's own review.");
    const plannerUse = useSkillTool(() => h!.services.skills.skillsFor(planner));
    expect(await plannerUse.run({ name: "code-review" }, {} as never)).not.toContain(
      "The Developer's own review.",
    );

    // What each role is told it has, in a real run.
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const system = (role: "planner" | "developer" | "qa") => team.seen.find((s) => s.role === role)!.system;
    expect(system("planner")).toContain("house-style");
    expect(system("planner")).not.toContain("small-commits");
    expect(system("developer")).toMatch(/house-style[\s\S]*small-commits|small-commits[\s\S]*house-style/);
    expect(system("qa")).toContain("house-style");
  });

  it("turns them all off for the roles with the Coding Bot's Can use skills switch", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await addSkill(bot.id, "house-style", "Use tabs.");
    const off = await h.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers: auth,
      payload: { tools: { allow: null, exclude: [...SKILL_TOOLS] } },
    });
    expect(off.statusCode).toBe(200);
    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    for (const role of ["planner", "developer", "qa"] as const) {
      const turn = team.seen.find((s) => s.role === role)!;
      expect(turn.system).not.toContain("house-style");
      expect(turn.system).not.toContain("Skills assigned to you");
      expect(turn.tools).not.toContain("find_skills");
    }
  });
});

describe("skills assigned to a Coding Bot's roles", () => {
  const get = async (botId: string) =>
    (
      await h!.app.inject({ method: "GET", url: `/api/bots/${botId}/assigned-skills`, headers: auth })
    ).json() as {
      names: string[];
      defaults: boolean;
    };

  it("names only built-in skills as a role's defaults", () => {
    for (const names of Object.values(CODING_ROLE_SKILLS))
      expect(pickAssigned(BUILTIN_SKILLS, names)).toHaveLength(names.length);
  });

  it("starts each role with fitting built-in skills, whose steps are in its prompt on every card", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot, project } = await makeCoding(h, tmp("out"), { autoApprove: true });
    for (const role of ["planner", "developer", "qa"] as const)
      expect(await get(project.roles[role].botId)).toEqual({
        names: CODING_ROLE_SKILLS[role],
        defaults: true,
      });
    // The Coding Bot itself works no cards: it has none.
    expect(await get(bot.id)).toEqual({ names: [], defaults: true });

    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const system = (role: "planner" | "developer" | "qa") => team.seen.find((s) => s.role === role)!.system;
    for (const role of ["planner", "developer", "qa"] as const)
      for (const name of CODING_ROLE_SKILLS[role]) expect(system(role)).toContain(`=== Skill: ${name} ===`);
    expect(system("planner")).not.toContain("=== Skill: code-review ===");
    // Still told to finish its own way, and to skip what its job doesn't allow.
    expect(system("qa")).toContain("You are QA");
    expect(system("qa")).toContain("Use a skill's rules, steps and checks only as far as your job allows");
  });

  it("lets you choose a role's skills from the shared ones, and forgets them with the bot", async () => {
    const team = codingTeam({ plans: [{ tool: ONE_FILE }] });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const { bot, project } = await makeCoding(h, tmp("out"), { autoApprove: true });
    const developer = project.roles.developer.botId;
    const put = await h.app.inject({
      method: "PUT",
      url: `/api/bots/${developer}/assigned-skills`,
      headers: auth,
      payload: { names: ["write-tests", "WRITE-TESTS", "no-such-skill"] },
    });
    expect(put.statusCode).toBe(200);
    expect(await get(developer)).toEqual({ names: ["write-tests", "no-such-skill"], defaults: false });

    await type(h, bot, "Make a note");
    await until(h, bot.id, (p) => p.status === "done");
    const system = team.seen.find((s) => s.role === "developer")!.system;
    expect(system).toContain("=== Skill: write-tests ===");
    expect(system).not.toContain("=== Skill: refactor ===");
    expect(system).not.toContain("no-such-skill ===");

    // Emptied on purpose: no defaults come back.
    await h.app.inject({
      method: "PUT",
      url: `/api/bots/${developer}/assigned-skills`,
      headers: auth,
      payload: { names: [] },
    });
    expect(await get(developer)).toEqual({ names: [], defaults: false });

    h.store.bots.delete(developer);
    h.bus.publish({ type: "bot.deleted", botId: developer });
    expect(h.store.settings.get<Record<string, string[]>>("skills.assigned")?.[developer]).toBeUndefined();
  });
});

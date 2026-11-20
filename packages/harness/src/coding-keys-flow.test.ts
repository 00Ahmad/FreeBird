import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanTmp, codingTeam, getProject, makeCoding, tmp, turnsOf, type, until } from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

// Made up, shaped like a TMDB key.
const KEY = "3f9a8c7d6e5b4a3f2e1d0c9b8a7f6e5d";

describe("a key the user gives in the brief", () => {
  it("never reaches a role: the Developer writes its name, and the file on disk gets the key", async () => {
    const plan = {
      nodes: [
        { path: "config.js", purpose: "holds the TMDB key" },
        { path: "app.js", purpose: "shows movies" },
      ],
      edges: [],
    };
    const team = codingTeam({
      plans: [{ tool: plan }],
      develop: (card) =>
        card.key === "config.js"
          ? { write: 'export const TMDB_KEY = "{{TMDB_API_KEY}}";\n' }
          : { write: 'import { TMDB_KEY } from "./config.js";\nconsole.log(TMDB_KEY.length);\n' },
      review: (card) => (card.key === "config.js" ? { pass: true, reads: ["config.js"] } : { pass: true }),
    });
    h = await makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });
    const out = tmp("out");
    const { bot } = await makeCoding(h, out, { autoApprove: true });
    await type(h, bot, `Build a movie list.\nTMDB API Key: ${KEY}`);
    const done = await until(h, bot.id, (p) => p.status === "done");

    // On disk, the real key, where the Developer wrote its name.
    expect(readFileSync(join(out, "config.js"), "utf8")).toBe(`export const TMDB_KEY = "${KEY}";\n`);
    // Nothing a model was sent holds it: not the tasks, not what a file read handed back.
    const sent = team.seen.map((seen) => `${seen.system}\n${seen.task}\n${seen.lastTool}`).join("\n");
    expect(sent).not.toContain(KEY);
    expect(sent).toContain("{{TMDB_API_KEY}}");
    expect(turnsOf(team, "developer")[0]!.task).toContain("write its name exactly, braces included");
    expect(team.seen.some((seen) => seen.lastTool.includes('"{{TMDB_API_KEY}}"'))).toBe(true);
    // The project keeps the brief with the key's name, and the key check doesn't take the key for a made-up one.
    expect(done.brief).toBe("Build a movie list.\nTMDB API Key: {{TMDB_API_KEY}}");
    expect(JSON.stringify(getProject(h, bot.id))).not.toContain(KEY);
    // The Coding Bot's own replies name the key too; only the user's message holds it.
    const replies = h.store.messages
      .list(bot.threadId)
      .filter((message) => message.role === "bot")
      .map((message) => JSON.stringify(message.parts));
    expect(replies.join("\n")).not.toContain(KEY);
  });
});

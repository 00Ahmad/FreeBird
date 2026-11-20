import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cardsFor } from "./coding-plan";
import {
  boot,
  cleanTmp,
  codingTeam,
  freshStore,
  makeCoding,
  post,
  tmp,
  turnsOf,
  until,
} from "./coding-testing";
import type { TestHarness } from "./testing";

/** New plans have a card per file only; a project saved with connection cards still runs them. */

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

describe("a project saved with connection cards", () => {
  it("still works its connection card after a restart, and finishes", async () => {
    const store = freshStore();
    const dataDir = tmp("data");
    const team = codingTeam();
    const first = await boot(store, team.handlers, dataDir);
    const out = tmp("out");
    const { bot, project } = await makeCoding(first, out, { autoApprove: true });
    await first.close();

    // As a project from before: both files built and passed, their connection still in Todo, and the run stopped.
    const nodes = [
      { id: "n1", path: "src/util.ts", purpose: "exports greet" },
      { id: "n2", path: "src/main.ts", purpose: "calls greet" },
    ];
    const edges = [{ id: "e1", files: ["n2", "n1"], description: "main imports greet from util" }];
    const cards = cardsFor(nodes, edges).map((card) => ({
      ...card,
      column: card.kind === "file" ? ("done" as const) : ("todo" as const),
    }));
    mkdirSync(join(out, "src"), { recursive: true });
    writeFileSync(join(out, "src", "util.ts"), "// src/util.ts\n");
    writeFileSync(join(out, "src", "main.ts"), "// src/main.ts\n");
    store.settings.set(`coding:${bot.id}`, {
      ...project,
      status: "stopped",
      brief: "Build a greeter",
      round: 1,
      nodes,
      edges,
      cards,
    });

    h = await boot(store, team.handlers, dataDir);
    expect((await post(h, `/api/bots/${bot.id}/coding/resume`)).statusCode).toBe(200);
    const done = await until(h, bot.id, (p) => p.status === "done");

    expect(done.cards.map((card) => [card.kind, card.column])).toEqual([
      ["file", "done"],
      ["file", "done"],
      ["connector", "done"],
    ]);
    expect(turnsOf(team, "developer").map((turn) => /^Connection: (.+)$/m.exec(turn.task)?.[1])).toEqual([
      "main imports greet from util",
    ]);
    store.close();
  });
});

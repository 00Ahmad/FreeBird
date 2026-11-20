import { afterEach, describe, expect, it } from "vitest";

import type { TestHarness } from "../testing";
import { SAVE_EVERY_MS } from "../teams/state";
import { clientHarness, clientTeam, makeClientBot, projectOf } from "./clients-testing";
import { restoreClientProject, settingsKey } from "./state";

let h: TestHarness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as TestHarness;
});

const NOW = "2026-11-20T10:00:00.000Z";

describe("a saved Client Bot project (5.7)", () => {
  it("is checked when loaded: fields added since get their defaults", async () => {
    h = await clientHarness(clientTeam());
    const { bot, project } = await makeClientBot(h);
    const old = structuredClone(project) as unknown as Record<string, unknown>;
    delete old.notShown;
    delete (old.lookalikes as Record<string, unknown>).matched;
    const restored = restoreClientProject(old, NOW)!;
    expect(restored.notShown).toEqual([]);
    expect(restored.lookalikes.matched).toEqual([]);
    expect(restored.botId).toBe(bot.id);
  });

  it("keeps the profile, the board and your lists when the rest doesn't parse", async () => {
    h = await clientHarness(clientTeam());
    const { project } = await makeClientBot(h);
    const broken = {
      ...structuredClone(project),
      profile: { ...project.profile, offer: "Payroll", areas: ["Leeds"], industries: ["restaurants"] },
      lists: { clients: [{ name: "Acme", domain: null }], competitors: [], doNotContact: [] },
      leads: [{ id: "bad" }],
      scan: { number: "not a number" },
      seen: ["n:acme", 42],
    };
    const restored = restoreClientProject(broken, NOW)!;
    expect(restored.profile.offer).toBe("Payroll");
    expect(restored.lists.clients).toEqual([{ name: "Acme", domain: null }]);
    expect(restored.leads).toEqual([]);
    expect(restored.seen).toEqual(["n:acme"]);
    expect(restored.scan).toBeNull();
    expect(restored.log.at(-1)!.text).toMatch(/another version/);
    expect(restoreClientProject({ botId: "x" }, NOW)).toBeNull();
  });
});

describe("saving a Client Bot project (5.8)", () => {
  it("saves and publishes at most every few hundred milliseconds, and always the last change", async () => {
    h = await clientHarness(clientTeam());
    const { bot } = await makeClientBot(h);
    let published = 0;
    h.services.bus.subscribe((e) => void (e.type === "client.updated" && (published += 1)));
    for (let i = 0; i < 50; i++) h.services.clients.edit(bot.id, (p) => void (p.note = `change ${i}`));
    expect(published).toBeLessThanOrEqual(2);
    // The live project has every change at once; the saved one catches up.
    expect(projectOf(h, bot.id).note).toBe("change 49");
    await new Promise((resolve) => setTimeout(resolve, SAVE_EVERY_MS + 100));
    expect(h.store.settings.get<{ note: string }>(settingsKey(bot.id))!.note).toBe("change 49");
  });
});

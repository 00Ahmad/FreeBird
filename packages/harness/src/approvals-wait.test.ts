import { afterEach, describe, expect, it } from "vitest";

import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("waiting for approvals", () => {
  it("follows the bot's choice, and a helper follows its coordinator's", async () => {
    h = await makeHarness();
    const { store, services } = h;
    const keeps = (botId: string) =>
      services.agent.approvals.keepWaiting.some((keep) => keep(botId, "Run echo hi", 15 * 60_000));
    const boss = store.bots.create({ name: "Boss", isPrimary: true });
    const helper = store.bots.create(
      { name: "Scout" },
      { parentId: boss.id, temporary: true, section: "Helpers" },
    );
    const other = store.bots.create({ name: "Other" });

    // Off by default: the card is dropped after the usual time.
    expect(boss.approvalsWait).toBe(false);
    expect(keeps(boss.id)).toBe(false);
    expect(keeps(helper.id)).toBe(false);

    store.bots.update(boss.id, { approvalsWait: true });
    expect(store.bots.get(boss.id)?.approvalsWait).toBe(true);
    expect(keeps(boss.id)).toBe(true);
    expect(keeps(helper.id)).toBe(true);
    expect(keeps(other.id)).toBe(false);
  });
});

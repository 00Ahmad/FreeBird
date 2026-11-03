import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, messageText, type Bot, type Race, type Thread } from "@mrog/shared";

import { parseWinner, RACE_TOOLS } from "./race";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const reply = (text: string) => ndjson([{ message: { content: text } }, { done: true }]);
const racers = [{ name: "Wren" }, { name: "Kestrel" }, { name: "Robin", model: "ollama:test:1b" }];

interface Seen {
  who: string;
  system: string;
  history: string;
  tools: string[];
}

const ended = (harness: TestHarness, timeoutMs = 10_000) =>
  nextEvent<Race>(
    harness.bus,
    (e) => e.type === "race.updated" && ["done", "stopped", "error"].includes(e.race.status) && e.race,
    timeoutMs,
  );

async function startRace(
  harness: TestHarness,
  body: object = { task: "Name a coffee shop", racers, judge: {} },
) {
  harness.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  return harness.app.inject({ method: "POST", url: "/api/races", headers: auth, payload: body });
}

describe("races", () => {
  it("lets one racer finish on the local model before the next starts", async () => {
    const order: string[] = [];
    const steps = new Map<string, number>();
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        const who = /^You are (\w+)/.exec(system)?.[1] ?? "?";
        order.push(who);
        if (system.includes("You are the judge of a race"))
          return reply("Winner: Wren\n\n## Final result\nDone.");
        const step = (steps.get(who) ?? 0) + 1;
        steps.set(who, step);
        // Each racer plans first, then answers: two model calls per racer.
        if (step === 1)
          return ndjson([
            {
              message: {
                tool_calls: [
                  { function: { name: "update_plan", arguments: { steps: [{ step: "Think" }] } } },
                ],
              },
            },
            { done: true },
          ]);
        return reply(`Strategy: be ${who}-ish.\n${who} says: Bean There.`);
      }),
    });
    expect((await startRace(h)).statusCode).toBe(201);
    expect(await ended(h)).toMatchObject({ status: "done" });

    const racerCalls = order.filter((who) => who !== "Judge");
    expect(racerCalls).toHaveLength(6);
    // With one slot (the default), each racer's two calls come back to back instead of interleaved.
    for (let i = 0; i < racerCalls.length; i += 2) expect(racerCalls[i + 1]).toBe(racerCalls[i]);
    expect(new Set(racerCalls).size).toBe(3);
  });

  it("runs every racer alone on the task, then the judge scores them and compiles the best", async () => {
    const seen: Seen[] = [];
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        const who = /^You are (\w+)/.exec(system)?.[1] ?? "?";
        seen.push({
          who,
          system,
          history: body.messages
            .slice(1)
            .map((m: { content: string }) => m.content)
            .join("\n"),
          tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
        });
        if (system.includes("You are the judge of a race"))
          return reply(
            "## Scores\n| Racer | Total |\n\nWinner: **Kestrel**\n\n## Final result\nBean There (from Kestrel, https://beans.org/Kestrel). [Survey](https://example.com/made-up)",
          );
        return reply(`Strategy: be ${who}-ish.\n${who} says: Bean There. Source: https://beans.org/${who}`);
      }),
    });
    const res = await startRace(h);
    expect(res.statusCode).toBe(201);
    const { thread } = res.json() as { thread: Thread; race: Race };
    expect(thread).toMatchObject({ kind: "group", cluster: true, race: true, title: "Name a coffee shop" });
    const final = await ended(h);

    expect(final).toMatchObject({ status: "done", error: null });
    expect(final.racers.map((racer) => racer.status)).toEqual(["done", "done", "done"]);
    const bots = thread.memberIds.map((id) => h!.store.bots.get(id)!);
    expect(bots.map((bot) => bot.name)).toEqual(["Wren", "Kestrel", "Robin", "Judge"]);
    expect(bots.every((bot) => bot.clusterId === thread.id)).toBe(true);
    expect(bots[2]!.model).toBe("ollama:test:1b");
    expect(final.winnerId).toBe(bots[1]!.id);

    // Each racer saw only the task, never another racer's work, and kept only race tools.
    const racerCalls = seen.filter((call) => call.system.includes("You are racer"));
    expect(racerCalls.map((call) => call.who).toSorted()).toEqual(["Kestrel", "Robin", "Wren"]);
    for (const call of racerCalls) {
      expect(call.history).toContain("Name a coffee shop");
      expect(call.history).not.toContain("says: Bean There");
      for (const tool of call.tools) expect(RACE_TOOLS.has(tool)).toBe(true);
    }
    // The judge got every answer and no tools.
    const judgeCall = seen.find((call) => call.system.includes("You are the judge of a race"))!;
    for (const name of ["Wren", "Kestrel", "Robin"])
      expect(judgeCall.system).toContain(`${name} says: Bean There`);
    expect(judgeCall.tools).toEqual([]);
    const report = messageText(h.store.messages.get(final.reportId!)!);
    expect(report).toContain("## Final result");
    // A racer's real source stays; a link the judge made up is taken out.
    expect(report).toContain("https://beans.org/Kestrel");
    expect(report).toContain("Survey (no address given)");
    expect(report).not.toContain("example.com/made-up");

    const got = await h.app.inject({ url: `/api/threads/${thread.id}/race`, headers: auth });
    expect(got.json().race).toMatchObject({ status: "done", winnerId: bots[1]!.id });
  });

  it("judges early with what's in when asked, and stops entirely on Stop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.includes("You are the judge of a race"))
          return reply("Winner: Wren\n## Final result\nOk.");
        if (system.startsWith("You are Wren")) return reply("Strategy: quick.\nWren's answer.");
        // The others are slow: they're still going when Judge now is pressed.
        await gate;
        return reply("Too late.");
      }),
    });
    const { thread } = (await startRace(h)).json() as { thread: Thread };
    const wrenDone = nextEvent(
      h.bus,
      (e) =>
        e.type === "race.updated" &&
        e.race.racers.some((racer: { status: string }) => racer.status === "done"),
    );
    await wrenDone;
    const done = ended(h);
    const judge = await h.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/race/judge`,
      headers: auth,
    });
    expect(judge.statusCode).toBe(204);
    // The fake model ignores the stop signal, so let the slow racers' requests finish; their turns are stopped.
    release();
    const final = await done;
    expect(final.status).toBe("done");
    expect(final.racers.map((racer) => racer.status).toSorted()).toEqual(["done", "stopped", "stopped"]);

    const again = await h.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/race/judge`,
      headers: auth,
    });
    expect(again.statusCode).toBe(409);
  });

  it("refuses a model that isn't there, and duplicate names", async () => {
    h = await makeHarness();
    const missing = await startRace(h, {
      task: "Anything",
      racers: [{ name: "A" }, { name: "B" }, { name: "C", model: "ollama:nope:1b" }],
      judge: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toContain("ollama:nope:1b");
    const twice = await startRace(h, {
      task: "Anything",
      racers: [{ name: "A" }, { name: "a" }, { name: "C" }],
      judge: {},
    });
    expect(twice.statusCode).toBe(400);
    expect(h.store.threads.list().filter((thread) => thread.race)).toEqual([]);
  });

  it("reads the winner line", () => {
    const bots = [
      { id: "bot_1", name: "Wren" },
      { id: "bot_2", name: "Wren Jr" },
    ] as Bot[];
    expect(parseWinner("## Scores\nWinner: **Wren Jr** — best sources", bots)?.id).toBe("bot_2");
    expect(parseWinner("No winner line", bots)).toBeNull();
  });

  it("reads the winner line however it is formatted, by whole names, first one named", () => {
    const bots = [
      { id: "bot_al", name: "Al" },
      { id: "bot_bo", name: "Bo" },
      { id: "bot_alice", name: "Alice" },
    ] as Bot[];
    expect(parseWinner("**Winner**: Bo", bots)?.id).toBe("bot_bo");
    expect(parseWinner("__Winner:__ Bo", bots)?.id).toBe("bot_bo");
    expect(parseWinner("Winner: Bo, ahead of Alice", bots)?.id).toBe("bot_bo");
    expect(parseWinner("Winner: Bo (total 30)", bots)?.id).toBe("bot_bo");
    expect(parseWinner("Winner: Alice", bots)?.id).toBe("bot_alice");
  });
});

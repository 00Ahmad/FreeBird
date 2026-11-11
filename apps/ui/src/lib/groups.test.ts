import { describe, expect, it } from "vitest";

import type { Thread } from "@mrog/shared";

import { noModelFor, splitGroups } from "./groups";

const thread = (id: string, over: Partial<Thread> = {}) =>
  ({ id, kind: "group", cluster: false, race: false, pair: false, ...over }) as unknown as Thread;

describe("sidebar groups", () => {
  const mine = thread("group");
  const cluster = thread("cluster", { cluster: true });
  // A race is a cluster made for a race.
  const race = thread("race", { cluster: true, race: true });
  const talk = thread("talk", { pair: true });

  it("keeps a coordinator's conversation with a helper out of the group chats", () => {
    const { groupChats, botTalks } = splitGroups([mine, talk]);
    expect(groupChats.map((t) => t.id)).toEqual(["group"]);
    expect(botTalks.map((t) => t.id)).toEqual(["talk"]);
  });

  it("puts races and clusters in their own lists", () => {
    const lists = splitGroups([mine, cluster, race, talk]);
    expect(lists.races.map((t) => t.id)).toEqual(["race"]);
    expect(lists.clusters.map((t) => t.id)).toEqual(["cluster"]);
  });

  it("lists every thread exactly once, in the order it came", () => {
    const all = [talk, race, mine, cluster, thread("later")];
    const lists = splitGroups(all);
    const listed = [...lists.races, ...lists.clusters, ...lists.groupChats, ...lists.botTalks];
    expect(listed.map((t) => t.id).toSorted()).toEqual(all.map((t) => t.id).toSorted());
    expect(lists.groupChats.map((t) => t.id)).toEqual(["group", "later"]);
  });
});

describe("a chat without a model", () => {
  const own = { model: "ollama/llama3" };
  const none = { model: null };

  it("is not one when a shared model is set", () => {
    expect(noModelFor("ollama/llama3", [none])).toBe(false);
    expect(noModelFor("ollama/llama3", [])).toBe(false);
  });

  it("lets a group answer when any member has a model of their own", () => {
    expect(noModelFor(null, [none, own])).toBe(false);
    expect(noModelFor(undefined, [own, own])).toBe(false);
  });

  it("is one when nothing can answer", () => {
    expect(noModelFor(null, [none, none])).toBe(true);
    expect(noModelFor(null, [])).toBe(true);
  });

  it("follows the one bot of a direct chat", () => {
    expect(noModelFor(null, [own])).toBe(false);
    expect(noModelFor(null, [none])).toBe(true);
  });
});

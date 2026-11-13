import { describe, expect, it } from "vitest";

import { buildChecklist } from "./codingChecklist";
import { connectorCard, edge, fileCard, node } from "./codingFixture";

const nodes = [node("a", "src/a.ts"), node("b", "src/b.ts"), node("c", "src/c.ts")];
const edges = [edge("x", ["a", "b"], "a calls b"), edge("y", ["a", "b", "c"], "wiring")];

describe("checklist", () => {
  it("lists every file and every connector, unticked at the start", () => {
    const list = buildChecklist({
      nodes,
      edges,
      cards: [fileCard("a"), fileCard("b"), fileCard("c"), connectorCard("x"), connectorCard("y")],
    });
    expect(list.files.map((f) => [f.path, f.done])).toEqual([
      ["src/a.ts", false],
      ["src/b.ts", false],
      ["src/c.ts", false],
    ]);
    expect(list.connectors.map((c) => [c.label, c.done])).toEqual([
      ["e1", false],
      ["e2", false],
    ]);
    expect(list.summary).toBe("0 of 5 done");
  });

  it("ticks what is in Done, and only that", () => {
    const list = buildChecklist({
      nodes,
      edges,
      cards: [
        fileCard("a", "done"),
        fileCard("b", "qa"),
        fileCard("c", "in_progress"),
        connectorCard("x", "done"),
        connectorCard("y", "todo"),
      ],
    });
    expect(list.files.map((f) => f.done)).toEqual([true, false, false]);
    expect(list.connectors.map((c) => c.done)).toEqual([true, false]);
    expect([list.filesDone, list.connectorsDone, list.done, list.total]).toEqual([1, 1, 2, 5]);
    expect(list.summary).toBe("2 of 5 done");
  });

  it("is complete when everything is Done", () => {
    const list = buildChecklist({
      nodes,
      edges,
      cards: [...nodes.map((n) => fileCard(n.id, "done")), ...edges.map((e) => connectorCard(e.id, "done"))],
    });
    expect(list.summary).toBe("5 of 5 done");
    expect(list.done).toBe(list.total);
  });

  it("shows the files each connector links, in the connector's order", () => {
    const list = buildChecklist({ nodes, edges, cards: [] });
    expect(list.connectors[1]!.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(list.connectors[0]!.description).toBe("a calls b");
  });

  it("counts a plan item with no card as not done, and an empty plan as 0 of 0", () => {
    const list = buildChecklist({ nodes, edges, cards: [fileCard("a", "done")] });
    expect(list.total).toBe(5);
    expect(list.done).toBe(1);
    expect(buildChecklist({ nodes: [], edges: [], cards: [] }).summary).toBe("0 of 0 done");
  });

  it("does not count a card whose file was removed from the plan", () => {
    const list = buildChecklist({
      nodes,
      edges: [],
      cards: [fileCard("a", "done"), fileCard("ghost", "done")],
    });
    expect(list.done).toBe(1);
    expect(list.total).toBe(3);
  });
});

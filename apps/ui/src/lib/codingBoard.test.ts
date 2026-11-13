import { describe, expect, it } from "vitest";

import { CODING_COLUMNS } from "@mrog/shared";

import {
  buildBoard,
  cardsByRef,
  columnLabel,
  COLUMN_COLOR,
  edgeLabels,
  needsFixing,
  progressText,
  relatedRefs,
  sortComments,
} from "./codingBoard";
import { comment, connectorCard, edge, fileCard, node } from "./codingFixture";

const nodes = [node("a", "src/a.ts"), node("b", "src/b.ts"), node("c", "src/c.ts")];
const edges = [edge("x", ["a", "b"]), edge("y", ["a", "b", "c"])];

describe("board columns", () => {
  it("has the four columns in the shared order, with labels and a colour each", () => {
    const board = buildBoard({ nodes: [], edges: [], cards: [] });
    expect(board.map((c) => c.column)).toEqual([...CODING_COLUMNS]);
    expect(board.map((c) => c.label)).toEqual(["Todo", "In progress", "QA", "Done"]);
    expect(board.every((c) => c.count === 0 && c.cards.length === 0)).toBe(true);
    expect(CODING_COLUMNS.map(columnLabel)).toEqual(["Todo", "In progress", "QA", "Done"]);
    expect(new Set(CODING_COLUMNS.map((c) => COLUMN_COLOR[c])).size).toBe(4);
  });

  it("puts each card in its column and counts them", () => {
    const board = buildBoard({
      nodes,
      edges,
      cards: [
        fileCard("a", "done"),
        fileCard("b", "qa"),
        fileCard("c", "todo"),
        connectorCard("x", "todo"),
        connectorCard("y", "in_progress"),
      ],
    });
    const byColumn = Object.fromEntries(board.map((c) => [c.column, c.cards.map((i) => i.card.ref)]));
    expect(byColumn).toEqual({ todo: ["c", "x"], in_progress: ["y"], qa: ["b"], done: ["a"] });
    expect(board.map((c) => c.count)).toEqual([2, 1, 1, 1]);
    // Every card is on the board exactly once.
    expect(board.reduce((sum, c) => sum + c.count, 0)).toBe(5);
  });

  it("keeps the plan's order (files, then connectors) whatever order the cards come in", () => {
    const board = buildBoard({
      nodes,
      edges,
      cards: [connectorCard("y"), fileCard("c"), connectorCard("x"), fileCard("a"), fileCard("b")],
    });
    expect(board[0]!.cards.map((i) => i.card.ref)).toEqual(["a", "b", "c", "x", "y"]);
  });

  it("puts a card the plan doesn't know last instead of dropping it", () => {
    const board = buildBoard({ nodes, edges, cards: [fileCard("ghost"), fileCard("b")] });
    expect(board[0]!.cards.map((i) => i.card.ref)).toEqual(["b", "ghost"]);
    expect(board[0]!.cards[1]!.node).toBeNull();
  });

  it("tells file cards from connector cards and shows the files a connector links", () => {
    const board = buildBoard({ nodes, edges, cards: [fileCard("a"), connectorCard("y")] });
    const [file, connector] = board[0]!.cards;
    expect(file!.node?.path).toBe("src/a.ts");
    expect(file!.edge).toBeNull();
    expect(file!.label).toBeNull();
    expect(file!.linked).toEqual([]);
    expect(connector!.label).toBe("e2");
    expect(connector!.linked.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("shows the id of a linked file the plan no longer has", () => {
    const board = buildBoard({
      nodes: [node("a", "src/a.ts")],
      edges: [edge("x", ["a", "gone"])],
      cards: [connectorCard("x")],
    });
    expect(board[0]!.cards[0]!.linked.map((f) => f.path)).toEqual(["src/a.ts", "gone"]);
  });
});

describe("comments and fixes", () => {
  const early = comment("developer", "first", "2026-01-01T10:00:00.000Z");
  const late = comment("qa", "second", "2026-01-01T11:00:00.000Z");

  it("lists comments oldest first, so the newest is last", () => {
    expect(sortComments([late, early]).map((c) => c.text)).toEqual(["first", "second"]);
  });

  it("keeps the given order for comments written at the same moment", () => {
    const a = comment("qa", "a", "2026-01-01T10:00:00.000Z");
    const b = comment("developer", "b", "2026-01-01T10:00:00.000Z");
    expect(sortComments([a, b]).map((c) => c.text)).toEqual(["a", "b"]);
    expect(sortComments([b, a]).map((c) => c.text)).toEqual(["b", "a"]);
  });

  it("does not change the card's own list", () => {
    const list = [late, early];
    sortComments(list);
    expect(list.map((c) => c.text)).toEqual(["second", "first"]);
  });

  it("marks a Todo card that QA sent back as needing a fix", () => {
    expect(needsFixing(fileCard("a", "todo", [early, late]))).toBe(true);
    expect(needsFixing(fileCard("a", "todo", [late]))).toBe(true);
  });

  it("does not mark a card without a QA comment, or one that is no longer in Todo", () => {
    expect(needsFixing(fileCard("a", "todo", []))).toBe(false);
    expect(needsFixing(fileCard("a", "todo", [early]))).toBe(false);
    expect(needsFixing(fileCard("a", "todo", [comment("user", "please add tests")]))).toBe(false);
    for (const column of ["in_progress", "qa", "done"] as const)
      expect(needsFixing(fileCard("a", column, [late])), column).toBe(false);
  });

  it("carries the flag and the sorted comments onto the board", () => {
    const board = buildBoard({ nodes, edges, cards: [fileCard("a", "todo", [late, early]), fileCard("b")] });
    const [a, b] = board[0]!.cards;
    expect(a!.needsFixing).toBe(true);
    expect(a!.comments.map((c) => c.text)).toEqual(["first", "second"]);
    expect(b!.needsFixing).toBe(false);
  });
});

describe("lookups", () => {
  it("finds a card by the node or edge it is about", () => {
    const map = cardsByRef([fileCard("a"), connectorCard("x")]);
    expect(map.get("a")?.kind).toBe("file");
    expect(map.get("x")?.kind).toBe("connector");
    expect(map.get("nope")).toBeUndefined();
  });

  it("labels edges by place", () => {
    expect([...edgeLabels(edges)]).toEqual([
      ["x", "e1"],
      ["y", "e2"],
    ]);
  });

  it("words progress", () => {
    expect(progressText(3, 7)).toBe("3 of 7 done");
    expect(progressText(0, 0)).toBe("0 of 0 done");
  });
});

describe("what a pick lights up", () => {
  it("is nothing when nothing is picked", () => {
    expect(relatedRefs({ nodes, edges }, null).size).toBe(0);
  });

  it("is a connector and the files it links", () => {
    expect([...relatedRefs({ nodes, edges }, "x")].toSorted()).toEqual(["a", "b", "x"]);
    expect([...relatedRefs({ nodes, edges }, "y")].toSorted()).toEqual(["a", "b", "c", "y"]);
  });

  it("is a file and the connectors that touch it", () => {
    expect([...relatedRefs({ nodes, edges }, "c")].toSorted()).toEqual(["c", "y"]);
    expect([...relatedRefs({ nodes, edges }, "a")].toSorted()).toEqual(["a", "x", "y"]);
  });

  it("is just itself when the plan doesn't know it", () => {
    expect([...relatedRefs({ nodes, edges }, "ghost")]).toEqual(["ghost"]);
  });
});

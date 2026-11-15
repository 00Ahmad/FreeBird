import { describe, expect, it } from "vitest";

import { edge, node } from "./codingFixture";
import {
  clampZoom,
  clipPath,
  fitZoom,
  FILE_H,
  FILE_W,
  JUNCTION_R,
  layoutDiagram,
  MAX_ZOOM,
  MIN_FIT_ZOOM,
  MIN_ZOOM,
  occludedLinks,
  packJunctions,
  pathPoints,
  PER_RANK,
  stepZoom,
  wrapText,
  type DiagramLayout,
} from "./codingLayout";

const ids = (count: number) => Array.from({ length: count }, (_, i) => `n${i + 1}`);
const nodesOf = (count: number) => ids(count).map((id) => node(id));

/** The biggest plan the planner may make: 40 files, 80 connections of three files each. */
const bigEdges = (a = 7, b = 11, count = 40) =>
  Array.from({ length: 80 }, (_, i) =>
    edge(`e${i}`, [`n${(i % count) + 1}`, `n${((i * a + 3) % count) + 1}`, `n${((i * b + 5) % count) + 1}`]),
  );

/** Every node box, junction circle and the picture's edges, checked against each other. */
function expectTidy(layout: DiagramLayout) {
  const { files, junctions } = layout;
  for (let i = 0; i < files.length; i++) {
    const a = files[i]!;
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(layout.width);
    expect(a.y + a.h).toBeLessThanOrEqual(layout.height);
    for (const b of files.slice(i + 1)) {
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  }
  for (let i = 0; i < junctions.length; i++) {
    const j = junctions[i]!;
    expect(j.x - j.r).toBeGreaterThanOrEqual(0);
    expect(j.y - j.r).toBeGreaterThanOrEqual(0);
    expect(j.x + j.r).toBeLessThanOrEqual(layout.width);
    expect(j.y + j.r).toBeLessThanOrEqual(layout.height);
    for (const f of files) {
      const clear = j.x + j.r <= f.x || f.x + f.w <= j.x - j.r || j.y + j.r <= f.y || f.y + f.h <= j.y - j.r;
      expect(clear, `${j.label} touches ${f.id}`).toBe(true);
    }
    for (const other of junctions.slice(i + 1)) {
      const distance = Math.hypot(j.x - other.x, j.y - other.y);
      expect(distance, `${j.label} touches ${other.label}`).toBeGreaterThanOrEqual(j.r + other.r);
    }
  }
}

describe("diagram layout", () => {
  it("draws nothing for an empty plan", () => {
    const layout = layoutDiagram([], []);
    expect(layout).toEqual({ width: 0, height: 0, files: [], junctions: [], links: [] });
  });

  it("draws one file with no edges", () => {
    const layout = layoutDiagram([node("a", "src/a.ts", "Starts the app")], []);
    expect(layout.files).toHaveLength(1);
    expect(layout.junctions).toEqual([]);
    expect(layout.links).toEqual([]);
    const [file] = layout.files;
    expect([file!.w, file!.h]).toEqual([FILE_W, FILE_H]);
    expect(file!.pathText).toBe("src/a.ts");
    expect(file!.purposeLines).toEqual(["Starts the app"]);
    expect(file!.clipped).toBe(false);
    expectTidy(layout);
  });

  it("puts what is built first on the left", () => {
    const layout = layoutDiagram(nodesOf(3), [edge("e", ["n1", "n2"]), edge("f", ["n2", "n3"])]);
    const rank = Object.fromEntries(layout.files.map((f) => [f.id, f.rank]));
    expect(rank).toEqual({ n1: 0, n2: 1, n3: 2 });
    const x = Object.fromEntries(layout.files.map((f) => [f.id, f.x]));
    expect(x.n1!).toBeLessThan(x.n2!);
    expect(x.n2!).toBeLessThan(x.n3!);
    expectTidy(layout);
  });

  it("does not care in which order an edge lists its files", () => {
    const a = layoutDiagram(nodesOf(3), [edge("e", ["n1", "n2", "n3"])]);
    const b = layoutDiagram(nodesOf(3), [edge("e", ["n3", "n1", "n2"])]);
    expect(b).toEqual(a);
  });

  it("is deterministic: the same plan always gives the same picture", () => {
    const edges = [
      edge("e1", ["n1", "n2"]),
      edge("e2", ["n2", "n3", "n4"]),
      edge("e3", ["n1", "n5"]),
      edge("e4", ["n4", "n5", "n6"]),
    ];
    const first = layoutDiagram(nodesOf(6), edges);
    const second = layoutDiagram(
      nodesOf(6),
      edges.map((e) => ({ ...e, files: [...e.files] })),
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("places a junction between the files it joins", () => {
    const layout = layoutDiagram(nodesOf(2), [edge("e", ["n1", "n2"])]);
    const [left, right] = layout.files;
    const [junction] = layout.junctions;
    expect(junction!.label).toBe("e1");
    expect(junction!.x).toBeGreaterThan(left!.x + left!.w);
    expect(junction!.x).toBeLessThan(right!.x);
    expect(junction!.fileIds).toEqual(["n1", "n2"]);
    expect(layout.links.map((l) => [l.edgeId, l.fileId])).toEqual([
      ["e", "n1"],
      ["e", "n2"],
    ]);
    // Each line starts at the side of its file that faces the junction and ends at the junction.
    expect(layout.links[0]!.d).toMatch(new RegExp(`^M ${left!.x + left!.w} ${left!.y + FILE_H / 2} C`));
    expect(layout.links[1]!.d).toMatch(new RegExp(`^M ${right!.x} ${right!.y + FILE_H / 2} C`));
    expect(layout.links[0]!.d.endsWith(`${junction!.x} ${junction!.y}`)).toBe(true);
    expectTidy(layout);
  });

  it("stops a long chain from growing wider than eight columns", () => {
    const chain = Array.from({ length: 9 }, (_, i) => edge(`c${i}`, [`n${i + 1}`, `n${i + 2}`]));
    const layout = layoutDiagram(nodesOf(10), chain);
    expect(Math.max(...layout.files.map((f) => f.rank))).toBe(7);
    // The last files share the final column, so their junction sits beside that column.
    const [eight, nine] = [layout.files[7]!, layout.files[8]!];
    expect(eight.rank).toBe(nine.rank);
    const junction = layout.junctions.find((j) => j.id === "c7")!;
    expect(junction.fileIds).toEqual(["n8", "n9"]);
    expect(junction.x).toBeGreaterThan(eight.x + eight.w);
    for (const link of layout.links.filter((l) => l.edgeId === "c7"))
      expect(link.d).toMatch(new RegExp(`^M ${eight.x + eight.w} `));
    expectTidy(layout);
  });

  it("joins an edge of four or more files with one junction and a line to each", () => {
    const layout = layoutDiagram(nodesOf(5), [edge("hub", ["n1", "n2", "n3", "n4", "n5"])]);
    expect(layout.junctions).toHaveLength(1);
    expect(layout.links).toHaveLength(5);
    expect(layout.junctions[0]!.fileIds).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    // The first file is the source: the others are one column to its right.
    expect(layout.files.map((f) => f.rank)).toEqual([0, 1, 1, 1, 1]);
    const [first, ...rest] = layout.files;
    const junction = layout.junctions[0]!;
    expect(junction.x).toBeGreaterThan(first!.x + first!.w);
    for (const file of rest) expect(junction.x).toBeLessThan(file.x);
    expectTidy(layout);
  });

  it("keeps many edges apart, in a tight spot too", () => {
    const edges = Array.from({ length: 24 }, (_, i) =>
      edge(`e${i}`, [
        `n${(i % 5) + 1}`,
        `n${((i + 2) % 6) + 1}`,
        ...(i % 3 === 0 ? [`n${((i + 4) % 6) + 1}`] : []),
      ]),
    );
    const layout = layoutDiagram(nodesOf(6), edges);
    // Edges that repeat a file or name the same file twice are fine; each still needs two different files.
    expect(layout.junctions.length).toBeGreaterThan(10);
    expect(layout.links.length).toBeGreaterThan(layout.junctions.length * 2 - 1);
    expectTidy(layout);
  });

  it("labels junctions by the edge's place in the plan, even when an earlier edge was unusable", () => {
    const layout = layoutDiagram(nodesOf(3), [edge("bad", ["n1", "nowhere"]), edge("ok", ["n1", "n2"])]);
    expect(layout.junctions.map((j) => [j.id, j.label])).toEqual([["ok", "e2"]]);
  });

  it("ignores files an edge names that the plan doesn't have, and edges left with fewer than two", () => {
    const layout = layoutDiagram(nodesOf(3), [
      edge("one", ["n1", "ghost"]),
      edge("two", ["n1", "n2", "ghost"]),
      edge("dup", ["n3", "n3"]),
    ]);
    expect(layout.junctions.map((j) => j.id)).toEqual(["two"]);
    expect(layout.junctions[0]!.fileIds).toEqual(["n1", "n2"]);
    expectTidy(layout);
  });

  it("keeps the first of two files with the same id", () => {
    const layout = layoutDiagram([node("a", "one.ts"), node("a", "two.ts")], []);
    expect(layout.files).toHaveLength(1);
    expect(layout.files[0]!.pathText).toBe("one.ts");
  });

  it("starts a new column when one is full, so a big plan grows sideways", () => {
    const layout = layoutDiagram(nodesOf(PER_RANK * 2 + 1), []);
    const perRank = new Map<number, number>();
    for (const file of layout.files) perRank.set(file.rank, (perRank.get(file.rank) ?? 0) + 1);
    expect(Math.max(...perRank.values())).toBe(PER_RANK);
    expect(perRank.size).toBe(3);
    expectTidy(layout);
  });

  it("lays out the biggest plan the planner may make without overlaps", () => {
    expectTidy(layoutDiagram(nodesOf(40), bigEdges()));
  });

  it("draws no line of a big plan over a box (it was 123 of 240 before lines went round)", () => {
    const layout = layoutDiagram(nodesOf(40), bigEdges());
    expect(layout.links.length).toBe(240);
    expect(occludedLinks(layout)).toBe(0);
    // Other big plans too, built in other orders.
    for (const [a, b] of [
      [3, 5],
      [13, 17],
      [29, 31],
    ] as const) {
      const other = layoutDiagram(nodesOf(40), bigEdges(a, b));
      expect(occludedLinks(other), `${a} ${b}`).toBe(0);
      expectTidy(other);
    }
  });

  it("keeps a big plan's junctions beside its files, not stacked far below them", () => {
    const layout = layoutDiagram(nodesOf(40), bigEdges());
    const filesTop = Math.min(...layout.files.map((f) => f.y));
    const filesBottom = Math.max(...layout.files.map((f) => f.y + f.h));
    for (const junction of layout.junctions) {
      expect(junction.y, junction.label).toBeGreaterThanOrEqual(filesTop);
      expect(junction.y, junction.label).toBeLessThanOrEqual(filesBottom);
    }
  });

  it("never makes more than eight columns, however the files depend on each other", () => {
    // A chain of 40: each file depends on the one before.
    const chain = Array.from({ length: 39 }, (_, i) => edge(`c${i}`, [`n${i + 1}`, `n${i + 2}`]));
    const layout = layoutDiagram(nodesOf(40), chain);
    const perRank = new Map<number, number>();
    for (const file of layout.files) perRank.set(file.rank, (perRank.get(file.rank) ?? 0) + 1);
    expect(Math.max(...perRank.keys())).toBeLessThanOrEqual(7);
    expect(Math.max(...perRank.values())).toBeLessThanOrEqual(PER_RANK);
    expect(occludedLinks(layout)).toBe(0);
    expectTidy(layout);
    // More files than eight columns hold: the columns grow taller rather than wider.
    const many = layoutDiagram(nodesOf(PER_RANK * 8 + 5), []);
    expect(Math.max(...many.files.map((f) => f.rank))).toBe(7);
    expectTidy(many);
  });

  it("joins a far file to its junction round the boxes, from the side that faces it, ending at the junction", () => {
    // n1 links to n3 two columns on, through n2's column.
    const layout = layoutDiagram(nodesOf(3), [
      edge("a", ["n1", "n2"]),
      edge("b", ["n2", "n3"]),
      edge("far", ["n1", "n2", "n3"]),
    ]);
    const files = Object.fromEntries(layout.files.map((f) => [f.id, f]));
    const junction = layout.junctions.find((j) => j.id === "far")!;
    for (const link of layout.links.filter((l) => l.edgeId === "far")) {
      const file = files[link.fileId]!;
      const facing = junction.x > file.x ? file.x + file.w : file.x;
      expect(link.d.startsWith(`M ${facing} ${file.y + FILE_H / 2} `), link.fileId).toBe(true);
      expect(link.d.endsWith(`${junction.x} ${junction.y}`), link.fileId).toBe(true);
    }
    expect(occludedLinks(layout)).toBe(0);
    expectTidy(layout);
  });
});

describe("telling a line hidden behind a box", () => {
  const box = (id: string, x: number, y: number) => ({
    id,
    x,
    y,
    w: 100,
    h: 50,
    rank: 0,
    pathText: id,
    purposeLines: [],
    clipped: false,
  });
  const files = [box("a", 0, 0), box("b", 200, 0), box("c", 400, 0)];

  it("counts a line across another box, and not one that only leaves its own", () => {
    const across = { edgeId: "e", fileId: "a", d: "M 100 25 L 450 25" };
    const beside = { edgeId: "e", fileId: "a", d: "M 100 25 C 140 25 160 80 180 80" };
    const over = { edgeId: "e", fileId: "a", d: "M 100 25 L 150 25 Q 160 25 160 -10 L 260 -10" };
    expect(occludedLinks({ files, links: [across] })).toBe(1);
    expect(occludedLinks({ files, links: [beside, over] })).toBe(0);
    // A curve that bends into a box counts too.
    expect(occludedLinks({ files, links: [{ ...beside, d: "M 100 25 C 300 25 300 25 300 60" }] })).toBe(1);
  });

  it("samples a path finely enough to catch a corner", () => {
    const points = pathPoints("M 0 0 L 100 0 Q 110 0 110 10");
    expect(points[0]).toEqual([0, 0]);
    expect(points.at(-1)).toEqual([110, 10]);
    for (let i = 1; i < points.length; i++)
      expect(Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1])).toBeLessThan(
        5,
      );
  });
});

describe("spreading junctions", () => {
  it("leaves junctions that don't touch where they want to be", () => {
    expect(packJunctions([100, 200, 300], 40, 0)).toEqual([100, 200, 300]);
  });

  it("centres a crowd on the heights it wants, instead of pushing it all below them", () => {
    const ys = packJunctions([200, 200, 200], 40, 0);
    expect(ys).toEqual([160, 200, 240]);
  });

  it("keeps them apart and below the floor", () => {
    const ys = packJunctions([0, 5, 10, 300], 40, 30);
    expect(ys[0]).toBe(30);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(40);
    expect(ys[3]).toBe(300);
  });
});

describe("file boxes and the picture's size", () => {
  it("clips what doesn't fit in a box and says so", () => {
    const layout = layoutDiagram(
      [node("a", "packages/very/deep/folder/structure/with/ComponentName.tsx", "word ".repeat(80))],
      [],
    );
    const file = layout.files[0]!;
    expect(file.pathText.endsWith("ComponentName.tsx")).toBe(true);
    expect(file.pathText.startsWith("…")).toBe(true);
    expect(file.purposeLines).toHaveLength(3);
    expect(file.purposeLines[2]!.endsWith("…")).toBe(true);
    expect(file.clipped).toBe(true);
  });

  it("makes the picture exactly big enough, with room round the edge", () => {
    const layout = layoutDiagram(nodesOf(2), [edge("e", ["n1", "n2"])]);
    const right = Math.max(...layout.files.map((f) => f.x + f.w));
    expect(layout.width).toBe(right + 24);
    expect(layout.height).toBeGreaterThanOrEqual(FILE_H + 48);
    expect(JUNCTION_R).toBeGreaterThan(8);
  });
});

describe("wrapping text", () => {
  it("wraps at word boundaries", () => {
    expect(wrapText("one two three four", 9, 5)).toEqual({
      lines: ["one two", "three", "four"],
      clipped: false,
    });
  });

  it("breaks a word longer than a line", () => {
    expect(wrapText("abcdefghij", 4, 5)).toEqual({ lines: ["abcd", "efgh", "ij"], clipped: false });
  });

  it("ends the last line with an ellipsis when there is more", () => {
    expect(wrapText("alpha beta gamma delta epsilon", 10, 2)).toEqual({
      lines: ["alpha beta", "gamma…"],
      clipped: true,
    });
    // A full last line gives up a letter for the ellipsis, so it still fits.
    const full = wrapText("abcdefghij klmnopqrst uvw", 10, 2);
    expect(full).toEqual({ lines: ["abcdefghij", "klmnopqrs…"], clipped: true });
  });

  it("returns no lines for empty text", () => {
    expect(wrapText("   ", 10, 3)).toEqual({ lines: [], clipped: false });
  });

  it("shortens a path from the left", () => {
    expect(clipPath("src/a.ts", 20)).toBe("src/a.ts");
    expect(clipPath("src/components/Button.tsx", 12)).toBe("…/Button.tsx");
    expect(clipPath("src/components/Button.tsx", 12)).toHaveLength(12);
  });
});

describe("zoom", () => {
  it("stays between the limits", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(50)).toBe(MAX_ZOOM);
    expect(stepZoom(1, 1)).toBe(1.2);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it("fits the picture across the space, but never enlarges it", () => {
    expect(fitZoom(1000, 800)).toBe(0.8);
    expect(fitZoom(400, 800)).toBe(1);
    expect(fitZoom(0, 300)).toBe(1);
    expect(fitZoom(300, 0)).toBe(1);
  });

  it("never fits a big plan so small its text can't be read: it scrolls instead", () => {
    expect(fitZoom(1000, 500)).toBe(MIN_FIT_ZOOM);
    expect(fitZoom(10_000, 300)).toBe(MIN_FIT_ZOOM);
    expect(MIN_FIT_ZOOM).toBeGreaterThan(MIN_ZOOM);
    // The buttons still zoom further out.
    expect(stepZoom(MIN_FIT_ZOOM, -1)).toBeLessThan(MIN_FIT_ZOOM);
  });
});

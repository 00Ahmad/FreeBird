import type { CodingEdge, CodingNode } from "@mrog/shared";

import { edgeLabel } from "./coding";

/** All sizes are in SVG units (pixels at zoom 1). */
export const FILE_W = 232;
export const FILE_H = 96;
export const ROW_GAP = 26;
/** The gap between two file columns, where the junctions of the edges between them sit. */
export const LANE_W = 96;
export const JUNCTION_R = 14;
const JUNCTION_GAP = 12;
export const PAD = 24;
/** A taller column than this is split into the next one, so a big plan grows sideways, not down a mile. */
export const PER_RANK = 6;
const MAX_RANKS = 8;

/** About how many characters fit on a line in a file box, for the path (monospace 12px) and the purpose (11px). */
export const PATH_CHARS = 26;
export const PURPOSE_CHARS = 38;
export const PURPOSE_LINES = 3;

/** Wraps text into at most `maxLines` lines of `maxChars`; when it doesn't fit the last line ends in "…". */
export function wrapText(
  text: string,
  maxChars: number,
  maxLines: number,
): { lines: string[]; clipped: boolean } {
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    // A word longer than a line is cut, rather than overflowing the box.
    while (word.length > maxChars) {
      if (line) lines.push(line);
      line = "";
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return { lines, clipped: false };
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1]!;
  kept[maxLines - 1] = `${last.length >= maxChars ? last.slice(0, maxChars - 1) : last}…`;
  return { lines: kept, clipped: true };
}

/** A path shortened from the left, so the file name always shows: `…/components/Button.tsx`. */
export function clipPath(path: string, max: number): string {
  return path.length <= max ? path : `…${path.slice(path.length - (max - 1))}`;
}

export interface PlacedFile {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The column, counted from 0 on the left. */
  rank: number;
  pathText: string;
  purposeLines: string[];
  /** The path or purpose was shortened, so the tooltip has more. */
  clipped: boolean;
}

export interface PlacedJunction {
  id: string;
  /** e1, e2, … */
  label: string;
  /** The centre. */
  x: number;
  y: number;
  r: number;
  /** The files it joins. */
  fileIds: string[];
}

/** A line from a file to the junction of an edge. */
export interface PlacedLink {
  edgeId: string;
  fileId: string;
  /** An SVG path. */
  d: string;
}

export interface DiagramLayout {
  width: number;
  height: number;
  files: PlacedFile[];
  junctions: PlacedJunction[];
  links: PlacedLink[];
}

const EMPTY: DiagramLayout = { width: 0, height: 0, files: [], junctions: [], links: [] };

/** Where a column's right edge is, and so where the gap (lane) beside it starts. */
const laneLeft = (lane: number) => PAD + lane * (FILE_W + LANE_W) + FILE_W;
const laneCentre = (lane: number) => laneLeft(lane) + LANE_W / 2;
/** A line that goes round the boxes runs this far into the gap beside its file, clear of the junctions there. */
const CHANNEL = 10;
/** And comes down to its junction this far to the side of it. */
const APPROACH = JUNCTION_R + 8;
/** The corridors above and below the boxes where lines going round run: tracks so they don't all lie on one. */
const TRACKS = 5;
const TRACK_GAP = 4;
const CORRIDOR = TRACKS * TRACK_GAP;
const CORRIDOR_GAP = 14;
const CORNER = 8;

/** An SVG path along an orthogonal polyline, its corners rounded. */
function roundedPath(points: readonly Point[]): string {
  const parts = [`M ${points[0]![0]} ${points[0]![1]}`];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]!;
    const [x, y] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    const before = Math.hypot(x - px, y - py);
    const after = Math.hypot(nx - x, ny - y);
    const r = Math.min(CORNER, before / 2, after / 2);
    if (r <= 0) continue;
    const a: Point = [x - ((x - px) / before) * r, y - ((y - py) / before) * r];
    const b: Point = [x + ((nx - x) / after) * r, y + ((ny - y) / after) * r];
    parts.push(`L ${a[0]} ${a[1]}`, `Q ${x} ${y} ${b[0]} ${b[1]}`);
  }
  const last = points.at(-1)!;
  parts.push(`L ${last[0]} ${last[1]}`);
  return parts.join(" ");
}

/**
 * Spreads junctions wanted at `wanted` heights (sorted) at least `step` apart, each as near its wanted height as it
 * can be: a crowd is centred on the heights it wants rather than pushed down below them, and never above `floor`.
 */
export function packJunctions(wanted: readonly number[], step: number, floor: number): number[] {
  const blocks: { start: number; items: number[] }[] = [];
  for (const want of wanted) {
    blocks.push({ start: want, items: [want] });
    // Merge with the block above while they overlap, and centre the merged block on what its items want.
    for (;;) {
      const block = blocks.at(-1)!;
      const above = blocks.at(-2);
      if (!above || above.start + above.items.length * step <= block.start) break;
      const items = [...above.items, ...block.items];
      const start = items.reduce((sum, item, index) => sum + item - index * step, 0) / items.length;
      blocks.splice(-2, 2, { start, items });
    }
  }
  const out: number[] = [];
  let next = floor;
  for (const block of blocks)
    block.items.forEach((_, index) => {
      const y = Math.round(Math.max(block.start + index * step, next));
      out.push(y);
      next = y + step;
    });
  return out;
}

/**
 * A left-to-right layered layout. The nodes come in the planner's build order, and that order decides the columns: a
 * file sits one column to the right of the first file (in that order) of every edge that links it, so what is built
 * first is on the left. A column holds PER_RANK files (more only when the plan has more than MAX_RANKS columns of
 * them), and there are never more than MAX_RANKS columns: a full column sends a file to the nearest one with room.
 *
 * Each edge becomes a junction in a gap between columns, chosen so that as many of its files as possible sit right
 * beside it, and spread over the gaps it could use so no gap gets crowded. Junctions sit as close as they can to the
 * average height of their files without touching each other. A file beside its junction is joined by a short curve
 * in the gap; one further away is joined by a line that goes round the boxes, never over them: into the gap beside
 * its file, up (or down) to a corridor above (or below) all the boxes, along it, and down the junction's gap to it.
 * Nothing depends on anything but the input, so the same plan always gives the same picture.
 */
export function layoutDiagram(
  nodes: readonly Pick<CodingNode, "id" | "path" | "purpose">[],
  edges: readonly Pick<CodingEdge, "id" | "files">[],
): DiagramLayout {
  // A repeated id keeps its first appearance.
  const seen = new Set<string>();
  const list = nodes.filter((node) => !seen.has(node.id) && seen.add(node.id));
  if (list.length === 0) return EMPTY;
  const order = new Map(list.map((node, index) => [node.id, index]));

  // An edge needs two real files; a file it names that the plan lacks is ignored.
  const usable = edges
    .map((edge, index) => ({
      id: edge.id,
      label: edgeLabel(index),
      files: [...new Set(edge.files.filter((id) => order.has(id)))].toSorted(
        (a, b) => order.get(a)! - order.get(b)!,
      ),
    }))
    .filter((edge) => edge.files.length >= 2);

  // Columns, never more than MAX_RANKS: taller ones only when the plan can't fit otherwise.
  const perRank = Math.max(PER_RANK, Math.ceil(list.length / MAX_RANKS));
  const firsts = new Map<string, string[]>();
  for (const edge of usable)
    for (const id of edge.files.slice(1)) firsts.set(id, [...(firsts.get(id) ?? []), edge.files[0]!]);
  const rankOf = new Map<string, number>();
  const columns: string[][] = [];
  const hasRoom = (rank: number) => (columns[rank]?.length ?? 0) < perRank;
  for (const node of list) {
    const wanted = Math.min(
      MAX_RANKS - 1,
      Math.max(0, ...(firsts.get(node.id) ?? []).map((first) => rankOf.get(first)! + 1)),
    );
    // The wanted column, else the nearest to its right, else the nearest to its left. There is always room.
    let rank = wanted;
    while (rank < MAX_RANKS - 1 && !hasRoom(rank)) rank++;
    if (!hasRoom(rank)) {
      rank = wanted - 1;
      while (rank > 0 && !hasRoom(rank)) rank--;
    }
    (columns[rank] ??= []).push(node.id);
    rankOf.set(node.id, rank);
  }

  // Junction lanes: the gap beside the most of an edge's files, the emptier gap on a tie.
  const heightOf = (count: number) => count * FILE_H + (count - 1) * ROW_GAP;
  const tallest = Math.max(...columns.map((column) => (column ? heightOf(column.length) : 0)));
  const step = 2 * JUNCTION_R + JUNCTION_GAP;
  const fits = Math.max(1, Math.floor(tallest / step));
  const load = new Map<number, number>();
  const lanes = usable.map((edge) => {
    const ranks = edge.files.map((id) => rankOf.get(id)!);
    const low = Math.min(...ranks);
    const high = Math.max(...ranks);
    const middle = low === high ? low : Math.min(high - 1, Math.floor((low + high) / 2));
    const candidates =
      low === high
        ? [low, ...(low > 0 ? [low - 1] : [])]
        : Array.from({ length: high - low }, (_, i) => low + i);
    // A file not beside its junction needs a line round the boxes; a gap fuller than its column is tall pushes
    // junctions below the files. Both cost; the first more.
    const cost = (lane: number) =>
      ranks.filter((rank) => rank !== lane && rank !== lane + 1).length + (load.get(lane) ?? 0) / fits;
    const lane = candidates.reduce((best, candidate) => {
      const diff = cost(candidate) - cost(best);
      if (diff < -1e-9) return candidate;
      if (diff > 1e-9) return best;
      return Math.abs(candidate - middle) < Math.abs(best - middle) ? candidate : best;
    });
    load.set(lane, (load.get(lane) ?? 0) + 1);
    return lane;
  });
  const routedTop = (fileRank: number, lane: number) => fileRank !== lane && fileRank !== lane + 1;
  const routes = usable.some((edge, index) =>
    edge.files.some((id) => routedTop(rankOf.get(id)!, lanes[index]!)),
  );
  // Room above the boxes for the corridor, when some line goes round.
  const contentTop = PAD + (routes ? CORRIDOR + CORRIDOR_GAP : 0);

  // Files: each column is stacked from the top and centred against the tallest one.
  const byId = new Map(list.map((node) => [node.id, node]));
  const placed = new Map<string, PlacedFile>();
  columns.forEach((column, rank) => {
    if (!column) return;
    const top = contentTop + Math.round((tallest - heightOf(column.length)) / 2);
    column.forEach((id, row) => {
      const node = byId.get(id)!;
      const purpose = wrapText(node.purpose, PURPOSE_CHARS, PURPOSE_LINES);
      const pathText = clipPath(node.path, PATH_CHARS);
      placed.set(id, {
        id,
        x: PAD + rank * (FILE_W + LANE_W),
        y: top + row * (FILE_H + ROW_GAP),
        w: FILE_W,
        h: FILE_H,
        rank,
        pathText,
        purposeLines: purpose.lines,
        clipped: purpose.clipped || pathText !== node.path,
      });
    });
  });

  // Junctions: in their gap, at the average height of their files, spread apart (up and down) where it is crowded.
  const planned = usable.map((edge, index) => {
    const wanted =
      edge.files.reduce((sum, id) => sum + placed.get(id)!.y + FILE_H / 2, 0) / edge.files.length;
    return { edge, index, lane: lanes[index]!, wanted };
  });
  const junctions = new Map<string, PlacedJunction>();
  for (const lane of [...new Set(lanes)].toSorted((a, b) => a - b)) {
    const inLane = planned
      .filter((item) => item.lane === lane)
      .toSorted((a, b) => a.wanted - b.wanted || a.index - b.index);
    const ys = packJunctions(
      inLane.map((item) => item.wanted),
      step,
      contentTop + JUNCTION_R,
    );
    inLane.forEach((item, i) =>
      junctions.set(item.edge.id, {
        id: item.edge.id,
        label: item.edge.label,
        x: laneCentre(lane),
        y: ys[i]!,
        r: JUNCTION_R,
        fileIds: item.edge.files,
      }),
    );
  }

  const files = list.map((node) => placed.get(node.id)!);
  const junctionList = usable.map((edge) => junctions.get(edge.id)!);
  const contentBottom = Math.max(...files.map((f) => f.y + f.h), ...junctionList.map((j) => j.y + j.r));
  const middle = (contentTop + contentBottom) / 2;

  // Links: a file beside its junction is joined by a smooth curve from the side that faces it; any other goes round.
  const links: PlacedLink[] = [];
  let tracks = 0;
  let below = false;
  for (const { edge, lane } of planned) {
    const junction = junctions.get(edge.id)!;
    for (const id of edge.files) {
      const file = placed.get(id)!;
      const ay = file.y + file.h / 2;
      if (!routedTop(file.rank, lane)) {
        const fromRight = file.rank <= lane;
        const sign = fromRight ? 1 : -1;
        const ax = fromRight ? file.x + file.w : file.x;
        const pull = Math.round(Math.max(16, Math.min(48, Math.abs(junction.x - ax) / 2)));
        links.push({
          edgeId: edge.id,
          fileId: id,
          d: `M ${ax} ${ay} C ${ax + sign * pull} ${ay} ${junction.x - sign * pull} ${junction.y} ${junction.x} ${junction.y}`,
        });
        continue;
      }
      // Round the boxes: out into the gap beside the file, along a corridor, and down the junction's gap.
      const rightwards = file.rank < lane;
      const ax = rightwards ? file.x + file.w : file.x;
      const channel = rightwards ? ax + CHANNEL : ax - CHANNEL;
      const approach = rightwards ? junction.x - APPROACH : junction.x + APPROACH;
      const track = (tracks++ % TRACKS) * TRACK_GAP;
      const top = (ay + junction.y) / 2 <= middle;
      if (!top) below = true;
      const corridor = top ? PAD + track : contentBottom + CORRIDOR_GAP + track;
      links.push({
        edgeId: edge.id,
        fileId: id,
        d: roundedPath([
          [ax, ay],
          [channel, ay],
          [channel, corridor],
          [approach, corridor],
          [approach, junction.y],
          [junction.x, junction.y],
        ]),
      });
    }
  }

  return {
    width: Math.max(...files.map((f) => f.x + f.w), ...junctionList.map((j) => j.x + j.r)) + PAD,
    height: (below ? contentBottom + CORRIDOR_GAP + CORRIDOR : contentBottom) + PAD,
    files,
    junctions: junctionList,
    links,
  };
}

type Point = [number, number];

/**
 * Points along an SVG path made of absolute M, L, Q and C commands (what the layout draws), close enough together
 * (a few pixels) to tell which boxes a line passes over.
 */
export function pathPoints(d: string): Point[] {
  const tokens = d.match(/[MLQC]|-?\d+(?:\.\d+)?/g) ?? [];
  const points: Point[] = [];
  let at: Point = [0, 0];
  let i = 0;
  const num = () => Number(tokens[i++]);
  const pair = (): Point => [num(), num()];
  const sample = (count: number, f: (t: number) => Point) => {
    for (let k = 1; k <= count; k++) points.push(f(k / count));
  };
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === "M") {
      at = pair();
      points.push(at);
    } else if (command === "L") {
      const from = at;
      const to = pair();
      const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 4));
      sample(count, (t) => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
      at = to;
    } else if (command === "Q") {
      const from = at;
      const c = pair();
      const to = pair();
      sample(16, (t) => {
        const u = 1 - t;
        return [
          u * u * from[0] + 2 * u * t * c[0] + t * t * to[0],
          u * u * from[1] + 2 * u * t * c[1] + t * t * to[1],
        ];
      });
      at = to;
    } else if (command === "C") {
      const from = at;
      const c1 = pair();
      const c2 = pair();
      const to = pair();
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      sample(Math.max(8, Math.ceil(length / 4)), (t) => {
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const e = t * t * t;
        return [
          a * from[0] + b * c1[0] + c * c2[0] + e * to[0],
          a * from[1] + b * c1[1] + c * c2[1] + e * to[1],
        ];
      });
      at = to;
    } else break;
  }
  return points;
}

/**
 * How many links pass over a file box other than their own (they would be hidden behind it, or cross its text). A
 * picture of a big plan is only readable when this stays near zero.
 */
export function occludedLinks(layout: Pick<DiagramLayout, "files" | "links">): number {
  const inside = (point: Point, file: PlacedFile) =>
    point[0] > file.x + 1 &&
    point[0] < file.x + file.w - 1 &&
    point[1] > file.y + 1 &&
    point[1] < file.y + file.h - 1;
  return layout.links.filter((link) => {
    const points = pathPoints(link.d);
    return layout.files.some(
      (file) => file.id !== link.fileId && points.some((point) => inside(point, file)),
    );
  }).length;
}

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2;

export const clampZoom = (zoom: number): number =>
  Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 100) / 100;

/** One zoom button press. */
export const stepZoom = (zoom: number, direction: 1 | -1): number => clampZoom(zoom + direction * 0.2);

/** Fitting never shrinks the picture below this: smaller text can't be read, so a big plan scrolls instead. */
export const MIN_FIT_ZOOM = 0.6;

/**
 * The zoom that fits the whole diagram across `available` pixels; it never enlarges past 100%, and never shrinks
 * below MIN_FIT_ZOOM (the zoom buttons still go further).
 */
export function fitZoom(diagramWidth: number, available: number): number {
  if (diagramWidth <= 0 || available <= 0) return 1;
  return clampZoom(Math.max(MIN_FIT_ZOOM, Math.min(1, available / diagramWidth)));
}

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

/**
 * A left-to-right layered layout. The nodes come in the planner's build order, and that order decides the columns: a
 * file sits one column to the right of the first file (in that order) of every edge that links it, so what is built
 * first is on the left. A column holds at most PER_RANK files; the rest go to the next one. Each edge becomes a
 * junction in the gap beside the middle of the files it links, as close as it can get to their average height without
 * touching another junction. Nothing depends on anything but the input, so the same plan always gives the same picture.
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

  // Columns.
  const firsts = new Map<string, string[]>();
  for (const edge of usable)
    for (const id of edge.files.slice(1)) firsts.set(id, [...(firsts.get(id) ?? []), edge.files[0]!]);
  const rankOf = new Map<string, number>();
  const columns: string[][] = [];
  for (const node of list) {
    let rank = Math.min(
      MAX_RANKS - 1,
      Math.max(0, ...(firsts.get(node.id) ?? []).map((first) => rankOf.get(first)! + 1)),
    );
    while ((columns[rank]?.length ?? 0) >= PER_RANK) rank++;
    (columns[rank] ??= []).push(node.id);
    rankOf.set(node.id, rank);
  }

  // Files: each column is stacked from the top and centred against the tallest one.
  const heightOf = (count: number) => count * FILE_H + (count - 1) * ROW_GAP;
  const tallest = Math.max(...columns.map((column) => (column ? heightOf(column.length) : 0)));
  const byId = new Map(list.map((node) => [node.id, node]));
  const placed = new Map<string, PlacedFile>();
  columns.forEach((column, rank) => {
    if (!column) return;
    const top = PAD + Math.round((tallest - heightOf(column.length)) / 2);
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

  // Junctions: in the gap beside the middle of the files, then spread apart where a gap is crowded.
  const planned = usable.map((edge, index) => {
    const ranks = edge.files.map((id) => placed.get(id)!.rank);
    const low = Math.min(...ranks);
    const high = Math.max(...ranks);
    const lane = low === high ? low : Math.min(high - 1, Math.floor((low + high) / 2));
    const wanted =
      edge.files.reduce((sum, id) => sum + placed.get(id)!.y + FILE_H / 2, 0) / edge.files.length;
    return { edge, index, lane, wanted };
  });
  const junctions = new Map<string, PlacedJunction>();
  const step = 2 * JUNCTION_R + JUNCTION_GAP;
  const lanes = [...new Set(planned.map((item) => item.lane))].toSorted((a, b) => a - b);
  for (const lane of lanes) {
    let floor = PAD + JUNCTION_R;
    const inLane = planned
      .filter((item) => item.lane === lane)
      .toSorted((a, b) => a.wanted - b.wanted || a.index - b.index);
    for (const item of inLane) {
      const y = Math.round(Math.max(item.wanted, floor));
      floor = y + step;
      junctions.set(item.edge.id, {
        id: item.edge.id,
        label: item.edge.label,
        x: PAD + lane * (FILE_W + LANE_W) + FILE_W + LANE_W / 2,
        y,
        r: JUNCTION_R,
        fileIds: item.edge.files,
      });
    }
  }

  // Links: from the side of a file that faces the junction, as a smooth curve.
  const links: PlacedLink[] = [];
  for (const { edge, lane } of planned) {
    const junction = junctions.get(edge.id)!;
    for (const id of edge.files) {
      const file = placed.get(id)!;
      const fromRight = file.rank <= lane;
      const sign = fromRight ? 1 : -1;
      const ax = fromRight ? file.x + file.w : file.x;
      const ay = file.y + file.h / 2;
      const pull = Math.round(Math.max(16, Math.min(48, Math.abs(junction.x - ax) / 2)));
      links.push({
        edgeId: edge.id,
        fileId: id,
        d: `M ${ax} ${ay} C ${ax + sign * pull} ${ay} ${junction.x - sign * pull} ${junction.y} ${junction.x} ${junction.y}`,
      });
    }
  }

  const files = list.map((node) => placed.get(node.id)!);
  const junctionList = usable.map((edge) => junctions.get(edge.id)!);
  return {
    width: Math.max(...files.map((f) => f.x + f.w), ...junctionList.map((j) => j.x + j.r)) + PAD,
    height: Math.max(...files.map((f) => f.y + f.h), ...junctionList.map((j) => j.y + j.r)) + PAD,
    files,
    junctions: junctionList,
    links,
  };
}

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2;

export const clampZoom = (zoom: number): number =>
  Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 100) / 100;

/** One zoom button press. */
export const stepZoom = (zoom: number, direction: 1 | -1): number => clampZoom(zoom + direction * 0.2);

/** The zoom that fits the whole diagram across `available` pixels; it never enlarges past 100%. */
export function fitZoom(diagramWidth: number, available: number): number {
  if (diagramWidth <= 0 || available <= 0) return 1;
  return clampZoom(Math.min(1, available / diagramWidth));
}

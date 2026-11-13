import {
  CODING_COLUMNS,
  type CardComment,
  type CodingCard,
  type CodingColumn,
  type CodingEdge,
  type CodingNode,
  type CodingProject,
} from "@mrog/shared";

import { edgeLabel } from "./coding";

type Plan = Pick<CodingProject, "nodes" | "edges" | "cards">;

export const COLUMN_LABEL: Record<CodingColumn, string> = {
  todo: "Todo",
  in_progress: "In progress",
  qa: "QA",
  done: "Done",
};

/** A colour per column, from the app's own tokens so it reads in light and dark. */
export const COLUMN_COLOR: Record<CodingColumn, string> = {
  todo: "var(--mrog-ink-3)",
  in_progress: "var(--mrog-warning)",
  qa: "var(--mrog-avatar-sky)",
  done: "var(--mrog-success)",
};

export const columnLabel = (column: CodingColumn): string => COLUMN_LABEL[column];

/** The card for each node or edge id. */
export function cardsByRef(cards: readonly CodingCard[]): Map<string, CodingCard> {
  return new Map(cards.map((card) => [card.ref, card]));
}

/** "e1", "e2", … for each edge id. */
export function edgeLabels(edges: readonly CodingEdge[]): Map<string, string> {
  return new Map(edges.map((edge, index) => [edge.id, edgeLabel(index)]));
}

/** Oldest first, so the newest comment is last. Comments with the same time keep the order they came in. */
export function sortComments(comments: readonly CardComment[]): CardComment[] {
  return comments
    .map((comment, index) => ({ comment, index }))
    .toSorted((a, b) => Date.parse(a.comment.at) - Date.parse(b.comment.at) || a.index - b.index)
    .map(({ comment }) => comment);
}

/** A card sent back to Todo by QA: it has a QA comment to act on. */
export const needsFixing = (card: Pick<CodingCard, "column" | "comments">): boolean =>
  card.column === "todo" && card.comments.some((comment) => comment.author === "qa");

export interface LinkedFile {
  id: string;
  /** The path, or the id when the plan no longer has that file. */
  path: string;
}

export interface BoardCard {
  card: CodingCard;
  node: CodingNode | null;
  edge: CodingEdge | null;
  /** e1, e2, … for a connector. */
  label: string | null;
  /** The files a connector links. */
  linked: LinkedFile[];
  needsFixing: boolean;
  comments: CardComment[];
}

export interface BoardColumn {
  column: CodingColumn;
  label: string;
  cards: BoardCard[];
  count: number;
}

/** What a node or edge id is, and the files an edge links. */
export function linkedFiles(edge: CodingEdge, nodes: readonly CodingNode[]): LinkedFile[] {
  const paths = new Map(nodes.map((node) => [node.id, node.path]));
  return edge.files.map((id) => ({ id, path: paths.get(id) ?? id }));
}

/** The board: the four columns in order, each with its cards in the plan's order (files, then connectors). */
export function buildBoard(plan: Plan): BoardColumn[] {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const edges = new Map(plan.edges.map((edge) => [edge.id, edge]));
  const labels = edgeLabels(plan.edges);
  const position = new Map<string, number>([
    ...plan.nodes.map((node, index) => [node.id, index] as const),
    ...plan.edges.map((edge, index) => [edge.id, plan.nodes.length + index] as const),
  ]);

  const cards: BoardCard[] = plan.cards.map((card) => {
    const edge = card.kind === "connector" ? (edges.get(card.ref) ?? null) : null;
    return {
      card,
      node: card.kind === "file" ? (nodes.get(card.ref) ?? null) : null,
      edge,
      label: edge ? (labels.get(edge.id) ?? null) : null,
      linked: edge ? linkedFiles(edge, plan.nodes) : [],
      needsFixing: needsFixing(card),
      comments: sortComments(card.comments),
    };
  });
  // Unknown refs go last, in the order they came.
  const order = (item: BoardCard) => position.get(item.card.ref) ?? Number.MAX_SAFE_INTEGER;
  const ordered = cards
    .map((item, index) => ({ item, index }))
    .toSorted((a, b) => order(a.item) - order(b.item) || a.index - b.index);

  return CODING_COLUMNS.map((column) => {
    const inColumn = ordered.filter(({ item }) => item.card.column === column).map(({ item }) => item);
    return { column, label: COLUMN_LABEL[column], cards: inColumn, count: inColumn.length };
  });
}

/** "3 of 7 done". */
export const progressText = (done: number, total: number): string => `${done} of ${total} done`;

/**
 * What to emphasise when a node or an edge is picked: itself, the files an edge links, and the edges that touch a
 * file. Everything else can be dimmed. Empty when nothing is picked.
 */
export function relatedRefs(
  plan: Pick<CodingProject, "nodes" | "edges">,
  picked: string | null,
): Set<string> {
  const related = new Set<string>();
  if (!picked) return related;
  related.add(picked);
  const edge = plan.edges.find((candidate) => candidate.id === picked);
  if (edge) for (const id of edge.files) related.add(id);
  else for (const other of plan.edges) if (other.files.includes(picked)) related.add(other.id);
  return related;
}

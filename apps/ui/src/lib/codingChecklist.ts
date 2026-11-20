import type { CodingProject } from "@mrog/shared";

import { cardsByRef, edgeLabels, linkedFiles, progressText, type LinkedFile } from "./codingBoard";

export interface ChecklistFile {
  /** The node id. */
  id: string;
  path: string;
  purpose: string;
  done: boolean;
}

export interface ChecklistConnector {
  /** The edge id. */
  id: string;
  /** e1, e2, … */
  label: string;
  description: string;
  files: LinkedFile[];
  done: boolean;
}

export interface Checklist {
  files: ChecklistFile[];
  connectors: ChecklistConnector[];
  filesDone: number;
  connectorsDone: number;
  done: number;
  total: number;
  /** "3 of 7 done". */
  summary: string;
}

/**
 * Every file and every connector in the plan, ticked when its card is in Done. A connection with no card of its own
 * (plans have had none since connections are checked inside the file cards) is ticked once every file it links is.
 */
export function buildChecklist(plan: Pick<CodingProject, "nodes" | "edges" | "cards">): Checklist {
  const cards = cardsByRef(plan.cards);
  const labels = edgeLabels(plan.edges);
  const files = plan.nodes.map((node) => ({
    id: node.id,
    path: node.path,
    purpose: node.purpose,
    done: cards.get(node.id)?.column === "done",
  }));
  const connectors = plan.edges.map((edge) => ({
    id: edge.id,
    label: labels.get(edge.id) ?? edge.id,
    description: edge.description,
    files: linkedFiles(edge, plan.nodes),
    done: cards.has(edge.id)
      ? cards.get(edge.id)?.column === "done"
      : edge.files.length > 0 && edge.files.every((id) => cards.get(id)?.column === "done"),
  }));
  const filesDone = files.filter((file) => file.done).length;
  const connectorsDone = connectors.filter((connector) => connector.done).length;
  const done = filesDone + connectorsDone;
  const total = files.length + connectors.length;
  return { files, connectors, filesDone, connectorsDone, done, total, summary: progressText(done, total) };
}

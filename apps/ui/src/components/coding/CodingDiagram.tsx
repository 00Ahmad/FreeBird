import { LayoutGrid, Maximize2, Timer, X, ZoomIn, ZoomOut } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { CodingProject } from "@mrog/shared";
import { Button, cn, IconButton } from "@mrog/ui-kit";

import { edgeLabel } from "../../lib/coding";
import { COLUMN_COLOR, columnLabel, edgeLabels, linkedFiles, relatedRefs } from "../../lib/codingBoard";
import { cornerKind, diagramMarks, emptyPlanText, NO_MARK, type CornerKind } from "../../lib/codingFeedback";
import { cardElapsedSeconds, cardWorkLine, isSlowCard, slowBadge, SLOW_TOOLTIP } from "../../lib/codingWork";
import { fitZoom, layoutDiagram, stepZoom } from "../../lib/codingLayout";
import { Chip, ColumnChip, Comments, KindBadge, tint } from "./parts";

const COLUMNS = ["todo", "in_progress", "qa", "done"] as const;

/** Enter or Space on a focused diagram element does what a click does. */
const activate = (action: () => void) => (event: KeyboardEvent) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
};

/**
 * The plan as a picture: a box per file and, for each connection, a small round junction joined to every file it
 * links. Boxes are coloured by their card's column. Click one to light up what it touches and read its details.
 */
export function CodingDiagram({
  project,
  now,
  selectedRef,
  onSelect,
  onShowOnBoard,
}: {
  project: CodingProject;
  /** The panel's clock, so a slow card is spotted while it runs. */
  now: number;
  selectedRef: string | null;
  onSelect(ref: string | null): void;
  onShowOnBoard(ref: string): void;
}) {
  const layout = useMemo(() => layoutDiagram(project.nodes, project.edges), [project.nodes, project.edges]);
  const marks = useMemo(() => diagramMarks(project, now), [project, now]);
  const labels = useMemo(() => edgeLabels(project.edges), [project.edges]);
  const lit = useMemo(() => relatedRefs(project, selectedRef), [project, selectedRef]);
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const fitted = useRef(false);

  // The first time there is something to draw, fit it across the panel.
  useLayoutEffect(() => {
    if (fitted.current || layout.width === 0 || !scroller.current) return;
    fitted.current = true;
    setZoom(fitZoom(layout.width, scroller.current.clientWidth - 16));
  }, [layout.width]);

  if (layout.width === 0) {
    return <EmptyPlan status={project.status} />;
  }

  const dimmed = (ref: string) => selectedRef !== null && !lit.has(ref);
  const markOf = (ref: string) => marks.get(ref) ?? NO_MARK;
  const colorOf = (ref: string) =>
    markOf(ref).sentBack ? "var(--mrog-danger)" : COLUMN_COLOR[markOf(ref).column];
  /** The state in words, for screen readers and tooltips; colour alone never says it. */
  const stateOf = (ref: string) => {
    const mark = markOf(ref);
    return [
      columnLabel(mark.column),
      mark.working ? "being worked on now" : null,
      mark.sentBack ? "sent back by QA, needs fixing" : null,
      mark.done ? "passed QA" : null,
      mark.slow ? "slow, over 10 minutes" : null,
    ]
      .filter(Boolean)
      .join(", ");
  };
  /** The time and tokens spent on a node's card, for its tooltip. */
  const workOf = (ref: string) => {
    const card = project.cards.find((candidate) => candidate.ref === ref);
    const line = card ? cardWorkLine(card, project, now) : null;
    return line ? ` (${line})` : "";
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <IconButton label="Zoom out" onClick={() => setZoom((z) => stepZoom(z, -1))}>
          <ZoomOut size={15} />
        </IconButton>
        <span className="w-10 text-center text-xs text-ink-2" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <IconButton label="Zoom in" onClick={() => setZoom((z) => stepZoom(z, 1))}>
          <ZoomIn size={15} />
        </IconButton>
        <IconButton
          label="Fit to the panel"
          onClick={() => setZoom(fitZoom(layout.width, (scroller.current?.clientWidth ?? 0) - 16))}
        >
          <Maximize2 size={14} />
        </IconButton>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Colours">
          {COLUMNS.map((column) => (
            <span key={column} className="flex items-center gap-1 text-[11px] text-ink-3">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ background: COLUMN_COLOR[column] }}
              />
              {columnLabel(column)}
            </span>
          ))}
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto p-2">
        <svg
          width={Math.round(layout.width * zoom)}
          height={Math.round(layout.height * zoom)}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label="Plan diagram: files and the connections between them"
          className="block"
          onClick={(event) => event.target === event.currentTarget && onSelect(null)}
        >
          <g fill="none" strokeLinecap="round">
            {layout.links.map((link) => {
              const on = lit.has(link.edgeId) && lit.has(link.fileId);
              return (
                <path
                  key={`${link.edgeId}-${link.fileId}`}
                  d={link.d}
                  stroke={on ? "var(--mrog-accent)" : "var(--mrog-ink-3)"}
                  strokeWidth={on ? 2 : 1.25}
                  opacity={selectedRef !== null && !on ? 0.2 : 0.85}
                />
              );
            })}
          </g>

          {layout.files.map((file) => {
            const node = project.nodes.find((candidate) => candidate.id === file.id)!;
            const color = colorOf(file.id);
            const picked = selectedRef === file.id;
            const mark = markOf(file.id);
            const state = stateOf(file.id);
            const column = columnLabel(mark.column);
            const pick = () => onSelect(picked ? null : file.id);
            return (
              <g
                key={file.id}
                role="button"
                tabIndex={0}
                aria-pressed={picked}
                aria-label={`File ${node.path}, ${state}. ${node.purpose}`}
                onClick={pick}
                onKeyDown={activate(pick)}
                opacity={dimmed(file.id) ? 0.35 : 1}
                className="group cursor-pointer outline-none"
              >
                <title>{`${node.path} (${state})\n${node.purpose}${workOf(file.id)}`}</title>
                {mark.working && (
                  <rect
                    x={file.x - 5}
                    y={file.y - 5}
                    width={file.w + 10}
                    height={file.h + 10}
                    rx={13}
                    fill="none"
                    stroke={color}
                    strokeWidth={2.5}
                    className="coding-ring"
                  />
                )}
                <rect
                  x={file.x - 3}
                  y={file.y - 3}
                  width={file.w + 6}
                  height={file.h + 6}
                  rx={12}
                  fill="none"
                  strokeWidth={2}
                  className="stroke-accent opacity-0 group-focus-visible:opacity-100"
                />
                <rect
                  x={file.x}
                  y={file.y}
                  width={file.w}
                  height={file.h}
                  rx={9}
                  fill={tint(color, 12)}
                  stroke={color}
                  strokeWidth={picked ? 3 : 1.5}
                />
                <circle cx={file.x + 14} cy={file.y + 17} r={4} fill={color} />
                <text
                  x={file.x + 26}
                  y={file.y + 21}
                  fontSize={12}
                  fontWeight={600}
                  className="fill-ink font-mono"
                >
                  {file.pathText}
                </text>
                {file.purposeLines.map((line, index) => (
                  <text
                    key={index}
                    x={file.x + 12}
                    y={file.y + 41 + index * 14}
                    fontSize={11}
                    className="fill-ink-2"
                  >
                    {line}
                  </text>
                ))}
                <text
                  x={file.x + file.w - 10}
                  y={file.y + file.h - 8}
                  textAnchor="end"
                  fontSize={10}
                  fill={color}
                >
                  {column}
                </text>
                {cornerKind(mark) && (
                  <Corner x={file.x + file.w - 2} y={file.y + 2} kind={cornerKind(mark)!} />
                )}
              </g>
            );
          })}

          {layout.junctions.map((junction) => {
            const edge = project.edges.find((candidate) => candidate.id === junction.id)!;
            const color = colorOf(junction.id);
            const picked = selectedRef === junction.id;
            const files = linkedFiles(edge, project.nodes).map((file) => file.path);
            const mark = markOf(junction.id);
            const pick = () => onSelect(picked ? null : junction.id);
            return (
              <g
                key={junction.id}
                role="button"
                tabIndex={0}
                aria-pressed={picked}
                aria-label={`Connector ${junction.label}, ${stateOf(junction.id)}. ${edge.description}. Links ${files.join(", ")}`}
                onClick={pick}
                onKeyDown={activate(pick)}
                opacity={dimmed(junction.id) ? 0.35 : 1}
                className="group cursor-pointer outline-none"
              >
                <title>{`${junction.label} (${stateOf(junction.id)}): ${edge.description}\nLinks: ${files.join(", ")}${workOf(junction.id)}`}</title>
                {mark.working && (
                  <circle
                    cx={junction.x}
                    cy={junction.y}
                    r={junction.r + 6}
                    fill="none"
                    stroke={color}
                    strokeWidth={2.5}
                    className="coding-ring"
                  />
                )}
                <circle
                  cx={junction.x}
                  cy={junction.y}
                  r={junction.r + 4}
                  fill="none"
                  strokeWidth={2}
                  className="stroke-accent opacity-0 group-focus-visible:opacity-100"
                />
                <circle
                  cx={junction.x}
                  cy={junction.y}
                  r={junction.r}
                  fill={tint(color, mark.lit ? 35 : 14)}
                  stroke={color}
                  strokeWidth={picked || mark.lit ? 3 : 1.5}
                  style={mark.lit ? { filter: `drop-shadow(0 0 4px ${color})` } : undefined}
                />
                <text
                  x={junction.x}
                  y={junction.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={10}
                  fontWeight={600}
                  className="fill-ink"
                >
                  {junction.label}
                </text>
                {cornerKind(mark) && (
                  <Corner
                    x={junction.x + junction.r - 1}
                    y={junction.y - junction.r + 1}
                    kind={cornerKind(mark)!}
                    small
                  />
                )}
              </g>
            );
          })}
        </svg>

        {project.edges.length > 0 && (
          <div className="mt-3 px-1 pb-14">
            <h3 className="mb-1.5 text-[12.5px] font-semibold">Connectors</h3>
            <ul className="flex flex-col gap-1">
              {project.edges.map((edge) => (
                <li key={edge.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(selectedRef === edge.id ? null : edge.id)}
                    aria-pressed={selectedRef === edge.id}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left text-[12.5px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent",
                      selectedRef === edge.id && "bg-selected",
                    )}
                  >
                    <Chip color={colorOf(edge.id)}>{labels.get(edge.id)}</Chip>
                    <span className="min-w-0 flex-1">
                      <span className="block">{edge.description}</span>
                      <span className="block truncate font-mono text-[11.5px] text-ink-3">
                        {linkedFiles(edge, project.nodes)
                          .map((file) => file.path)
                          .join("  ·  ")}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {selectedRef && (
        <Details
          project={project}
          now={now}
          refId={selectedRef}
          onClose={() => onSelect(null)}
          onShowOnBoard={() => onShowOnBoard(selectedRef)}
        />
      )}
    </div>
  );
}

function EmptyPlan({ status }: { status: CodingProject["status"] }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <LayoutGrid size={22} className="text-ink-3" />
      <p className="text-[13px] text-ink-2">{emptyPlanText(status, "diagram")}</p>
    </div>
  );
}

/** A round mark on a corner: a "!" when QA sent the card back, a tick when it passed. Icons, not just colour. */
function Corner({ x, y, kind, small }: { x: number; y: number; kind: CornerKind; small?: boolean }) {
  const r = small ? 7 : 9;
  const sentBack = kind === "sentBack";
  const color = sentBack
    ? "var(--mrog-danger)"
    : kind === "slow"
      ? "var(--mrog-warning)"
      : "var(--mrog-success)";
  return (
    <g>
      <title>
        {sentBack ? "QA sent this back" : kind === "slow" ? "Slow: over 10 minutes" : "Passed QA"}
      </title>
      <circle cx={x} cy={y} r={r} fill={color} className="stroke-surface" strokeWidth={1.5} />
      {sentBack ? (
        <text
          x={x}
          y={y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={small ? 10 : 12}
          fontWeight={700}
          className="fill-surface"
        >
          !
        </text>
      ) : kind === "slow" ? (
        <path
          d={`M ${x} ${y - r * 0.5} L ${x} ${y} L ${x + r * 0.4} ${y + r * 0.3}`}
          fill="none"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-surface"
        />
      ) : (
        <path
          d={`M ${x - r * 0.45} ${y} l ${r * 0.3} ${r * 0.32} l ${r * 0.6} ${-r * 0.65}`}
          fill="none"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-surface"
        />
      )}
    </g>
  );
}

/** The full purpose or description of the picked file or connector, and the comments on its card. */
function Details({
  project,
  now,
  refId,
  onClose,
  onShowOnBoard,
}: {
  project: CodingProject;
  now: number;
  refId: string;
  onClose(): void;
  onShowOnBoard(): void;
}) {
  const node = project.nodes.find((candidate) => candidate.id === refId);
  const edgeIndex = project.edges.findIndex((candidate) => candidate.id === refId);
  const edge = edgeIndex >= 0 ? project.edges[edgeIndex]! : null;
  const card = project.cards.find((candidate) => candidate.ref === refId);
  if (!node && !edge) return null;
  const workLine = card ? cardWorkLine(card, project, now) : null;
  const slow = card ? isSlowCard(card, project, now) : false;
  const touching = node
    ? project.edges.flatMap((e, i) => (e.files.includes(node.id) ? [[e, i] as const] : []))
    : [];

  return (
    <div
      role="dialog"
      aria-label="Details"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
      className="absolute inset-x-3 bottom-3 z-20 flex max-h-[55%] flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-surface p-3 text-[12.5px] shadow-[var(--mrog-shadow)]"
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <KindBadge kind={edge ? "connector" : "file"} />
            {edge && <Chip color="var(--mrog-ink-2)">{edgeLabel(edgeIndex)}</Chip>}
            {card && <ColumnChip column={card.column} />}
          </div>
          <p className={cn("font-medium break-all select-text", node && "font-mono")}>
            {node ? node.path : (card?.title ?? "Connector")}
          </p>
        </div>
        <Button size="sm" variant="subtle" onClick={onShowOnBoard} disabled={!card}>
          Show on board
        </Button>
        <IconButton label="Close details" onClick={onClose} autoFocus>
          <X size={14} />
        </IconButton>
      </div>
      <p className="leading-snug select-text">{node ? node.purpose : edge?.description}</p>
      {workLine && (
        <p className="flex flex-wrap items-center gap-2 text-ink-3 tabular-nums">
          {workLine}
          {slow && (
            <span
              title={SLOW_TOOLTIP}
              className="inline-flex items-center gap-1 rounded-full bg-hover px-1.5 py-px text-[11px] font-semibold text-warning"
            >
              <Timer size={11} aria-hidden /> {slowBadge(cardElapsedSeconds(card!, project, now))}
            </span>
          )}
        </p>
      )}
      {edge && (
        <ul className="flex flex-wrap gap-1" aria-label="Links these files">
          {linkedFiles(edge, project.nodes).map((file) => (
            <li key={file.id} className="rounded bg-hover px-1.5 py-px font-mono text-[11.5px] text-ink-2">
              {file.path}
            </li>
          ))}
        </ul>
      )}
      {touching.length > 0 && (
        <p className="text-ink-3">
          Connected through{" "}
          {touching.map(([e, i], index) => (
            <span key={e.id}>
              {index > 0 && ", "}
              <span className="font-medium text-ink-2" title={e.description}>
                {edgeLabel(i)}
              </span>
            </span>
          ))}
        </p>
      )}
      {card ? (
        card.comments.length > 0 ? (
          <Comments card={card} />
        ) : (
          <p className="text-ink-3">No comments on this card yet.</p>
        )
      ) : (
        <p className="text-ink-3">This has no card on the board yet.</p>
      )}
    </div>
  );
}

import { MAX_PLAN_EDGES, MAX_PLAN_FILES, type CodingProject } from "@mrog/shared";

import { edgeLabel } from "./coding";
import { cardsByRef, progressText, sortComments } from "./codingBoard";
import { buildChecklist } from "./codingChecklist";
import { cornerKind, diagramMarks, type CornerKind } from "./codingFeedback";
import { layoutDiagram, wrapText } from "./codingLayout";

/** What the exports read from a project. */
type Plan = Pick<CodingProject, "brief" | "nodes" | "edges">;
type Exportable = Plan & Pick<CodingProject, "cards" | "status">;

export const PLAN_FORMAT = "freebird-coding-plan";
export const PLAN_VERSION = 1;
export const SNAPSHOT_FORMAT = "freebird-coding-snapshot";

/** The file the Plan export writes and Import reads: paths, not internal ids, so a plan written anywhere works. */
export interface CodingPlanFile {
  format: typeof PLAN_FORMAT;
  version: typeof PLAN_VERSION;
  brief: string;
  nodes: { path: string; purpose: string }[];
  edges: { files: string[]; description: string }[];
}

/** The plan as a file, files in the order the Planner chose to build them. */
export function planToFile(project: Plan): CodingPlanFile {
  const paths = new Map(project.nodes.map((node) => [node.id, node.path]));
  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    brief: project.brief,
    nodes: project.nodes.map((node) => ({ path: node.path, purpose: node.purpose })),
    edges: project.edges.flatMap((edge) => {
      const files = edge.files.flatMap((id) => paths.get(id) ?? []);
      // A connection that lost files links nothing any more.
      return files.length >= 2 ? [{ files, description: edge.description }] : [];
    }),
  };
}

/** One line of text: a description with line breaks and runs of spaces becomes a single tidy line. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The plan, and where it stands, for a person to read. */
export function toMarkdown(project: Exportable, title = "Coding plan"): string {
  const list = buildChecklist(project);
  const paths = new Map(project.nodes.map((node) => [node.id, node.path]));
  const out: string[] = [`# ${oneLine(title) || "Coding plan"}`, ""];
  if (project.brief.trim())
    out.push(
      ...project.brief
        .trim()
        .split("\n")
        .map((line) => `> ${line}`),
      "",
    );
  out.push(`## Files (${project.nodes.length})`, "");
  for (const node of project.nodes) out.push(`- \`${node.path}\`: ${oneLine(node.purpose)}`);
  if (project.nodes.length === 0) out.push("No files yet.");
  out.push("", `## Connections (${project.edges.length})`, "");
  project.edges.forEach((edge, index) => {
    const files = edge.files.map((id) => `\`${paths.get(id) ?? id}\``).join(", ");
    out.push(`- **${edgeLabel(index)}** ${oneLine(edge.description)}: ${files}`);
  });
  if (project.edges.length === 0) out.push("No connections.");
  out.push("", `## Checklist (${progressText(list.done, list.total)})`, "");
  out.push("Files", "");
  for (const file of list.files) out.push(`- [${file.done ? "x" : " "}] \`${file.path}\``);
  out.push("", "Connectors", "");
  for (const connector of list.connectors)
    out.push(
      `- [${connector.done ? "x" : " "}] **${connector.label}** ${oneLine(connector.description)} (${connector.files.map((f) => `\`${f.path}\``).join(", ")})`,
    );
  return `${out.join("\n")}\n`;
}

/** Text for a Mermaid label: quotes, angle brackets, ampersands and # become entity codes, and lines become one. */
export function mermaidText(text: string): string {
  return oneLine(text)
    .replaceAll("#", "#35;")
    .replaceAll('"', "#quot;")
    .replaceAll("<", "#lt;")
    .replaceAll(">", "#gt;")
    .replaceAll("&", "#amp;")
    .replaceAll("`", "#96;");
}

/**
 * A Mermaid flowchart. A connection of two files is a labelled line; one that links three or more is a junction node
 * joined to each of them, as on the screen.
 */
export function toMermaid(project: Plan): string {
  const ids = new Map(project.nodes.map((node, index) => [node.id, `f${index + 1}`]));
  const out = ["flowchart LR"];
  for (const node of project.nodes) out.push(`  ${ids.get(node.id)}["${mermaidText(node.path)}"]`);
  project.edges.forEach((edge, index) => {
    const files = [...new Set(edge.files)].flatMap((id) => ids.get(id) ?? []);
    if (files.length < 2) return;
    const label = mermaidText(edge.description);
    if (files.length === 2) out.push(`  ${files[0]} ---|"${label}"| ${files[1]}`);
    else {
      out.push(`  j${index + 1}(["${edgeLabel(index)}: ${label}"])`);
      for (const file of files) out.push(`  ${file} --- j${index + 1}`);
    }
  });
  return `${out.join("\n")}\n`;
}

/** A backup of the whole project: the plan, the board with its comments, the round and the log. Not a plan to import. */
export function snapshotOf(project: CodingProject, now: Date) {
  const paths = new Map(project.nodes.map((node) => [node.id, node.path]));
  const labels = new Map(project.edges.map((edge, index) => [edge.id, edgeLabel(index)]));
  return {
    format: SNAPSHOT_FORMAT,
    version: PLAN_VERSION,
    exportedAt: now.toISOString(),
    status: project.status,
    outputFolder: project.outputFolder,
    round: project.round,
    maxRounds: project.maxRounds,
    plan: planToFile(project),
    cards: project.cards.map((card) => ({
      kind: card.kind,
      // The file's path, or the connection's label (e1, e2, … in the plan's order).
      ref: card.kind === "file" ? (paths.get(card.ref) ?? card.ref) : (labels.get(card.ref) ?? card.ref),
      title: card.title,
      column: card.column,
      comments: sortComments(card.comments),
    })),
    log: project.log ?? [],
  };
}

/** The text a flagship model needs to write a plan this app can import. */
export function planningPrompt(brief: string): string {
  const example = {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    nodes: [
      { path: "src/main.py", purpose: "Starts the app and wires the other files together." },
      { path: "src/storage.py", purpose: "Saves and loads the data as JSON." },
    ],
    edges: [
      {
        files: ["src/main.py", "src/storage.py"],
        description: "main.py calls load() and save() from storage.py.",
      },
    ],
  };
  return [
    "You are the planner for a software project that a team of coding agents will build. Plan the files and how they connect. Do not write the code.",
    "",
    "Project:",
    brief.trim() || "(Describe the project here.)",
    "",
    "Answer with JSON only, in exactly this format:",
    "",
    JSON.stringify(example, null, 2),
    "",
    "Rules:",
    `- "nodes" lists every file, in the order they should be built (what others depend on first). At most ${MAX_PLAN_FILES} files.`,
    '- Each file has a "path" and a "purpose". Paths are relative to the project folder, with forward slashes: no leading slash, no drive letter, no "..". List files, not folders.',
    "- Every file has a purpose: one or two sentences on what the code in it should do.",
    `- "edges" lists the connections between files. At most ${MAX_PLAN_EDGES} connections.`,
    '- A connection links 2 or more of the files listed in "nodes" (use their exact paths in "files") and has a "description" of what connects them: a function call, shared data, an import, an API.',
    "- Every file should be in at least one connection, unless it stands alone.",
    "- Do not add any text before or after the JSON, and do not wrap it in anything else.",
  ].join("\n");
}

// ---- file names -------------------------------------------------------------------------------------------------

export type ExportKind = "plan" | "markdown" | "mermaid" | "svg" | "snapshot";

const EXPORT_SUFFIX: Record<ExportKind, string> = {
  plan: "plan.json",
  markdown: "plan.md",
  mermaid: "plan.mmd",
  svg: "diagram.svg",
  snapshot: "snapshot.json",
};

export const MIME: Record<ExportKind, string> = {
  plan: "application/json",
  markdown: "text/markdown",
  mermaid: "text/plain",
  svg: "image/svg+xml",
  snapshot: "application/json",
};

/** "My Coding Bot!" becomes "my-coding-bot"; the download name is `<that>-plan.json` and so on. */
export function exportName(botName: string, kind: ExportKind): string {
  const slug = botName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${slug || "coding-bot"}-${EXPORT_SUFFIX[kind]}`;
}

// ---- SVG --------------------------------------------------------------------------------------------------------

/** The light colours of the app, as plain values: an exported picture can't use the app's CSS variables. */
const LIGHT = {
  paper: "#ffffff",
  ink: "#1c1b19",
  ink2: "#5b5850",
  ink3: "#8d897f",
  border: "#e3e0d7",
  todo: "#8d897f",
  in_progress: "#b45309",
  qa: "#3b9ae6",
  done: "#16a34a",
  danger: "#c2410c",
} as const;

/** `percent` of `color` over white, as a hex colour (SVG readers outside a browser don't know color-mix). */
export function tintHex(color: string, percent: number): string {
  const channels = [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16));
  const mixed = channels.map((value) => Math.round(value * (percent / 100) + 255 * (1 - percent / 100)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Characters XML 1.0 can't hold at all, even escaped: the C0 controls but tab, line feed and carriage return,
 * unpaired surrogates, and U+FFFE / U+FFFF. A plan from a model can carry them; one would make the file unreadable.
 */
// With the u flag a surrogate pair is one character (an emoji stays), so the surrogate range only catches lone ones.
// oxlint-disable-next-line no-control-regex -- matching those characters is the point
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\u{FFFE}\u{FFFF}]/gu;

export const xmlEscape = (text: string): string =>
  text
    .replace(NOT_XML, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** About how wide a character of the legend is (11px sans): enough to wrap it inside the picture. */
const LEGEND_CHAR_W = 6.2;
/** A connection's description is wrapped onto this many lines at most, then cut with "…". */
const LEGEND_LINES = 3;
const LEGEND_LINE_H = 16;

/**
 * The legend under the picture: a line per connection, wrapped to the picture's width (a small picture would cut
 * long lines off) and kept to a few lines each.
 */
export function legendLines(
  edges: readonly { description: string }[],
  width: number,
): { label: string; lines: string[] }[] {
  const chars = Math.max(20, Math.floor((width - 48) / LEGEND_CHAR_W));
  return edges.map((edge, index) => {
    const label = edgeLabel(index);
    // The label starts the first line; the rest of the lines line up under the text.
    const { lines } = wrapText(oneLine(edge.description), chars - label.length - 2, LEGEND_LINES);
    return { label, lines: lines.length ? lines : [""] };
  });
}

/**
 * The diagram as a stand-alone SVG file: the same layout as on the screen, drawn in the app's light colours with
 * every style written in (no CSS variables, no classes), so it opens in any viewer.
 */
export function toSvg(project: Exportable): string {
  const layout = layoutDiagram(project.nodes, project.edges);
  const marks = diagramMarks({ ...project, status: "stopped" });
  const cards = cardsByRef(project.cards);
  const colorOf = (ref: string) => {
    const mark = marks.get(ref);
    return mark?.sentBack ? LIGHT.danger : LIGHT[mark?.column ?? "todo"];
  };
  const mono = "ui-monospace, SFMono-Regular, Consolas, Menlo, monospace";
  const sans = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  const width = Math.max(layout.width, 320);
  const legend = legendLines(project.edges, width);
  const legendRows = legend.reduce((sum, entry) => sum + entry.lines.length, 0);
  const legendTop = layout.height + 8;
  const height = (layout.height || 48) + (legend.length ? 28 + legendRows * LEGEND_LINE_H : 0);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Plan diagram">`,
    `<title>Plan diagram</title>`,
    `<rect width="${width}" height="${height}" fill="${LIGHT.paper}"/>`,
  ];
  if (layout.files.length === 0)
    parts.push(
      `<text x="24" y="30" font-size="13" font-family="${sans}" fill="${LIGHT.ink2}">This plan has no files yet.</text>`,
    );

  for (const link of layout.links)
    parts.push(
      `<path d="${link.d}" fill="none" stroke="${LIGHT.ink3}" stroke-width="1.25" stroke-linecap="round"/>`,
    );

  for (const file of layout.files) {
    const node = project.nodes.find((candidate) => candidate.id === file.id)!;
    const mark = marks.get(file.id);
    const color = colorOf(file.id);
    const column = cards.get(file.id)?.column ?? "todo";
    parts.push(
      `<g><title>${xmlEscape(`${node.path}\n${node.purpose}`)}</title>`,
      `<rect x="${file.x}" y="${file.y}" width="${file.w}" height="${file.h}" rx="9" fill="${tintHex(color, 12)}" stroke="${color}" stroke-width="1.5"/>`,
      `<circle cx="${file.x + 14}" cy="${file.y + 17}" r="4" fill="${color}"/>`,
      `<text x="${file.x + 26}" y="${file.y + 21}" font-size="12" font-weight="600" font-family="${mono}" fill="${LIGHT.ink}">${xmlEscape(file.pathText)}</text>`,
      ...file.purposeLines.map(
        (line, index) =>
          `<text x="${file.x + 12}" y="${file.y + 41 + index * 14}" font-size="11" font-family="${sans}" fill="${LIGHT.ink2}">${xmlEscape(line)}</text>`,
      ),
      `<text x="${file.x + file.w - 10}" y="${file.y + file.h - 8}" text-anchor="end" font-size="10" font-family="${sans}" fill="${color}">${xmlEscape(columnWord(column))}</text>`,
      ...(cornerKind(mark) ? [corner(file.x + file.w - 2, file.y + 2, cornerKind(mark)!, 9)] : []),
      `</g>`,
    );
  }

  for (const junction of layout.junctions) {
    const edgeIndex = project.edges.findIndex((edge) => edge.id === junction.id);
    const edge = project.edges[edgeIndex]!;
    const mark = marks.get(junction.id);
    const color = colorOf(junction.id);
    parts.push(
      `<g><title>${xmlEscape(`${junction.label}: ${edge.description}`)}</title>`,
      `<circle cx="${junction.x}" cy="${junction.y}" r="${junction.r}" fill="${tintHex(color, 14)}" stroke="${color}" stroke-width="1.5"/>`,
      `<text x="${junction.x}" y="${junction.y}" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="600" font-family="${sans}" fill="${LIGHT.ink}">${xmlEscape(junction.label)}</text>`,
      ...(cornerKind(mark)
        ? [corner(junction.x + junction.r - 1, junction.y - junction.r + 1, cornerKind(mark)!, 7)]
        : []),
      `</g>`,
    );
  }

  if (legend.length) {
    parts.push(
      `<line x1="24" y1="${legendTop}" x2="${width - 24}" y2="${legendTop}" stroke="${LIGHT.border}"/>`,
    );
    let row = 0;
    for (const entry of legend) {
      const indent = 24 + Math.ceil((entry.label.length + 2) * LEGEND_CHAR_W);
      entry.lines.forEach((line, index) => {
        const y = legendTop + 20 + row * LEGEND_LINE_H;
        parts.push(
          `<text x="${index === 0 ? 24 : indent}" y="${y}" font-size="11" font-family="${sans}" fill="${LIGHT.ink2}">${xmlEscape(index === 0 ? `${entry.label}  ${line}` : line)}</text>`,
        );
        row += 1;
      });
    }
  }
  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}

const columnWord = (column: string) =>
  ({ todo: "Todo", in_progress: "In progress", qa: "QA", done: "Done" })[column] ?? column;

/** The corner mark: "!" on red when QA sent the card back, a tick on green when it passed, a clock on amber when slow. */
function corner(x: number, y: number, kind: CornerKind, r: number): string {
  const sentBack = kind === "sentBack";
  const color = sentBack ? LIGHT.danger : kind === "slow" ? LIGHT.in_progress : LIGHT.done;
  const inside = sentBack
    ? `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="${r + 3}" font-weight="700" fill="#ffffff">!</text>`
    : kind === "slow"
      ? `<path d="M ${x} ${y - r * 0.5} L ${x} ${y} L ${x + r * 0.4} ${y + r * 0.3}" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M ${x - r * 0.45} ${y} l ${r * 0.3} ${r * 0.32} l ${r * 0.6} ${-r * 0.65}" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>${inside}`;
}

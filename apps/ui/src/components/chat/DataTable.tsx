import { ArrowDown, ArrowUp, Check, Copy, Download } from "lucide-react";
import { Children, isValidElement, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { cellNumber, downloadText, toCsv } from "../../lib/export";

/** The parts of a Markdown syntax-tree node the table needs. */
interface TreeNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: TreeNode[];
}

const textOf = (node: TreeNode): string =>
  node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("");

const rowsOf = (section: TreeNode | undefined) =>
  (section?.children ?? [])
    .filter((child) => child.tagName === "tr")
    .map((row) =>
      (row.children ?? [])
        .filter((cell) => cell.tagName === "td" || cell.tagName === "th")
        .map((cell) => textOf(cell).trim()),
    );

/**
 * A Markdown table in a bot reply: click a column to sort it (numbers sort as numbers, e.g. prices), and copy or
 * download it as CSV. Cells keep their formatting and links.
 */
export function DataTable({ node, children }: { node?: TreeNode; children?: ReactNode }) {
  const [sort, setSort] = useState<{ column: number; direction: 1 | -1 } | null>(null);
  const [copied, setCopied] = useState(false);

  const header = rowsOf(node?.children?.find((child) => child.tagName === "thead"))[0] ?? [];
  const body = rowsOf(node?.children?.find((child) => child.tagName === "tbody"));
  const parts = Children.toArray(children).filter(isValidElement) as ReactElement<{ children?: ReactNode }>[];
  const tbody = parts.find((part) => part.type === "tbody");
  const rows = tbody ? Children.toArray(tbody.props.children).filter(isValidElement) : [];

  const order = useMemo(() => {
    const indices = body.map((_, index) => index);
    if (!sort) return indices;
    const cells = body.map((row) => row[sort.column] ?? "");
    const numeric = cells.every((cell) => cell === "" || cellNumber(cell) !== null);
    return indices.toSorted((a, b) => {
      const [x, y] = [cells[a]!, cells[b]!];
      const compared = numeric
        ? (cellNumber(x) ?? Number.NEGATIVE_INFINITY) - (cellNumber(y) ?? Number.NEGATIVE_INFINITY)
        : x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
      return compared * sort.direction;
    });
  }, [body, sort]);

  // Without the syntax tree (or if rows don't line up) show the table as written.
  if (header.length === 0 || rows.length !== body.length) return <table>{children}</table>;

  const csv = (bom = true) => toCsv([header, ...order.map((index) => body[index]!)], { bom });
  const toolButton =
    "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-3 hover:bg-hover hover:text-ink";

  return (
    <div className="group/table">
      <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover/table:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          className={toolButton}
          onClick={() => {
            void navigator.clipboard.writeText(csv(false));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} Copy CSV
        </button>
        <button
          type="button"
          className={toolButton}
          onClick={() => downloadText("table.csv", csv(), "text/csv;charset=utf-8")}
        >
          <Download size={12} /> Download CSV
        </button>
      </div>
      <table>
        <thead>
          <tr>
            {header.map((title, column) => (
              <th key={column} aria-sort={sortState(sort, column)}>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 font-[inherit] hover:text-accent"
                  title="Sort by this column"
                  onClick={() =>
                    setSort((current) =>
                      current?.column === column
                        ? current.direction === 1
                          ? { column, direction: -1 }
                          : null
                        : { column, direction: 1 },
                    )
                  }
                >
                  {title}
                  {sort?.column === column &&
                    (sort.direction === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{order.map((index) => rows[index])}</tbody>
      </table>
    </div>
  );
}

function sortState(sort: { column: number; direction: 1 | -1 } | null, column: number) {
  if (sort?.column !== column) return "none" as const;
  return sort.direction === 1 ? ("ascending" as const) : ("descending" as const);
}

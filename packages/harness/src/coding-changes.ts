import type { FileContract, Link } from "./coding-contract";

/**
 * What changed in a file, for QA and for deciding what to check again. QA reviewing a card a second time gets the
 * lines that changed since it last looked, next to the comment that asked for them, instead of the whole file again;
 * and a passed card goes back to QA only when a file it relies on changed what it provides (its contract), not on
 * every edit nearby: the code check at the start of every QA pass covers the rest.
 */

/** Longest file (in lines) a diff is worked out for; a bigger one is "rewritten", read in full. */
const MAX_LINES = 1500;
/** Most changed lines shown; more than that is a rewrite, read in full. */
const MAX_SHOWN = 120;
/** Unchanged lines shown around each change. */
const CONTEXT = 2;

type Op = { kind: " " | "-" | "+"; text: string; line: number };

/** The edit script from `before` to `after`, line by line (longest common subsequence). */
function editScript(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j]: the longest common run of before[i…] and after[j…], filled from the end.
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      ops.push({ kind: " ", text: after[j]!, line: j + 1 });
      i += 1;
      j += 1;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // A line replaced reads as the old one taken out, then the new one put in.
      ops.push({ kind: "-", text: before[i]!, line: j + 1 });
      i += 1;
    } else {
      ops.push({ kind: "+", text: after[j]!, line: j + 1 });
      j += 1;
    }
  }
  return ops;
}

/**
 * The lines that changed from `before` to `after`, with a little context, each block headed by the line it is at in
 * the new file; "" when nothing changed; null when the change is too big to show as a diff (read the file in full).
 */
export function lineDiff(before: string, after: string): string | null {
  if (before === after) return "";
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;
  const ops = editScript(a, b);
  const changed = ops.filter((op) => op.kind !== " ").length;
  if (changed > MAX_SHOWN) return null;
  const keep = new Set<number>();
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k++)
      keep.add(k);
  });
  const out: string[] = [];
  let last = -2;
  ops.forEach((op, index) => {
    if (!keep.has(index)) return;
    if (index !== last + 1) out.push(`@@ around line ${op.line} @@`);
    out.push(`${op.kind} ${op.text}`);
    last = index;
  });
  return out.join("\n");
}

/** What a file provides to the others, as one comparable string: its ids, classes, exports and what it loads. */
export function providedBy(contract: FileContract | undefined): string {
  if (!contract) return "";
  const sorted = (values: readonly string[] | null) => [...(values ?? [])].toSorted().join(",");
  return [
    sorted(contract.ids),
    sorted(contract.classes),
    sorted(contract.exports),
    sorted(contract.loads),
  ].join("|");
}

/** The files linked to `path` in the code, either way: those it loads or imports, and those that load or import it. */
export function linkedTo(path: string, links: readonly Link[]): string[] {
  const out = new Set<string>();
  for (const link of links) {
    if (link.from === path) out.add(link.to);
    if (link.to === path) out.add(link.from);
  }
  return [...out];
}

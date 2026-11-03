/** A plain number ("-15%", "+3", "1,200.5"), which a spreadsheet should still read as one. */
const PLAIN_NUMBER = /^[-+]?\d[\d,]*(\.\d+)?%?$/;

/**
 * A table as CSV (RFC 4180 quoting). For a file, a byte-order mark makes spreadsheet apps read UTF-8 correctly; leave
 * it out (`bom: false`) for the clipboard. Cells that a spreadsheet would run as a formula (=, +, -, @ at the start;
 * table text often comes from web pages) get a leading ' so they show as text.
 */
export function toCsv(rows: string[][], { bom = true }: { bom?: boolean } = {}): string {
  const cell = (raw: string) => {
    const value = /^[=+\-@\t\r]/.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  };
  return `${bom ? "\uFEFF" : ""}${rows.map((row) => row.map(cell).join(",")).join("\r\n")}`;
}

/** Saves text as a file through the browser's download (the desktop shell asks where). */
export function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A safe file name from a title. */
export function fileName(title: string, extension: string): string {
  const base =
    title
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "export";
  return `${base}.${extension}`;
}

/**
 * The number a table cell holds ("Rs. 32,682" → 32682, "-15%" → -15, "5,500 mAh" → 5500), or null when the cell
 * isn't a number with at most a short unit around it (a date like 2024-01-05, "8GB/128GB", plain text).
 */
export function cellNumber(value: string): number | null {
  const match =
    /^\s*(?:[^\d\s+-]{1,4}\.?\s*)?([-+]?\d[\d,]*(?:\.\d+)?)\s*(?:%|[^\d\s.,/:-]{1,5}\.?)?\s*$/u.exec(value);
  return match ? Number(match[1]!.replaceAll(",", "")) : null;
}

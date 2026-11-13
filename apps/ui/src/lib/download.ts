/** Saves text as a file: a Blob behind a temporary link, which works in the browser and in the desktop app. */
export function downloadText(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // After the browser has taken it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

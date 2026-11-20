/** How much of a page a Checker's task keeps in its thread once the turn has ended. */
export const KEPT_PAGE_CHARS = 800;

/**
 * A Checker's task as it is kept in its thread after the turn (one copy for the Job Bot and the Client Bot): the
 * page's text between `start` and `end` cut to its first KEPT_PAGE_CHARS, with everything else (the address, the
 * requirements), so the thread still shows what was checked without holding every page read.
 */
export function keepPageStart(task: string, start: string, end: string, chars = KEPT_PAGE_CHARS): string {
  const from = task.indexOf(start);
  const to = task.indexOf(end);
  if (from < 0 || to < 0) return task;
  const page = task.slice(from + start.length, to).trim();
  if (page.length <= chars) return task;
  return [
    task.slice(0, from + start.length),
    page.slice(0, chars),
    "…(the rest of the page was left out once it was checked)",
    task.slice(to),
  ].join("\n");
}

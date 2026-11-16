import type { CDPSession, Page } from "playwright-core";

import type { ControlIssue, PageProblem } from "@mrog/visual-qa";

/** Problems kept per tab before the oldest are dropped. */
const MAX_PROBLEMS = 60;

/** The first web address in a stack trace: where an error was thrown. */
const firstUrl = (text: string) => /\bhttps?:\/\/[^\s)]+?(?=:\d+:\d+|\)|\s|$)/.exec(text)?.[0];

/**
 * Records what goes wrong in a tab: uncaught errors, console errors, requests that failed and answers of 400 and up.
 * The browser's own "Failed to load resource" console line is left out: the failed answer itself is recorded.
 */
export function watchPageProblems(page: Page, problems: PageProblem[]): void {
  const push = (problem: PageProblem) => {
    problems.push(problem);
    if (problems.length > MAX_PROBLEMS) problems.splice(0, problems.length - MAX_PROBLEMS);
  };
  page.on("pageerror", (error) => {
    const source = firstUrl(error.stack ?? "");
    push({ type: "error", text: `${error.name}: ${error.message}`, ...(source ? { source } : {}) });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/^Failed to load resource\b/.test(text)) return;
    const source = message.location().url;
    push({ type: "console", text, ...(source ? { source } : {}) });
  });
  page.on("requestfailed", (request) =>
    push({ type: "request", url: request.url(), text: request.failure()?.errorText ?? "failed" }),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) push({ type: "response", url: response.url(), status: response.status() });
  });
}

/** Plain text of a problem, for QA to read. */
export function problemText(problem: PageProblem): string {
  if (problem.type === "response") return `HTTP ${problem.status} for ${problem.url}`;
  if (problem.type === "request") return `Failed to load ${problem.url} (${problem.text})`;
  return `${problem.type === "error" ? "Uncaught" : "Console error"}: ${problem.text}${problem.source ? ` (at ${problem.source})` : ""}`;
}

/** Shared by the page scripts: what a control is called, the way a person would name it. */
const NAME_OF = `(el) => {
  const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || "").trim().replace(/\\s+/g, " ").slice(0, 80);
  if (text) return text;
  if (el.id) return "#" + el.id;
  const cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/)[0] : "";
  return el.tagName.toLowerCase() + (cls ? "." + cls : "");
}`;

/** Whether a control is shown at all (not display:none, hidden, or inside something hidden). */
const SHOWN = `(el) => {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || el.closest("[hidden],[aria-hidden='true']")) return false;
  return el.offsetParent !== null || style.position === "fixed" || el.tagName === "BODY";
}`;

/** Controls that are shown but can't be used: covered by something else, or with no size. */
const LAYOUT_SCRIPT = `(() => {
  const nameOf = ${NAME_OF};
  const shown = ${SHOWN};
  const out = [];
  const isButton = (el) => el.matches("button, input[type=button], input[type=submit], input[type=reset], [role=button]");
  const controls = document.querySelectorAll("button, input[type=button], input[type=submit], input[type=reset], [role=button], select, input:not([type=hidden]), textarea");
  for (const el of controls) {
    if (out.length >= 20) break;
    if (!shown(el)) continue;
    // A control made see-through on purpose is a styled one: a custom checkbox's real input sits under its picture.
    if (getComputedStyle(el).opacity === "0") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) {
      // Text boxes and ticks hidden by size are a common styling trick; a button with no size is a real problem.
      if (isButton(el)) out.push({ kind: "no-size", label: nameOf(el) });
      continue;
    }
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    const top = document.elementFromPoint(x, y);
    if (!top || top === el || el.contains(top) || top.contains(el)) continue;
    // Its own label (or what's drawn inside it) on top passes a click on to it.
    if ([...(el.labels ?? [])].some((label) => label.contains(top))) continue;
    out.push({ kind: "covered", label: nameOf(el), by: nameOf(top) });
  }
  return out;
})()`;

/** Events a click sets off: a control listening to none of them, on itself or around it, does nothing when clicked. */
const CLICK_EVENTS = new Set([
  "click",
  "mousedown",
  "mouseup",
  "pointerdown",
  "pointerup",
  "touchstart",
  "touchend",
  "dblclick",
]);

/**
 * Collects the buttons to check into a global: each with its own click property, whether it submits a form, and the
 * nodes from it up to the window (where a framework or a delegated handler listens). Answers with their count.
 */
const COLLECT_BUTTONS = `(() => {
  const nameOf = ${NAME_OF};
  const shown = ${SHOWN};
  const nodes = [];
  const index = new Map();
  const at = (node) => {
    if (!index.has(node)) { index.set(node, nodes.length); nodes.push(node); }
    return index.get(node);
  };
  const buttons = [];
  for (const el of document.querySelectorAll("button, input[type=button], input[type=submit], [role=button]")) {
    if (buttons.length >= 40) break;
    if (!shown(el) || el.disabled) continue;
    const submits = !!el.form && (el.type === "submit" || (el.tagName === "BUTTON" && !el.getAttribute("type")));
    const own = typeof el.onclick === "function" || el.hasAttribute("onclick");
    const chain = [];
    for (let node = el; node; node = node.parentNode) chain.push(at(node));
    chain.push(at(window));
    buttons.push({ label: nameOf(el), handled: own || submits || !!el.closest("a[href]"), chain });
  }
  window.__mrogButtons = { nodes, buttons: buttons.map(({ label, handled, chain }) => ({ label, handled, chain })) };
  return buttons.length;
})()`;

const CLEAN_UP = `delete window.__mrogButtons`;

interface Collected {
  nodes: unknown[];
  buttons: { label: string; handled: boolean; chain: number[] }[];
}

/** Which of `objectIds` (by index) have a listener for a click event; CDP looks at each node itself only. */
async function listening(cdp: CDPSession, objectIds: (string | undefined)[]): Promise<Set<number>> {
  const found = new Set<number>();
  await Promise.all(
    objectIds.map(async (objectId, index) => {
      if (!objectId) return;
      const { listeners } = (await cdp
        .send("DOMDebugger.getEventListeners", { objectId, depth: 0 })
        .catch(() => ({ listeners: [] }))) as { listeners: { type: string }[] };
      if (listeners.some((listener) => CLICK_EVENTS.has(listener.type))) found.add(index);
    }),
  );
  return found;
}

/**
 * Buttons that do nothing when clicked: no click handler on them, on anything around them up to the window, no
 * onclick, no form they submit, no link they sit in. Conservative: a handler anywhere above (React's on its root, a
 * library's on the document) counts as handling it. Empty when the browser can't say.
 */
async function deadButtons(page: Page): Promise<ControlIssue[]> {
  let cdp: CDPSession | undefined;
  try {
    const count = (await page.evaluate(COLLECT_BUTTONS)) as number;
    if (!count) return [];
    cdp = await page.context().newCDPSession(page);
    const { result } = (await cdp.send("Runtime.evaluate", {
      expression: "window.__mrogButtons.nodes",
      returnByValue: false,
    })) as { result: { objectId?: string } };
    if (!result.objectId) return [];
    const { result: props } = (await cdp.send("Runtime.getProperties", {
      objectId: result.objectId,
      ownProperties: true,
    })) as { result: { name: string; value?: { objectId?: string } }[] };
    const ids: (string | undefined)[] = [];
    for (const prop of props) if (/^\d+$/.test(prop.name)) ids[Number(prop.name)] = prop.value?.objectId;
    const heard = await listening(cdp, ids);
    const collected = (await page.evaluate("window.__mrogButtons")) as Collected;
    return collected.buttons
      .filter((button) => !button.handled && !button.chain.some((node) => heard.has(node)))
      .map((button) => ({ kind: "no-handler" as const, label: button.label }));
  } catch {
    return [];
  } finally {
    await page.evaluate(CLEAN_UP).catch(() => {});
    await cdp?.detach().catch(() => {});
  }
}

/** Layout problems and dead buttons on the page now. */
export async function checkControls(page: Page): Promise<ControlIssue[]> {
  const layout = ((await page.evaluate(LAYOUT_SCRIPT).catch(() => [])) as ControlIssue[]) ?? [];
  return [...(await deadButtons(page)), ...layout];
}

/** What a marked control looks like to the page: shown, enabled, size, what covers it, and whether a click is handled. */
export async function inspectMark(page: Page, ref: number): Promise<string> {
  const selector = `[data-mrog-ref="${ref}"]`;
  const facts = (await page
    .evaluate(
      `(() => {
        const nameOf = ${NAME_OF};
        const shown = ${SHOWN};
        const el = document.querySelector('${selector}');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
        const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
        const top = document.elementFromPoint(x, y);
        const covered = top && top !== el && !el.contains(top) && !(top.tagName === "LABEL" && top.control === el) ? nameOf(top) : null;
        return {
          name: nameOf(el),
          tag: el.tagName.toLowerCase() + (el.type ? "[type=" + el.type + "]" : ""),
          shown: shown(el),
          disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
          size: Math.round(r.width) + "x" + Math.round(r.height),
          opacity: style.opacity,
          pointer: style.pointerEvents,
          covered,
          value: "value" in el ? String(el.value).slice(0, 200) : null,
        };
      })()`,
    )
    .catch(() => null)) as {
    name: string;
    tag: string;
    shown: boolean;
    disabled: boolean;
    size: string;
    opacity: string;
    pointer: string;
    covered: string | null;
    value: string | null;
  } | null;
  if (!facts) return `Box ${ref} isn't on the page any more. Call screen_look for fresh boxes.`;
  // Marked so the button check looks at this one control alone.
  await page
    .evaluate(
      `document.querySelectorAll('[data-mrog-inspect]').forEach((el) => el.removeAttribute('data-mrog-inspect')); document.querySelector('${selector}')?.setAttribute('data-mrog-inspect', '')`,
    )
    .catch(() => {});
  const handled = await clickHandled(page);
  return [
    `Box ${ref}: “${facts.name}” (${facts.tag})`,
    `Shown: ${facts.shown ? "yes" : "no"}; enabled: ${facts.disabled ? "no" : "yes"}; size: ${facts.size} px; opacity: ${facts.opacity}; pointer-events: ${facts.pointer}`,
    `Covered by something else at its centre: ${facts.covered ? `yes, by “${facts.covered}”` : "no"}`,
    `A click on it is handled (on it or on something around it): ${handled === null ? "can't tell" : handled ? "yes" : "no"}`,
    ...(facts.value !== null ? [`Value: “${facts.value}”`] : []),
  ].join("\n");
}

/** Whether the control marked data-mrog-inspect has a click handled on it or above it; null when the browser can't say. */
async function clickHandled(page: Page): Promise<boolean | null> {
  let cdp: CDPSession | undefined;
  try {
    cdp = await page.context().newCDPSession(page);
    const { result } = (await cdp.send("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector('[data-mrog-inspect]'); if (!el) return null; const chain = []; for (let n = el; n; n = n.parentNode) chain.push(n); chain.push(window); return { chain, own: typeof el.onclick === "function" || el.hasAttribute("onclick") || !!el.closest("a[href]") || (!!el.form && (el.type === "submit")) }; })()`,
      returnByValue: false,
    })) as { result: { objectId?: string } };
    if (!result.objectId) return null;
    const { result: top } = (await cdp.send("Runtime.getProperties", {
      objectId: result.objectId,
      ownProperties: true,
    })) as { result: { name: string; value?: { objectId?: string; value?: unknown } }[] };
    if (top.find((prop) => prop.name === "own")?.value?.value === true) return true;
    const chainId = top.find((prop) => prop.name === "chain")?.value?.objectId;
    if (!chainId) return null;
    const { result: chain } = (await cdp.send("Runtime.getProperties", {
      objectId: chainId,
      ownProperties: true,
    })) as { result: { name: string; value?: { objectId?: string } }[] };
    const ids = chain.filter((prop) => /^\d+$/.test(prop.name)).map((prop) => prop.value?.objectId);
    return (await listening(cdp, ids)).size > 0;
  } catch {
    return null;
  } finally {
    await page
      .evaluate(`document.querySelector('[data-mrog-inspect]')?.removeAttribute('data-mrog-inspect')`)
      .catch(() => {});
    await cdp?.detach().catch(() => {});
  }
}

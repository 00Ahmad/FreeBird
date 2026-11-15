import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";
import { chromium, type BrowserContext, type Frame, type Page } from "playwright-core";
import { z } from "zod";

import {
  BrowserSettings,
  DEFAULT_BROWSER_SETTINGS,
  type Bot,
  type BrowserStatus,
  type BrowserTab,
} from "@mrog/shared";
import {
  addressRisk,
  BADGES,
  defineTool,
  isPrivateHost,
  isWebUrl,
  mayReachLocal,
  NOT_FOUND_NOTE,
  resolvesPrivately,
  safe,
  type Risk,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
} from "@mrog/tools";

import { fail, parse } from "./http";
import type { Services } from "./services";
import { clickRisk, isSearchBox, visualPrompt, visualTools } from "./visual";

const SETTINGS_KEY = "browser";
/** Page text is handed over in parts this long, so one page never fills a small model's context. */
const TEXT_PART = 3500;
const MAX_ELEMENTS = 60;
const ACTION_TIMEOUT = 10_000;
/** How long a chat keeps a bot's tab after its last browser action before another chat may take it over. */
const TAB_LEASE_MS = 120_000;
/** Tools that click or type on the page: refused while it shows a human check. */
const ACTS_ON_PAGE = new Set([
  "browser_click",
  "browser_type",
  "browser_sign_in",
  "screen_click",
  "screen_click_at",
  "screen_type",
  "screen_press",
]);
/** Least time between live-view frames (about 15 a second). */
const FRAME_MS = 66;
/** At most one "the browser changed" notice this often: the Browser panel refetches on each one. */
const CHANGE_NOTICE_MS = 1000;
/** How long a search API may take to answer. */
const SEARCH_TIMEOUT_MS = 15_000;
/** How long a host's "is it on the local network" lookup is reused by the tab guard. */
const LOOKUP_CACHE_MS = 15_000;
/** How often a tab handed to the user for a human check is looked at, to notice it was solved. */
const CHECK_POLL_MS = 1500;
/** The answer a handoff's card gets when the check was solved and the bot went on by itself. */
const SOLVED = "✓ Solved. Carrying on.";
/** The one profile every bot uses when profiles are shared (its folder is the original `browser`). */
export const SHARED_PROFILE = "shared";
/** Where each bot's own profile lives, one folder per bot, under the data folder. */
export const PROFILES_DIR = "browser-profiles";
/** At most this many bots' browsers run at once; the one used longest ago (and idle) closes to make room. */
export const MAX_OPEN_PROFILES = 3;
const PROFILE_KEY = /^[A-Za-z0-9_-]{1,80}$/;

/** One browser profile, running or starting. */
interface Profile {
  context: BrowserContext | null;
  launching: Promise<BrowserContext> | null;
  usedAt: number;
}

/** Thrown when every running browser is busy: shown as is, not as "the browser didn't start". */
class NoRoomError extends Error {}

export interface PageElement {
  ref: number;
  kind: string;
  label: string;
  /** For Visual Bots' screen map: where on screen, and the top-left corner. */
  area?: "top" | "left" | "main" | "right" | "bottom";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** A search box by what the page says it is (Enter there only searches). */
  search?: boolean;
  /** What a text box holds now (never for a password or card field), so the bot can see what it typed. */
  holds?: string;
}

const AREAS = [
  ["top", "Top bar"],
  ["left", "Left side"],
  ["main", "Main area"],
  ["right", "Right side"],
  ["bottom", "Bottom"],
] as const;

/**
 * A Visual Bot's map of the screen: every numbered control, what it is and its visible name, grouped by where it
 * is, top to bottom and left to right. No link addresses and no page text: only what's written on the controls.
 */
/** Reading order: rows of controls near the same height (within 20px), each row left to right. */
function readingOrder(elements: PageElement[]): PageElement[] {
  const rows: PageElement[][] = [];
  for (const element of elements.toSorted((a, b) => (a.y ?? 0) - (b.y ?? 0))) {
    const last = rows.at(-1);
    if (last && (element.y ?? 0) - (last[0]!.y ?? 0) <= 20) last.push(element);
    else rows.push([element]);
  }
  return rows.flatMap((row) => row.toSorted((a, b) => (a.x ?? 0) - (b.x ?? 0)));
}

export function formatScreenMap(elements: PageElement[]): string {
  if (elements.length === 0) return "Screen map: nothing on screen can be clicked or typed into.";
  const lines = ["Screen map (controls on screen now; numbers match the boxes):"];
  for (const [area, title] of AREAS) {
    const here = readingOrder(elements.filter((element) => (element.area ?? "main") === area));
    if (here.length === 0) continue;
    const entries = here.map((element) => {
      // Whole characters, so an emoji is never cut in half.
      const characters = [...element.label];
      const name = characters.length > 60 ? `${characters.slice(0, 59).join("")}…` : element.label;
      const held = element.holds ? [...element.holds] : [];
      const holds = held.length > 40 ? `${held.slice(0, 39).join("")}…` : element.holds;
      return `[${element.ref}] ${element.kind}${name ? ` "${name}"` : ""}${holds ? ` holding "${holds}"` : ""}`;
    });
    lines.push(`${title}: ${entries.join(" · ")}`);
  }
  return lines.join("\n");
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  /** Elements further down the page that weren't listed. */
  more: number;
  humanCheck: boolean;
  /** HTTP status of the last page opened, when it was an error. */
  status?: number;
}

/**
 * In-page function: does the page show a CAPTCHA or human check? Only a check the user would see counts: many
 * ordinary pages (sign-in forms, shops, contact pages) carry an invisible reCAPTCHA or hidden captcha fields, and
 * counting those would stop the bot clicking anything there. Words like "security check" count only on a page that
 * has little else on it, as challenge pages do, not in an article that mentions them.
 */
const HUMAN_CHECK_TEST = `((text) => {
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 40 || box.height < 30) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const widget = [...document.querySelectorAll(
    'iframe[src*="captcha" i], iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge" i], #nc_1_wrapper, .nc-container, #px-captcha, [id*="captcha" i], [class*="g-recaptcha"], [class*="h-captcha"], .cf-turnstile'
  )].some((el) => !/size=invisible/i.test(el.getAttribute("src") || "") && !/grecaptcha-badge/.test(String(el.className)) && shown(el));
  const says = /verify (that )?you are (a )?human|are you a robot|unusual traffic|slide to (verify|complete)|press (and|&) hold|security check|bots use duckduckgo too/i.test(text.slice(0, 4000));
  return widget || (says && text.length < 3000);
})`;

/**
 * What makes a box a secret one (a password, a card number or code), in the site's own words. Tokens of the
 * autocomplete value count ("billing cc-number"), and so do the box's name, id, placeholder and label. One
 * definition for the page scripts and this side, so they can't disagree.
 */
const SECRET_AUTOCOMPLETE = /(?:^|\s)(?:cc-\S*|(?:current|new)-password)(?=\s|$)/i;
const SECRET_HINT =
  /(?<![a-z])(?:card|cc)[\s_-]*(?:number|num|no)(?![a-z])|credit[\s_-]*card|(?<![a-z0-9])(?:cvc|cvv|cvn|csc)(?![a-z0-9])|security[\s_-]*code/i;

/** A box for a password or a card number: by its type, or by what the site says it holds ("show password" included). */
export const isSecretField = (type: string, autocomplete: string, hints = "") =>
  type.toLowerCase() === "password" || SECRET_AUTOCOMPLETE.test(autocomplete) || SECRET_HINT.test(hints);

/** In-page function: is this a box for a password or card number? (The same rule as isSecretField.) */
export const SECRET_FIELD = `((el) => {
  if (!el.matches("input, textarea, [contenteditable], [role=textbox]")) return false;
  const hints = ["name", "id", "placeholder", "aria-label"].map((name) => el.getAttribute(name) || "").join(" ");
  return (el.getAttribute("type") || "").toLowerCase() === "password" ||
    ${SECRET_AUTOCOMPLETE}.test(el.getAttribute("autocomplete") || "") || ${SECRET_HINT}.test(hints);
})`;

/**
 * In-page function: is this a search box? Decided only by what the page says the box is (its type, role or name),
 * never by what has been typed into it, so typing "search" into a message box doesn't make Enter there safe.
 */
const IS_SEARCH_BOX = `((el) => {
  const role = el.getAttribute("role");
  if (role === "searchbox" || role === "combobox") return true;
  if (!el.matches("input, textarea")) return false;
  const said = ["aria-label", "placeholder", "name", "title"].map((name) => el.getAttribute(name) || "").join(" ");
  return (el.getAttribute("type") || "").toLowerCase() === "search" || /search/i.test(said);
})`;

/** Things a person could click or type into, for Visual Bots' boxes. */
const CONTROLS =
  "a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=option], [role=menuitem], [role=combobox], [role=searchbox], [role=textbox], [contenteditable=''], [contenteditable=true], [onclick]";

/**
 * In-page function: what a control is and the name a person would read on (or next to) it, for Visual Bots' screen
 * map and approval cards. Icon buttons use their accessible name; what's typed into a password or card field is
 * never part of a name.
 */
const DESCRIBE_CONTROL = `((el) => {
  const secret = ${SECRET_FIELD}(el);
  // A checkbox's or radio's value is usually just "on": its name is the label next to it ("I agree to the terms").
  const tick = /^(checkbox|radio)$/i.test(el.getAttribute("type") || "");
  const labelled = el.labels && el.labels.length ? [...el.labels].map((label) => label.innerText).join(" ") : "";
  const element = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  const type = (el.getAttribute("type") || "text").toLowerCase();
  const pressable = element === "input" && /^(submit|button|image|reset)$/.test(type);
  // A box you type into: its name is its label, and what's in it is said apart, so typed text is never taken for
  // the name (and the bot can see what the box holds).
  const typing = !secret && !tick && !pressable &&
    (element === "input" || element === "textarea" || el.isContentEditable || role === "textbox" || role === "searchbox");
  const text = (el.getAttribute("aria-label") || (typing ? "" : el.innerText) || labelled || (secret || tick || typing ? "" : el.value) ||
    el.getAttribute("placeholder") || el.getAttribute("aria-placeholder") || el.getAttribute("data-placeholder") ||
    el.getAttribute("title") || el.querySelector("img[alt]")?.getAttribute("alt") || el.querySelector("svg title")?.textContent || "")
    .replace(/\\s+/g, " ").trim();
  const held = typing ? String((el.isContentEditable ? el.innerText : el.value) || "").replace(/\\s+/g, " ").trim() : "";
  const kind =
    element === "input" && (type === "search" || role === "combobox" || role === "searchbox") ? "search box" :
    role === "searchbox" || role === "combobox" ? "search box" :
    element === "input" && type === "password" ? "password box" :
    element === "input" && (type === "checkbox" || type === "radio") ? type :
    element === "input" && /^(submit|button|image|reset)$/.test(type) ? "button" :
    element === "input" || element === "textarea" || el.isContentEditable || role === "textbox" ? "text box" :
    element === "select" ? "dropdown" :
    role === "tab" ? "tab" :
    role === "checkbox" ? "checkbox" :
    element === "a" || role === "link" ? (el.querySelector("img, video") ? "picture link" : "link") :
    "button";
  // Whole characters, so an emoji is never cut in half.
  return { kind, label: [...text].slice(0, 90).join(""), search: ${IS_SEARCH_BOX}(el), ...(held ? { holds: [...held].slice(0, 80).join("") } : {}) };
})`;

/** Of a page's text, at most this much is read: as many parts as browser_read can ask for. */
const MAX_TEXT = 100 * TEXT_PART;

/**
 * Runs in the page: numbers the things a person could click or type into (near the visible part of the page,
 * plus every text box), and reads the page text. Refs are written to the elements as data-mrog-ref, so a later
 * click finds exactly the element the model saw.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const maxElements = ${MAX_ELEMENTS};
  for (const el of document.querySelectorAll("[data-mrog-ref]")) el.removeAttribute("data-mrog-ref");
  const near = (box) => box.bottom > -innerHeight * 0.25 && box.top < innerHeight * 1.5;
  const isField = (el) => el.matches("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select");
  const isSearch = ${IS_SEARCH_BOX};
  // Cheap checks first: where it is, then (only for what may be listed) its style.
  const picked = [];
  let more = 0;
  for (const el of document.querySelectorAll(
    "a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=option], [role=menuitem], [onclick]"
  )) {
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    if (picked.length >= maxElements || !(isField(el) || near(box))) {
      more += 1;
      continue;
    }
    const style = getComputedStyle(el);
    if (style.visibility !== "hidden" && style.display !== "none") picked.push(el);
  }
  // What's typed into a password or card field never leaves the page.
  const secret = ${SECRET_FIELD};
  // A checkbox's or radio's value is usually just "on": its name is the label next to it.
  const tick = (el) => /^(checkbox|radio)$/i.test(el.getAttribute("type") || "");
  const labelled = (el) => el.labels && el.labels.length ? [...el.labels].map((l) => l.innerText).join(" ") : "";
  const label = (el) => (
    el.getAttribute("aria-label") || el.innerText || labelled(el) || (secret(el) || tick(el) ? "" : el.value) || el.getAttribute("placeholder") ||
    el.getAttribute("title") || el.getAttribute("alt") || el.querySelector?.("img[alt]")?.getAttribute("alt") || el.getAttribute("name") || ""
  ).replace(/\\s+/g, " ").trim().slice(0, 90);
  const kind = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" || el.getAttribute("role") === "link") return "link";
    if (tag === "input") return "input:" + (el.getAttribute("type") || "text");
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "select";
    return el.getAttribute("role") || "button";
  };
  const elements = picked.map((el, index) => {
    el.setAttribute("data-mrog-ref", String(index + 1));
    return { ref: index + 1, kind: kind(el), label: label(el), search: isSearch(el) };
  });
  const text = (document.body ? document.body.innerText : "").replace(/\\n\\s*\\n+/g, "\\n").trim();
  const humanCheck = ${HUMAN_CHECK_TEST}(text);
  return { url: location.href, title: document.title, text: text.slice(0, ${MAX_TEXT}), elements, more, humanCheck };
})()`;

/** Whether the page shows a CAPTCHA or "verify you're human" check (in-page code, given the page text). */
const HUMAN_CHECK_SCRIPT = `${HUMAN_CHECK_TEST}((document.body ? document.body.innerText : ""))`;

/**
 * For Visual Bots: draws a numbered box over everything on screen a person could click or type into, so the model
 * can say which thing it chose by looking ("the Daraz result is box 7"). Refs are data-mrog-ref, like snapshots,
 * so clicks and sign-in find the same element. Labels feed the screen map and approval cards.
 */
export const MARKS_SCRIPT = `(() => {
  document.getElementById("mrog-marks")?.remove();
  for (const el of document.querySelectorAll("[data-mrog-ref]")) el.removeAttribute("data-mrog-ref");
  const describe = ${DESCRIBE_CONTROL};
  const onScreen = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width >= 6 && box.height >= 6 && style.visibility !== "hidden" && style.display !== "none" &&
      box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
  };
  const candidates = [...document.querySelectorAll(${JSON.stringify(CONTROLS)})].filter(onScreen);
  // A link inside a marked link (titles inside result cards) would only double the boxes.
  const picked = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el) && other.tagName === "A")).slice(0, 80);
  const layer = document.createElement("div");
  layer.id = "mrog-marks";
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const colors = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];
  const labels = [];
  picked.forEach((el, index) => {
    const n = index + 1;
    el.setAttribute("data-mrog-ref", String(n));
    const box = el.getBoundingClientRect();
    const color = colors[index % colors.length];
    const frame = document.createElement("div");
    frame.style.cssText = "position:fixed;border:2px solid " + color + ";border-radius:3px;left:" + box.left + "px;top:" + box.top + "px;width:" + box.width + "px;height:" + box.height + "px";
    const tag = document.createElement("div");
    tag.textContent = String(n);
    // The number sits level with its own box, on its left: drawn above the box, in a tight list it landed on the row
    // before and covered that row's first letter, so models read it as the number of the wrong item. With no room
    // on the left, it goes inside the box's top-left corner.
    tag.style.cssText = "position:absolute;left:-2px;top:-2px;transform:translateX(-100%);background:" + color + ";color:#fff;font:bold 12px/15px Arial,sans-serif;padding:0 4px;border-radius:3px 0 0 3px";
    if (box.left < 26) {
      tag.style.transform = "none";
      tag.style.borderRadius = "0 0 3px 0";
    }
    frame.appendChild(tag);
    layer.appendChild(frame);
    const middleX = (box.left + box.width / 2) / innerWidth;
    const middleY = (box.top + box.height / 2) / innerHeight;
    const area =
      middleY < 0.1 ? "top" : middleY > 0.92 ? "bottom" : middleX < 0.14 ? "left" : middleX > 0.86 ? "right" : "main";
    labels.push({
      ref: n, ...describe(el), area,
      x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height),
    });
  });
  document.documentElement.appendChild(layer);
  return labels;
})()`;

/**
 * What has keyboard focus now (inside same-origin frames too): what Enter or Space would act on. Anything that
 * isn't a control (a rich-text editor, a frame from another site) is "other".
 */
const FOCUSED_SCRIPT = `(() => {
  let el = document.activeElement;
  while (el && el.contentDocument && el.contentDocument.activeElement) el = el.contentDocument.activeElement;
  if (!el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement) return null;
  const control = ${DESCRIBE_CONTROL}(el);
  return { ref: 0, ...control, kind: el.matches(${JSON.stringify(CONTROLS)}) ? control.kind : "other" };
})()`;

/**
 * Runs in a page or frame: marks the boxes for passwords and card numbers, for a screenshot to cover (see shoot()).
 * Returns how many there are.
 */
const MARK_SECRETS_SCRIPT = `(() => {
  const secret = ${SECRET_FIELD};
  const fields = [...document.querySelectorAll("input, textarea, [contenteditable], [role=textbox]")].filter(secret);
  for (const el of fields) el.setAttribute("data-mrog-secret", "");
  return fields.length;
})()`;

/** Takes the marks of MARK_SECRETS_SCRIPT off again. */
const UNMARK_SECRETS_SCRIPT = `for (const el of document.querySelectorAll("[data-mrog-secret]")) el.removeAttribute("data-mrog-secret")`;

/**
 * What has keyboard focus, for typing: whether it holds a secret, and what kind of thing it is. Only the element
 * itself is looked at, so a button is no more a box for text than a link.
 */
const TYPING_TARGET_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el) return null;
  const tag = el.tagName;
  return {
    tag,
    type: tag === "INPUT" ? el.type : "",
    multiline: tag === "TEXTAREA" || el.isContentEditable,
    secret: ${SECRET_FIELD}(el),
  };
})()`;

/** What TYPING_TARGET_SCRIPT says about the focused element. */
interface TypingTarget {
  tag: string;
  type: string;
  multiline: boolean;
  secret: boolean;
}

/** Input types that hold text a person types (dates are typed digit by digit). */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
]);

/**
 * Whether keys typed now go into text: a text area, an editable region or a text-like input. Typing at a button,
 * checkbox or submit button would press it (Space and Enter click them), so those are no place to type.
 */
export const takesTyping = (target: Pick<TypingTarget, "tag" | "type" | "multiline"> | null): boolean =>
  Boolean(target && (target.multiline || (target.tag === "INPUT" && TEXT_INPUT_TYPES.has(target.type))));

/**
 * In-page function: what a click at (x, y) would really land on (whatever is on top there), and whether that is box
 * `ref` itself, something inside it, or a label for it. A cross-origin frame (a video, an embedded form) is no
 * control the page can describe.
 */
const landingScript = (x: number, y: number, ref: number | null) => `(() => {
  const describe = ${DESCRIBE_CONTROL};
  const hit = document.elementFromPoint(${x}, ${y});
  if (!hit) return { reaches: false, control: null };
  const target = ${ref === null ? "null" : `document.querySelector('[data-mrog-ref="${ref}"]')`};
  const label = hit.closest("label");
  const reaches = Boolean(target) && (target === hit || target.contains(hit) || Boolean(label && (label.control === target || label.contains(target))));
  const control = hit.closest(${JSON.stringify(CONTROLS)}) || (label && label.control) || null;
  return { reaches, control: control ? { ref: 0, ...describe(control) } : null };
})()`;

/** Waits (up to 2 seconds) until the pictures on screen have loaded. */
const PICTURES_LOADED_SCRIPT = `new Promise((resolve) => {
  const end = Date.now() + 2000;
  const check = () => {
    const pending = [...document.images].filter((image) => {
      const box = image.getBoundingClientRect();
      return box.width > 20 && box.bottom > 0 && box.top < innerHeight && !(image.complete && image.naturalWidth > 0);
    });
    if (pending.length === 0 || Date.now() > end) resolve(pending.length);
    else setTimeout(check, 150);
  };
  check();
})`;

/** Shows where a Visual Bot is about to click, for anyone watching the window or the Browser panel. */
const clickDot = (x: number, y: number) => `(() => {
  const dot = document.createElement("div");
  dot.style.cssText = "position:fixed;left:${x - 9}px;top:${y - 9}px;width:18px;height:18px;border-radius:50%;background:rgba(225,29,72,.55);border:2px solid #e11d48;z-index:2147483647;pointer-events:none";
  document.documentElement.appendChild(dot);
  setTimeout(() => dot.remove(), 1500);
})()`;

/** Results of a search in the page: Bing's or DuckDuckGo's. */
/** In-page: the page's links and their words, absolute http(s) addresses only. */
const LINKS_SCRIPT = `(() => [...document.querySelectorAll("a[href]")].slice(0, 500)
  .map((a) => ({ text: (a.innerText || a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120), url: a.href }))
  .filter((link) => /^https?:/.test(link.url)))()`;

const RESULTS_SCRIPT = `(() => {
  const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
  const ddg = [...document.querySelectorAll('article[data-testid="result"]')].map((result) => {
    const link = result.querySelector('a[data-testid="result-title-a"]') || result.querySelector("h2 a");
    return { title: clean(link && link.innerText), url: link ? link.href : "", snippet: clean(result.querySelector('[data-result="snippet"]')?.innerText) };
  });
  const bing = [...document.querySelectorAll("li.b_algo")].map((result) => {
    const link = result.querySelector("h2 a");
    let url = link ? link.href : "";
    // Bing links go through a redirect; the real address is base64 in "u" after an "a1" prefix.
    try {
      const encoded = new URL(url).searchParams.get("u");
      if (/bing\\.com\\/ck\\//.test(url) && encoded && encoded.startsWith("a1")) {
        url = atob(encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/"));
      }
    } catch {}
    return { title: clean(link && link.innerText), url, snippet: clean(result.querySelector(".b_caption p, .b_lineclamp2, .b_lineclamp3")?.innerText) };
  });
  return [...ddg, ...bing].filter((r) => r.title && /^https?:/.test(r.url) && !/duckduckgo\\.com\\/y\\.js|bing\\.com\\/aclick/.test(r.url));
})()`;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const HUMAN_CHECK_NOTE =
  "⚠ This page is showing a human check (a CAPTCHA, slider or \"verify you're human\"). Don't try to get around it. Call browser_handoff so the user can solve it in the browser window, then continue.";

export function formatSnapshot(snapshot: PageSnapshot, part = 1): string {
  const parts = Math.max(1, Math.ceil(snapshot.text.length / TEXT_PART));
  const index = Math.min(Math.max(1, part), parts);
  const text = snapshot.text.slice((index - 1) * TEXT_PART, index * TEXT_PART);
  const lines = [`Page: ${snapshot.title || "(no title)"}`, `Address: ${snapshot.url}`];
  if (snapshot.status === 404 || snapshot.status === 410) lines.push(NOT_FOUND_NOTE);
  else if (snapshot.status && snapshot.status >= 400)
    lines.push(`(The site answered with an error, HTTP ${snapshot.status}.)`);
  if (snapshot.humanCheck) lines.push(HUMAN_CHECK_NOTE);
  lines.push(
    "",
    `--- Page text (part ${index} of ${parts}${parts > index ? `; browser_read with part=${index + 1} for more` : ""}) ---`,
    text || "(no text)",
  );
  if (snapshot.elements.length > 0) {
    lines.push("", "--- Things you can click or type into (use the number as ref) ---");
    for (const element of snapshot.elements) {
      lines.push(`[${element.ref}] ${element.kind} "${element.label}"`);
    }
    if (snapshot.more > 0) lines.push(`(${snapshot.more} more further down: browser_scroll to see them)`);
  }
  return lines.join("\n");
}

export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  return [
    `Results for "${query}":`,
    ...results
      .slice(0, 8)
      .map(
        (result, index) =>
          `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet.slice(0, 240)}`,
      ),
    "",
    "Open the most promising one with browser_open. Use only addresses from results or pages you've seen.",
  ].join("\n");
}

/**
 * Search engines sometimes answer automated browsers with unrelated results instead of refusing. Results count
 * as real only if most of them mention a word from the query.
 */
export function relevant(query: string, results: SearchResult[]): boolean {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
  if (results.length === 0) return false;
  if (words.length === 0) return true;
  const hits = results.filter((result) => {
    const haystack = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
    return words.some((word) => haystack.includes(word));
  });
  return hits.length * 2 >= results.length;
}

/** Settles with `promise`, or rejects as soon as `signal` aborts (whatever `promise` does after that). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * The bots' web browser: a real Edge or Chrome on this computer, driven like a person would use it. Each bot gets
 * its own tab, the window can be shown so you can watch and take over, and sign-ins persist in the bots' own
 * profile (not yours): by default one profile per bot (its helpers use it too), so a site signed in for one bot
 * isn't open to the others. With "blend in" on (the default) it leaves out what only automated browsers send, so
 * sites see the ordinary browser; it never solves human checks or fakes who is browsing: those are handed to you.
 */
export class BrowserManager {
  /** Running (or starting) browsers by profile: a bot's id, or SHARED_PROFILE. */
  private readonly profiles = new Map<string, Profile>();
  /** Which profile each bot's tab is in. */
  private readonly tabProfile = new Map<string, string>();
  /** Live views of each bot's tab open in the app: a watched browser isn't closed to make room. */
  private readonly viewers = new Map<string, number>();
  /** Whether this install had the shared profile before per-bot profiles existed (checked once). */
  private hadSharedProfile: boolean | undefined;
  private readonly pages = new Map<string, Page>();
  /** Tabs being opened in each profile, one after another (see page()). */
  private readonly opening = new Map<string, Promise<void>>();
  /** The elements each bot last saw, so a click's approval card can say what will be clicked. */
  private readonly seen = new Map<string, Map<number, PageElement>>();
  /** Each bot's latest page snapshot, so further parts of its text are read without numbering the page again. */
  private readonly snapshots = new Map<string, PageSnapshot>();
  /** Whether the page a bot last looked at shows a human check: acting on it is left to the user. */
  private readonly humanCheck = new Map<string, boolean>();
  /**
   * Which chat used a bot's tab last, when, and whether an action of it is still going (a bot in two chats at once
   * must not share the tab mid-task).
   */
  private readonly users = new Map<string, { threadId: string; at: number; busy: boolean }>();
  /** Each bot's browser actions, one after another. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Bots deleted while an action was still running: their tab must not come back. */
  private readonly gone = new Set<string>();
  /** Local addresses the user approved opening (asked by browser_open / screen_go_to). */
  private readonly allowedHosts = new Set<string>();
  /** Each tab's local-network guard, set up before the tab is used. */
  private readonly guards = new WeakMap<Page, Promise<void>>();
  /** How many new tabs each tab has asked for (window.open, links to a new tab), as its guard hears of them. */
  private readonly windowOpens = new WeakMap<Page, number>();
  /** Recent answers to "is this host on the local network", so pages full of requests aren't slowed by lookups. */
  private readonly lookups = new Map<string, { local: boolean; at: number }>();
  private changeTimer: NodeJS.Timeout | null = null;
  /** Bumped by close(): a launch that finishes after it is closed again instead of kept. */
  private generation = 0;
  private lastError: string | null = null;
  /** Saved Vault logins (set once the vault service exists), for browser_sign_in. */
  logins?: {
    loginForHost(host: string): { item: { username: string | null }; password: string } | null;
    items(): { kind: string; website: string | null }[];
  };

  constructor(
    private readonly services: Pick<Services, "store" | "bus" | "vault" | "config" | "fetchImpl">,
    private readonly launch: (settings: BrowserSettings, profileDir: string) => Promise<BrowserContext> = (
      settings,
      profileDir,
    ) =>
      chromium.launchPersistentContext(profileDir, {
        channel: settings.channel,
        headless: !settings.show,
        viewport: { width: 1280, height: 860 },
        acceptDownloads: false,
        // Without the automation switch the browser doesn't set navigator.webdriver or show the "controlled by
        // automated software" bar: sites see the ordinary browser it is.
        ...(settings.blendIn
          ? {
              ignoreDefaultArgs: ["--enable-automation"],
              args: ["--disable-blink-features=AutomationControlled"],
            }
          : {}),
      }),
  ) {}

  settings(): BrowserSettings {
    const saved = this.services.store.settings.get<Partial<BrowserSettings>>(SETTINGS_KEY);
    // An install whose bots already signed in to sites in the shared profile keeps it until the user switches.
    this.hadSharedProfile ??= existsSync(join(this.services.config.dataDir, "browser"));
    const defaults: BrowserSettings = {
      ...DEFAULT_BROWSER_SETTINGS,
      profiles: this.hadSharedProfile ? "shared" : "per-bot",
    };
    const parsed = BrowserSettings.safeParse({
      ...defaults,
      ...saved,
      profiles: saved?.profiles ?? defaults.profiles,
    });
    return parsed.success ? parsed.data : defaults;
  }

  async saveSettings(next: BrowserSettings): Promise<BrowserSettings> {
    const before = this.settings();
    this.services.store.settings.set(SETTINGS_KEY, next);
    // A different window mode, browser or profile layout takes effect on the next launch.
    if (
      before.show !== next.show ||
      before.channel !== next.channel ||
      before.profiles !== next.profiles ||
      before.blendIn !== next.blendIn
    )
      await this.close();
    this.changed();
    return next;
  }

  /** Tells the app the browser changed, at most once a second: actions come in bursts. */
  private changed() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.services.bus.publish({ type: "data.changed", keys: ["browser"] });
    }, CHANGE_NOTICE_MS);
    this.changeTimer.unref();
  }

  /**
   * A Parallel Bots role that searches has its own tab, so three searches at once don't fight over one: the tab is
   * keyed "<bot>#<role number>" and lives in the bot's own profile like its other tab.
   */
  static laneTab(botId: string, lane: number): string {
    return `${botId}#${lane}`;
  }

  /** The bot a tab belongs to (a role's tab key is the bot's id and the role). */
  private ownerOf(tab: string): string {
    return tab.split("#")[0]!;
  }

  async status(): Promise<BrowserStatus> {
    const names = new Map(this.services.store.bots.list().map((bot) => [bot.id, bot.name]));
    const tabs: BrowserTab[] = [];
    for (const [botId, page] of this.pages) {
      if (page.isClosed()) continue;
      tabs.push({
        botId,
        botName: names.get(this.ownerOf(botId)) ?? "?",
        url: page.url(),
        title: await page.title().catch(() => ""),
      });
    }
    const open = [...this.profiles].flatMap(([key, profile]) => (profile.context ? [key] : []));
    return { running: open.length > 0, open, tabs, error: this.lastError };
  }

  /**
   * Whose profile a bot's tab opens in: its own, or (for a helper) the profile of the bot that made it, so a
   * helper works signed in where its maker is. The bots of one race or cluster, made together for one job, share
   * the cluster's profile (so five racers are one browser, not five). Everyone's is the same when profiles are
   * shared.
   */
  profileKey(botId: string): string {
    if (this.settings().profiles === "shared") return SHARED_PROFILE;
    botId = this.ownerOf(botId);
    let bot = this.services.store.bots.get(botId);
    for (let depth = 0; bot?.parentId && depth < 10; depth++) {
      const parent = this.services.store.bots.get(bot.parentId);
      if (!parent) break;
      bot = parent;
    }
    return bot?.clusterId ?? bot?.id ?? botId;
  }

  botExists(botId: string): boolean {
    return Boolean(this.services.store.bots.get(botId)) && !this.gone.has(botId);
  }

  /** A profile's folder: the original `browser` for the shared one, `browser-profiles/<bot>` for a bot's own. */
  profileDir(key: string): string {
    if (key === SHARED_PROFILE) return join(this.services.config.dataDir, "browser");
    if (!PROFILE_KEY.test(key)) throw new Error("That isn't a bot's browser profile.");
    return join(this.services.config.dataDir, PROFILES_DIR, key);
  }

  /**
   * Whether a profile's browser is still wanted: used in the last couple of minutes (a bot between two tool calls
   * is waiting on its model, not done; the user may be signing in in the window), or a tab in it is mid-action,
   * waiting on the user, or watched in the app.
   */
  private inUse(key: string): boolean {
    const profile = this.profiles.get(key);
    if (profile && Date.now() - profile.usedAt < TAB_LEASE_MS) return true;
    for (const [botId, tabKey] of this.tabProfile) {
      if (tabKey !== key) continue;
      if (this.users.get(botId)?.busy || this.queues.has(botId) || (this.viewers.get(botId) ?? 0) > 0)
        return true;
    }
    return false;
  }

  /** Before another bot's browser starts: closes the idle ones used longest ago, so at most a few run at once. */
  private async makeRoom(key: string) {
    const others = [...this.profiles].filter(([other]) => other !== key);
    const excess = others.length - MAX_OPEN_PROFILES + 1;
    if (excess <= 0) return;
    const idle = others
      .filter(([other, profile]) => profile.context && !this.inUse(other))
      .toSorted((a, b) => a[1].usedAt - b[1].usedAt);
    if (idle.length < excess) {
      throw new NoRoomError(
        `${MAX_OPEN_PROFILES} bots are using their own browsers right now, the most that run at once. Try again when one of them is done.`,
      );
    }
    for (const [other] of idle.slice(0, excess)) await this.closeProfile(other);
  }

  private ensureContext(key: string): Promise<BrowserContext> {
    const running = this.profiles.get(key);
    if (running) {
      running.usedAt = Date.now();
      if (running.context) return Promise.resolve(running.context);
      if (running.launching) return running.launching;
    }
    const settings = this.settings();
    const generation = this.generation;
    // Taken before anything is awaited, so two tabs asking at once start one browser, not two.
    const profile: Profile = { context: null, launching: null, usedAt: Date.now() };
    this.profiles.set(key, profile);
    const current = () => generation === this.generation && this.profiles.get(key) === profile;
    profile.launching = (async () => {
      await this.makeRoom(key);
      const context = await this.launch(settings, this.profileDir(key));
      if (!current()) {
        // The browser (or this profile) was closed while it was starting.
        await context.close().catch(() => {});
        throw new Error("The browser was closed.");
      }
      profile.context = context;
      this.lastError = null;
      context.on("close", () => {
        // A late close event from an earlier browser mustn't wipe out the one running now.
        if (profile.context !== context) return;
        profile.context = null;
        if (this.profiles.get(key) === profile) this.profiles.delete(key);
        this.forgetPages(key);
        this.changed();
      });
      // Every tab, including popups, is kept off the local network unless the user approved the address.
      for (const page of context.pages()) void this.watchTab(context, page);
      context.on("page", (page) => void this.watchTab(context, page));
      this.changed();
      return context;
    })()
      .catch((error: Error) => {
        if (this.profiles.get(key) === profile && !profile.context) this.profiles.delete(key);
        if (error instanceof NoRoomError) throw error;
        const name = settings.channel === "msedge" ? "Microsoft Edge" : "Google Chrome";
        this.lastError = /executable doesn't exist|not found|distribution/i.test(error.message)
          ? `${name} isn't installed. Install it, or pick the other browser in Settings → Browser.`
          : `The browser didn't start: ${error.message.split("\n")[0]}`;
        this.changed();
        throw new Error(this.lastError, { cause: error });
      })
      .finally(() => {
        profile.launching = null;
      });
    return profile.launching;
  }

  /**
   * Opens the window without a task, so you can sign in to sites for the bots: a bot's own tab when `botId` is
   * given (its profile, and the Browser panel shows it), else the shared profile's window.
   */
  async open(botId?: string): Promise<void> {
    if (botId) {
      const page = await this.page(botId);
      await page.bringToFront().catch(() => {});
      return;
    }
    if (this.settings().profiles === "per-bot")
      throw new Error("Each bot has its own browser. Open it from the Browser panel in the bot's chat.");
    const context = await this.ensureContext(SHARED_PROFILE);
    if (context.pages().length === 0) await context.newPage();
  }

  /** Forgets a bot's tab (not closing it): its numbers, page reading and which chat has it. */
  private dropTab(botId: string) {
    this.pages.delete(botId);
    this.seen.delete(botId);
    this.snapshots.delete(botId);
    this.humanCheck.delete(botId);
    this.users.delete(botId);
    this.tabProfile.delete(botId);
  }

  /** Forgets the tabs in one profile, or in all of them. */
  private forgetPages(key?: string) {
    // Deleting from a Map while going through it is safe: entries already passed or removed aren't visited again.
    for (const [botId, profile] of this.tabProfile)
      if (key === undefined || profile === key) this.dropTab(botId);
    if (key === undefined) for (const botId of this.pages.keys()) this.dropTab(botId);
  }

  /** Closes one profile's browser (its tabs go with it). */
  private async closeProfile(key: string) {
    const profile = this.profiles.get(key);
    this.profiles.delete(key);
    this.forgetPages(key);
    await profile?.context?.close().catch(() => {});
    this.changed();
  }

  async close(): Promise<void> {
    this.generation += 1;
    const contexts = [...this.profiles.values()].flatMap((profile) =>
      profile.context ? [profile.context] : [],
    );
    this.profiles.clear();
    this.forgetPages();
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
    this.changed();
  }

  async closeTab(botId: string): Promise<void> {
    const page = this.pages.get(botId);
    this.dropTab(botId);
    await page?.close().catch(() => {});
  }

  /**
   * A deleted bot: closes its tab, and an action of its still running can't open a new one. Its own profile
   * (sites it was signed in to, cookies) is closed and deleted from disk.
   */
  async forget(botId: string): Promise<void> {
    this.gone.add(botId);
    for (const tab of this.pages.keys()) if (tab.startsWith(`${botId}#`)) await this.closeTab(tab);
    await this.closeTab(botId);
    await this.forgetProfile(botId);
  }

  /**
   * At start: deletes profile folders whose bot or race/cluster no longer exists (a deletion the browser held up
   * for longer than the retries, or one made while the app was closing).
   */
  async sweepProfiles(): Promise<void> {
    const root = join(this.services.config.dataDir, PROFILES_DIR);
    const folders = await readdir(root).catch(() => [] as string[]);
    const bots = new Set(this.services.store.bots.list().map((bot) => bot.id));
    const threads = new Set(this.services.store.threads.list().map((thread) => thread.id));
    for (const key of folders) if (!bots.has(key) && !threads.has(key)) await this.forgetProfile(key);
  }

  /** A bot's (or a deleted race's or cluster's) own profile: closed, and its folder deleted from disk. */
  async forgetProfile(key: string): Promise<void> {
    if (!PROFILE_KEY.test(key) || key === SHARED_PROFILE) return;
    if (this.profiles.has(key)) await this.closeProfile(key);
    const dir = join(this.services.config.dataDir, PROFILES_DIR, key);
    // The browser lets go of its files a moment after it closes (Windows keeps them locked until then).
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch((error: Error) =>
      console.warn(`[browser] couldn't delete ${dir}: ${error.message}`),
    );
  }

  /**
   * Keeps a tab off this computer and the local network (a public page redirecting to 192.168.1.1, a link to
   * 127.0.0.1.nip.io, a script calling a router's address): page loads and the page's own requests there are blocked
   * unless the user approved that address.
   */
  private async guard(context: BrowserContext, page: Page) {
    try {
      const cdp = await context.newCDPSession(page);
      cdp.on("Fetch.requestPaused", (event: { requestId: string; request: { url: string } }) => {
        void (async () => {
          let blocked = false;
          try {
            const url = new URL(event.request.url);
            blocked =
              /^https?:$/.test(url.protocol) &&
              !this.allowedHosts.has(url.host) &&
              (await this.isLocal(url.hostname));
          } catch {
            blocked = false;
          }
          await (
            blocked
              ? cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
              : cdp.send("Fetch.continueRequest", { requestId: event.requestId })
          ).catch(() => {});
        })();
      });
      // Page loads (top-level and frames) and the page's fetch/XHR calls; pictures and scripts aren't held up, so the
      // browser's cache keeps working.
      await cdp.send("Fetch.enable", {
        patterns: (["Document", "XHR", "Fetch"] as const).map((resourceType) => ({
          urlPattern: "*",
          resourceType,
          requestStage: "Request" as const,
        })),
      });
      // A hidden window calls itself "HeadlessChrome"; blending in, the tab sends the browser's ordinary name.
      const settings = this.settings();
      if (settings.blendIn && !settings.show) {
        try {
          const { userAgent } = (await cdp.send("Browser.getVersion")) as { userAgent: string };
          if (/Headless/.test(userAgent))
            await cdp.send("Network.setUserAgentOverride", {
              userAgent: userAgent.replace(/Headless(?=Chrome)/, ""),
            });
        } catch {
          // Then it keeps its own name; everything else about the tab works the same.
        }
      }
      // Heard as soon as a click asks for a new tab, well before that tab exists.
      cdp.on("Page.windowOpen", () => this.windowOpens.set(page, (this.windowOpens.get(page) ?? 0) + 1));
      await cdp.send("Page.enable");
    } catch {
      // The tab closed before it could be watched.
    }
  }

  /** A tab's guard, started once; awaiting it means the tab is watched before it loads anything. */
  private watchTab(context: BrowserContext, page: Page): Promise<void> {
    let watching = this.guards.get(page);
    if (!watching) {
      watching = this.guard(context, page);
      this.guards.set(page, watching);
    }
    return watching;
  }

  /** Whether a host is on this computer or the local network once looked up (answers reused for a few seconds). */
  private async isLocal(hostname: string): Promise<boolean> {
    const cached = this.lookups.get(hostname);
    if (cached && Date.now() - cached.at < LOOKUP_CACHE_MS) return cached.local;
    const local = await resolvesPrivately(hostname);
    if (this.lookups.size > 500) this.lookups.clear();
    this.lookups.set(hostname, { local, at: Date.now() });
    return local;
  }

  /** Opening a local address the user approved: later page loads there are allowed too. */
  private allowIfLocal(url: string, approved: boolean) {
    const target = new URL(url);
    if (approved || isPrivateHost(target.hostname)) this.allowedHosts.add(target.host);
  }

  /** The bot's open tab, if it has one. */
  private openTabOf(botId: string): Page | undefined {
    const existing = this.pages.get(botId);
    if (!existing || existing.isClosed()) return undefined;
    const profile = this.profiles.get(this.tabProfile.get(botId) ?? "");
    if (profile) profile.usedAt = Date.now();
    return existing;
  }

  /**
   * The bot's own tab, opened on first use. Tabs of one profile are opened one at a time: bots sharing a profile
   * (racers, a cluster, a helper and its maker) all wake up together when the browser has started, and each would
   * otherwise pick the same blank tab. Two bots in one tab renumber each other's boxes, so a click approved as
   * "Next" lands on the other bot's "Place order".
   */
  private page(botId: string): Promise<Page> {
    if (this.gone.has(this.ownerOf(botId))) return Promise.reject(new Error("This bot was deleted."));
    const existing = this.openTabOf(botId);
    if (existing) return Promise.resolve(existing);
    const key = this.profileKey(botId);
    const mine = (this.opening.get(key) ?? Promise.resolve()).then(() => this.openTab(botId, key));
    const settled = mine.then(
      () => {},
      () => {},
    );
    this.opening.set(key, settled);
    void settled.then(() => {
      if (this.opening.get(key) === settled) this.opening.delete(key);
    });
    return mine;
  }

  /** A persistent profile starts with one blank tab: reuse it if no other bot has it. */
  private async openTab(botId: string, key: string): Promise<Page> {
    if (this.gone.has(this.ownerOf(botId))) throw new Error("This bot was deleted.");
    // Opened by an earlier call in the line.
    const existing = this.openTabOf(botId);
    if (existing) return existing;
    const context = await this.ensureContext(key);
    if (this.gone.has(this.ownerOf(botId))) throw new Error("This bot was deleted.");
    const taken = new Set(this.pages.values());
    const blank = context.pages().find((page) => !taken.has(page) && page.url() === "about:blank");
    const page = blank ?? (await context.newPage());
    // Nothing is opened in the tab before its guard is in place.
    await this.watchTab(context, page);
    page.setDefaultTimeout(ACTION_TIMEOUT);
    this.pages.set(botId, page);
    this.tabProfile.set(botId, key);
    page.on("close", () => {
      if (this.pages.get(botId) !== page) return;
      this.pages.delete(botId);
      this.tabProfile.delete(botId);
    });
    this.changed();
    return page;
  }

  /** Waits for a page to settle: shops and web apps fill in their content after the first load. */
  private async settle(page: Page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  }

  /**
   * Does something that may load a new page (Enter in a search box, a click), then lets that page settle. Waiting
   * for the navigation to start first matters: otherwise "loaded" is checked on the old page.
   */
  private async acting(page: Page, action: () => Promise<unknown>) {
    const navigated = page.waitForEvent("framenavigated", { timeout: 1500 }).catch(() => null);
    await action();
    await navigated;
    await this.settle(page);
  }

  async snapshot(botId: string): Promise<PageSnapshot> {
    const page = await this.page(botId);
    const snapshot = (await page.evaluate(SNAPSHOT_SCRIPT)) as PageSnapshot;
    this.seen.set(botId, new Map(snapshot.elements.map((element) => [element.ref, element])));
    this.snapshots.set(botId, snapshot);
    this.humanCheck.set(botId, Boolean(snapshot.humanCheck));
    return snapshot;
  }

  /**
   * For reading part of the page text: further parts of the page last read come from that same reading (its
   * numbers stay valid); anything else reads the page again.
   */
  async snapshotPart(botId: string, part: number): Promise<PageSnapshot> {
    const last = this.snapshots.get(botId);
    const page = this.pages.get(botId);
    if (part > 1 && last && page && !page.isClosed() && page.url() === last.url) return last;
    return this.snapshot(botId);
  }

  /**
   * Opens an address in a tab. A local address got here only through the user's approval (`approved` when it was
   * found local by looking up its name), so it's allowed.
   */
  private async navigate(page: Page, url: string, approved = false) {
    this.allowIfLocal(url, approved);
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      if (/ERR_BLOCKED_BY_CLIENT/.test((error as Error).message)) {
        // The browser shows its error page next; let it finish so the bot's next page load isn't cut short by it.
        await page.waitForURL(/^chrome-error:/, { timeout: 3000 }).catch(() => {});
        await page.waitForLoadState("load", { timeout: 3000 }).catch(() => {});
        throw new Error(
          `${new URL(url).host} is on this computer or the local network, so the browser didn't open it. Ask the user if it should.`,
          { cause: error },
        );
      }
      // The browser's own words (and its call log) mean nothing to a model: say what happened and what to do.
      const message = (error as Error).message;
      // A page that failed to load is followed by the browser's error page; let it finish, or it cuts the bot's
      // next page load short ("interrupted by another navigation").
      if (/net::ERR_/.test(message)) {
        await page.waitForURL(/^chrome-error:/, { timeout: 3000 }).catch(() => {});
        await page.waitForLoadState("load", { timeout: 3000 }).catch(() => {});
      }
      if (/ERR_HTTP_RESPONSE_CODE_FAILURE/.test(message))
        throw new Error(`${url} answered with an error and no page. ${NOT_FOUND_NOTE}`, { cause: error });
      if (/ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/.test(message))
        throw new Error(
          `There's no site at ${new URL(url).host}. Check the address, or find the site with a search.`,
          {
            cause: error,
          },
        );
      if (
        /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|Timeout/.test(
          message,
        )
      )
        throw new Error(`${new URL(url).host} didn't answer. Try again in a moment, or try another site.`, {
          cause: error,
        });
      throw new Error(message.split("\n")[0], { cause: error });
    }
  }

  async goto(botId: string, url: string, approved = false): Promise<PageSnapshot> {
    const page = await this.page(botId);
    const response = await this.navigate(page, url, approved);
    await this.settle(page);
    this.changed();
    const snapshot = await this.snapshot(botId);
    const status = response?.status() ?? 0;
    return status >= 400 ? { ...snapshot, status } : snapshot;
  }

  private async element(botId: string, ref: number) {
    const page = await this.page(botId);
    const locator = page.locator(`[data-mrog-ref="${ref}"]`).first();
    if ((await locator.count()) === 0) {
      throw new Error(
        `There's no [${ref}] on the page now. The page changed: look again (screen_look, or browser_read) for fresh numbers.`,
      );
    }
    return { page, locator };
  }

  async click(botId: string, ref: number): Promise<PageSnapshot> {
    const { page, locator } = await this.element(botId, ref);
    await this.clickAndFollow(page, () => locator.click({ timeout: ACTION_TIMEOUT }));
    this.changed();
    return this.snapshot(botId);
  }

  /**
   * Clicks and lets the page settle. A link that opened a new tab is followed in the bot's own tab instead. Only
   * popups of this tab count: other bots' tabs and the user's own tabs are left alone.
   */
  private async clickAndFollow(page: Page, click: () => Promise<void>) {
    const popups: Page[] = [];
    const onPopup = (popup: Page) => void popups.push(popup);
    const asked = this.windowOpens.get(page) ?? 0;
    page.on("popup", onPopup);
    try {
      await click();
      await this.settle(page);
      // The click asked for a new tab: it's reported once its first page starts loading, so wait for that.
      if (popups.length === 0 && (this.windowOpens.get(page) ?? 0) > asked)
        await page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
    } finally {
      page.off("popup", onPopup);
    }
    for (const [index, popup] of popups.entries()) {
      const url = popup.url();
      await popup.close().catch(() => {});
      if (index > 0 || !isWebUrl(url)) continue;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.settle(page);
    }
  }

  async type(botId: string, ref: number, text: string, submit: boolean): Promise<PageSnapshot> {
    const { page, locator } = await this.element(botId, ref);
    const secret = await page.evaluate(
      `(() => { const el = document.querySelector('[data-mrog-ref="${ref}"]'); return Boolean(el) && ${SECRET_FIELD}(el); })()`,
    );
    if (secret === true) {
      throw new Error(
        "Bots don't type passwords or card numbers. Ask the user to fill this in with browser_handoff.",
      );
    }
    try {
      await locator.fill(text, { timeout: ACTION_TIMEOUT });
    } catch (error) {
      if (/not an <input>|contenteditable/i.test((error as Error).message)) {
        throw new Error(
          `[${ref}] isn't a text box. Pick one listed as input, textbox or select (call browser_read for fresh numbers).`,
          { cause: error },
        );
      }
      throw error;
    }
    if (submit) {
      await this.acting(page, () => locator.press("Enter"));
    }
    this.changed();
    return this.snapshot(botId);
  }

  async scroll(botId: string, direction: "down" | "up"): Promise<PageSnapshot> {
    const page = await this.page(botId);
    await page.mouse.wheel(0, direction === "down" ? 700 : -700);
    await page.waitForTimeout(600);
    return this.snapshot(botId);
  }

  async back(botId: string): Promise<PageSnapshot> {
    const page = await this.page(botId);
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    await this.settle(page);
    return this.snapshot(botId);
  }

  /**
   * A picture of the tab for the model. Password and card boxes (and "show password" ones) are covered while it is
   * taken: what's typed in them is never to be read off a picture, whoever typed it (the user, during a handoff).
   * The boxes keep their values, and the marks are taken off again.
   */
  private async shoot(page: Page, quality: number): Promise<Buffer> {
    const frames = page.frames();
    const covered: Frame[] = [];
    try {
      await Promise.all(
        frames.map(async (frame) => {
          try {
            if (((await frame.evaluate(MARK_SECRETS_SCRIPT)) as number) > 0) covered.push(frame);
          } catch (error) {
            // A frame that is gone has nothing to hide; the page itself must be covered or nothing is taken.
            if (frame === page.mainFrame()) throw error;
          }
        }),
      );
      return await page.screenshot({
        type: "jpeg",
        quality,
        mask: covered.map((frame) => frame.locator("[data-mrog-secret]")),
      });
    } finally {
      await Promise.all(covered.map((frame) => frame.evaluate(UNMARK_SECRETS_SCRIPT).catch(() => {})));
    }
  }

  async screenshot(botId: string): Promise<{ url: string; data: string }> {
    const page = await this.page(botId);
    const data = (await this.shoot(page, 60)).toString("base64");
    return { url: page.url(), data };
  }

  async focus(botId: string): Promise<void> {
    const page = await this.page(botId);
    await page.bringToFront();
  }

  /**
   * A search API's JSON answer. A server that doesn't answer within 15 seconds is given up on, and Stop ends the
   * wait at once (the bot's other browser actions queue behind this one).
   */
  private async searchApi<T>(
    name: string,
    url: string,
    headers: Record<string, string>,
    stop: AbortSignal,
    hint = "",
  ): Promise<T> {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]);
    try {
      const res = await untilAborted(this.services.fetchImpl(url, { headers, signal }), signal);
      if (!res.ok) throw new Error(`${name} answered HTTP ${res.status}.${hint}`);
      return await untilAborted(res.json() as Promise<T>, signal);
    } catch (error) {
      if (signal.aborted && !stop.aborted)
        throw new Error(`${name} didn't answer within ${SEARCH_TIMEOUT_MS / 1000} seconds.`, {
          cause: error,
        });
      throw error;
    }
  }

  /** web_search: in the bot's own tab like a person would, or through a search API if one is set up. */
  async search(botId: string, query: string, signal: AbortSignal, tab = botId): Promise<string> {
    const found = await this.searchResults(botId, query, signal, tab);
    if (found) return formatResults(query, found);
    const settings = this.settings();
    const snapshot = await this.snapshot(tab);
    // A role working on its own has no handoff to ask for: the human check is reported as a plain failure.
    if (snapshot.humanCheck && tab !== botId)
      throw new Error(
        "The search engine wants a human check, so this search couldn't be done. Answer from what you already have, or open a page you know with fetch_url.",
      );
    if (snapshot.humanCheck)
      return `The search engine wants a human check.

${formatSnapshot(snapshot)}`;
    return settings.show
      ? `The search engines gave no results for "${query}". Try other words, or open a site you know and use its own search.`
      : `The search engines gave no results or unrelated ones for "${query}". They often do that for a hidden browser: tell the user to turn on “Show the browser window” or set up a search API in Settings → Browser.`;
  }

  /**
   * A web search as a list of results: from the search API picked in Settings, or from Bing then DuckDuckGo in the
   * tab. Null when the engines in the tab gave nothing related (often a hidden browser, or a human check: the tab
   * shows which).
   */
  async searchResults(
    botId: string,
    query: string,
    signal: AbortSignal,
    tab = botId,
  ): Promise<SearchResult[] | null> {
    const settings = this.settings();
    if (settings.search === "brave") {
      const key = settings.braveSecret ? this.services.vault.get(settings.braveSecret) : null;
      if (!key) throw new Error("Brave Search is picked but its API key isn't set (Settings → Browser).");
      const body = await this.searchApi<{
        web?: { results?: { title: string; url: string; description?: string }[] };
      }>(
        "Brave Search",
        `https://api.search.brave.com/res/v1/web/search?count=8&q=${encodeURIComponent(query)}`,
        { accept: "application/json", "x-subscription-token": key },
        signal,
      );
      const results = (body.web?.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: (r.description ?? "").replace(/<[^>]+>/g, ""),
      }));
      return results;
    }
    if (settings.search === "searxng") {
      if (!settings.searxngUrl)
        throw new Error("SearXNG is picked but its address isn't set (Settings → Browser).");
      const body = await this.searchApi<{ results?: { title: string; url: string; content?: string }[] }>(
        "SearXNG",
        `${settings.searxngUrl.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(query)}`,
        { accept: "application/json" },
        signal,
        " Is JSON output enabled on it?",
      );
      const results = (body.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? "",
      }));
      return results;
    }
    const page = await this.page(tab);
    for (const url of [
      `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    ]) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.settle(page);
      const results = (await page.evaluate(RESULTS_SCRIPT)) as SearchResult[];
      if (relevant(query, results)) {
        this.changed();
        return results;
      }
    }
    return null;
  }

  /** The links on the page in a bot's tab, with their words: absolute http(s) addresses only, at most 500. */
  async links(botId: string): Promise<{ text: string; url: string }[]> {
    const page = this.pages.get(botId);
    if (!page || page.isClosed()) return [];
    const found = await page.evaluate(LINKS_SCRIPT).catch(() => []);
    return Array.isArray(found) ? (found as { text: string; url: string }[]) : [];
  }

  /** How to use the web like a person, for bots that have the browser. */
  prompt(bot: Bot): string[] {
    if (!this.settings().enabled)
      return bot.visual
        ? [
            `${bot.name} is a Visual Bot, which uses the web by looking at its browser, but the browser is switched off (Settings → Browser & search). Say so if you're asked to use the web.`,
          ]
        : [];
    if (bot.visual) return visualPrompt(bot);
    return [
      [
        "Using the web: work like a person would.",
        "1) If you were given a site's address, open it directly with browser_open. Otherwise find the right site or page with web_search (or start at a site's home page you know). Never guess deep addresses.",
        "2) On a site, use its own search box (browser_type with submit) and its filters, then open the actual product or article pages.",
        "3) Take facts and numbers only from pages you opened; read more parts or scroll when needed. Note each page's address and cite it next to the facts it gave.",
        "4) If a page shows a CAPTCHA or human check, or needs a sign-in, password or payment, call browser_handoff. Never try to get around it.",
        "fetch_url is fine for simple pages and APIs; use the browser for shops, web apps and anything built with JavaScript.",
      ].join(" "),
    ];
  }

  /** Browser tools for a bot. Every action returns what the page looks like afterwards. */
  tools(bot: Bot, tab?: string): ToolSpec[] {
    if (!this.settings().enabled) return [];
    const id = bot.id;
    const label = (ref: number) => this.seen.get(id)?.get(ref)?.label || `element ${ref}`;
    const read = (snapshot: PageSnapshot, part = 1) => formatSnapshot(snapshot, part);
    const sites = (this.logins?.items() ?? []).flatMap((item) =>
      item.kind === "login" && item.website ? [item.website] : [],
    );
    if (bot.visual) return visualTools(this, bot, sites).map((spec) => this.guarded(id, spec));
    return [
      defineTool({
        name: "web_search",
        description:
          "Search the web, like typing into a search engine. Start here to find the right site or page instead of guessing addresses.",
        args: z.object({ query: z.string().trim().min(1).max(300) }),
        risk: (args) => safe(`Search the web for “${args.query}”`),
        run: (args, ctx) => this.search(id, args.query, ctx.signal, tab),
      }),
      defineTool({
        name: "browser_open",
        description:
          "Open a web page in your browser tab (a real browser, so pages built with JavaScript work). Use addresses from search results or pages you've seen, or a site's home page.",
        args: z.object({ url: z.url().describe("http(s) address") }),
        risk: (args) => addressRisk(args, args.url, `Open ${args.url}`),
        run: async (args) => {
          if (!isWebUrl(args.url)) return "Only http and https pages can be opened.";
          return read(await this.goto(id, args.url, mayReachLocal(args, args.url)));
        },
      }),
      defineTool({
        name: "browser_read",
        description:
          "Read the page in your tab again: its text (in parts) and the numbered things you can use.",
        args: z.object({
          part: z.number().int().min(1).max(100).optional().describe("Which part of the text"),
        }),
        risk: () => safe("Read the page"),
        run: async (args) => read(await this.snapshotPart(id, args.part ?? 1), args.part ?? 1),
      }),
      defineTool({
        name: "browser_click",
        description: "Click a link or button on the page, by its number from the list.",
        args: z.object({ ref: z.number().int().min(1) }),
        // Judged like a Visual Bot's click: buttons with no name, and numbers it hasn't seen, ask too.
        risk: (args) => this.clickApproval(id, args.ref, `Click “${label(args.ref)}”`),
        run: async (args) => read(await this.click(id, args.ref)),
      }),
      defineTool({
        name: "browser_type",
        description:
          "Type into a text box on the page (by its number), e.g. a site's own search box. submit presses Enter afterwards.",
        args: z.object({
          ref: z.number().int().min(1),
          text: z.string().max(2000),
          submit: z.boolean().default(false),
        }),
        // Enter outside a search box may send or submit something, so it asks first.
        risk: (args) => {
          const summary = `Type “${args.text.slice(0, 60)}” into “${label(args.ref)}”`;
          return args.submit && !isSearchBox(this.seen.get(id)?.get(args.ref))
            ? {
                level: "ask",
                kind: "general",
                badges: [BADGES.acts],
                summary: `${summary} and press Enter (this may send or submit it)`,
              }
            : safe(summary);
        },
        run: async (args) => read(await this.type(id, args.ref, args.text, args.submit)),
      }),
      defineTool({
        name: "browser_scroll",
        description: "Scroll the page to see more of it.",
        args: z.object({ direction: z.enum(["down", "up"]).default("down") }),
        risk: () => safe("Scroll the page"),
        run: async (args) => read(await this.scroll(id, args.direction)),
      }),
      defineTool({
        name: "browser_back",
        description: "Go back to the previous page.",
        args: z.object({}),
        risk: () => safe("Go back"),
        run: async () => read(await this.back(id)),
      }),
      defineTool({
        name: "browser_screenshot",
        description: "Take a picture of what your tab shows, to look at layouts, images or charts.",
        args: z.object({}),
        risk: () => safe("Take a screenshot"),
        run: async () => {
          const shot = await this.screenshot(id);
          return {
            text: `Screenshot of ${shot.url}`,
            images: [{ mediaType: "image/jpeg", data: shot.data }],
          };
        },
      }),
      defineTool({
        name: "browser_handoff",
        description:
          "Ask the user to do something in your browser tab themselves (solve a CAPTCHA or human check, sign in, enter a password or payment), then wait until they're done.",
        args: z.object({ reason: z.string().trim().min(1).max(500).describe("What the user should do") }),
        risk: () => safe("Ask the user to take over the browser"),
        run: async (args, ctx) => {
          const { solved, answer } = await this.handOff(id, bot.name, args.reason, ctx);
          const said = solved
            ? "The user solved the check; it's gone from the page."
            : `The user replied: ${answer}`;
          return `${said}\n\n${read(await this.snapshot(id))}`;
        },
      }),
      ...(sites.length > 0
        ? [
            defineTool({
              name: "browser_sign_in",
              description: `Sign in on the page in your tab with a login the user saved in the Vault. The app types the password; you never see it. Give the numbers of the username box and the password box. Works only on the saved login's own site: ${sites.join(", ")}.`,
              args: z.object({
                username_ref: z.number().int().min(1),
                password_ref: z.number().int().min(1),
                submit: z.boolean().default(true),
              }),
              risk: () => ({
                level: "ask",
                kind: "general",
                badges: [BADGES.security],
                summary: `Sign in on ${this.hostOf(id) ?? "this page"} with your saved login`,
              }),
              run: async (args) =>
                read(await this.signIn(id, args.username_ref, args.password_ref, args.submit)),
            }),
          ]
        : []),
    ].map((spec) => this.guarded(tab ?? id, spec));
  }

  /**
   * A browser tool as bots get it: one action at a time per tab, the tab kept by one chat while it works (a bot
   * busy in two chats would otherwise click boxes the other chat numbered), and nothing clicked or typed on a page
   * with a human check (the user does those).
   */
  guarded(botId: string, spec: ToolSpec): ToolSpec {
    return {
      ...spec,
      run: async (args, ctx) => {
        // Checked before queueing too: the other chat may be waiting hours on a handoff.
        this.takesOver(botId, ctx.threadId);
        return this.exclusive(botId, ctx.signal, async () => {
          // Taking the tab over: the other chat's numbers mean nothing here, so make the bot look again.
          if (this.takesOver(botId, ctx.threadId)) await this.dropNumbers(botId);
          if (ACTS_ON_PAGE.has(spec.name) && this.humanCheck.get(botId)) {
            throw new Error(
              "This page shows a human check (CAPTCHA). Bots don't solve those: call browser_handoff so the user can, or go to another page.",
            );
          }
          this.users.set(botId, { threadId: ctx.threadId, at: Date.now(), busy: true });
          try {
            return await spec.run(args, ctx);
          } finally {
            this.users.set(botId, { threadId: ctx.threadId, at: Date.now(), busy: false });
          }
        });
      },
    };
  }

  /**
   * Whether this chat takes a bot's tab over from another chat that left it a while ago; throws while the other
   * chat is still using it or used it moments ago.
   */
  private takesOver(botId: string, threadId: string): boolean {
    const user = this.users.get(botId);
    if (!user || user.threadId === threadId) return false;
    if (user.busy || Date.now() - user.at < TAB_LEASE_MS) {
      throw new Error(
        "Your browser tab is busy with a task in another chat. Finish there first, or try again in a couple of minutes.",
      );
    }
    return true;
  }

  /** Runs a bot's browser actions one after another. A call stopped while it waits never starts. */
  private async exclusive<T>(botId: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const before = this.queues.get(botId) ?? Promise.resolve();
    const mine = before.then(() => {
      signal.throwIfAborted();
      return action();
    });
    const settled = mine.then(
      () => {},
      () => {},
    );
    this.queues.set(botId, settled);
    void settled.then(() => {
      if (this.queues.get(botId) === settled) this.queues.delete(botId);
    });
    return untilAborted(mine, signal);
  }

  /** Forgets a tab's box numbers (on the page too), so a click by an old number fails instead of hitting a new one. */
  private async dropNumbers(botId: string) {
    this.seen.delete(botId);
    this.snapshots.delete(botId);
    const page = this.pages.get(botId);
    await page
      ?.evaluate(
        `for (const el of document.querySelectorAll("[data-mrog-ref]")) el.removeAttribute("data-mrog-ref")`,
      )
      .catch(() => {});
  }

  /**
   * Hands the tab to the user and waits. When the page shows a human check, solving it is all the user has to do:
   * the tab is watched, and once the check has been gone for a few seconds the bot carries on by itself (the card
   * says so). Anything else (a sign-in, a payment) waits for the user's reply, since only they know when it's done.
   */
  async handOff(
    botId: string,
    botName: string,
    reason: string,
    ctx: ToolContext,
  ): Promise<{ solved: boolean; answer: string }> {
    const shown = this.settings().show;
    if (shown) await this.focus(botId);
    const page = this.pages.get(botId);
    const check =
      page && !page.isClosed() ? Boolean(await page.evaluate(HUMAN_CHECK_SCRIPT).catch(() => false)) : false;
    const where = shown
      ? `in the browser window (${botName}'s tab) or in the Browser panel of this chat`
      : "in the Browser panel of this chat";
    if (!check) {
      const answer = await ctx.ask(`${reason}\n\nDo it ${where}, then reply here, e.g. “done”.`);
      return { solved: false, answer };
    }
    let timer: NodeJS.Timeout | undefined;
    const solved = new Promise<string>((resolve) => {
      let clear = 0;
      timer = setInterval(() => {
        const current = this.pages.get(botId);
        if (!current || current.isClosed()) return;
        void current
          .evaluate(HUMAN_CHECK_SCRIPT)
          .catch(() => true)
          .then((shows) => {
            clear = shows ? 0 : clear + 1;
            // Twice in a row: a page reloading after the check mustn't count as solved half-way.
            if (clear >= 2) resolve(SOLVED);
          });
      }, CHECK_POLL_MS);
    });
    try {
      const answer = await ctx.ask(
        `${reason}\n\nSolve it ${where}. ${botName} carries on by itself once it's gone.`,
        {
          until: solved,
        },
      );
      return { solved: answer === SOLVED, answer };
    } finally {
      clearInterval(timer);
    }
  }

  /** The host of the page in a bot's tab, if it has one open. */
  private hostOf(botId: string): string | null {
    const page = this.pages.get(botId);
    if (!page || page.isClosed()) return null;
    try {
      return new URL(page.url()).hostname || null;
    } catch {
      return null;
    }
  }

  /**
   * Fills a sign-in form with the Vault login for the page's own site. The password goes from the keychain into
   * the page and nowhere else: not into the reply, the snapshot or the model's context.
   */
  async signIn(botId: string, userRef: number, passwordRef: number, submit: boolean): Promise<PageSnapshot> {
    const host = this.hostOf(botId);
    if (!host) throw new Error("Open the site's sign-in page first.");
    const page = await this.page(botId);
    if (new URL(page.url()).protocol !== "https:" && !isPrivateHost(host)) {
      throw new Error("This page isn't secure (no https), so the saved password won't be sent to it.");
    }
    const login = this.logins?.loginForHost(host);
    if (!login) {
      throw new Error(
        `There's no saved login for ${host}. Ask the user to sign in with browser_handoff, or to save one in the Vault.`,
      );
    }
    // Fixed handles, checked first: a locator would look the boxes up again on whatever page is there by the time
    // it types, and that page may not be the one whose address was checked.
    const user = await (await this.element(botId, userRef)).locator.elementHandle();
    const password = await (await this.element(botId, passwordRef)).locator.elementHandle();
    if (!user || !password) throw new Error("The sign-in form changed. Look at the page again.");
    if (((await password.getAttribute("type")) ?? "").toLowerCase() !== "password") {
      throw new Error(
        `[${passwordRef}] isn't a password box. Call browser_read and pick the password field.`,
      );
    }
    if (((await user.getAttribute("type")) ?? "").toLowerCase() === "password") {
      throw new Error(`[${userRef}] is a password box, not the username box.`);
    }
    if (this.hostOf(botId) !== host) throw new Error("The page changed before signing in. Look at it again.");
    await user.fill(login.item.username ?? "", { timeout: ACTION_TIMEOUT });
    await password.fill(login.password, { timeout: ACTION_TIMEOUT });
    if (submit) {
      await this.acting(page, () => password.press("Enter"));
    }
    await user.dispose().catch(() => {});
    await password.dispose().catch(() => {});
    this.changed();
    return this.snapshot(botId);
  }

  // ---- Visual Bots: they see screenshots and act on what they see, nothing else --------------------------

  /**
   * What the screen looks like now: a screenshot with numbered boxes on the things that can be clicked or typed
   * into (or a clean one), plus what a person sees in the address bar. No page text or link addresses.
   */
  async look(botId: string, marks = true): Promise<ToolResult> {
    const page = await this.page(botId);
    if (page.url() === "about:blank") {
      return {
        text: "The browser shows an empty tab. Use screen_go_to to open bing.com (or another site you know).",
        images: [],
      };
    }
    // Pictures (thumbnails, product photos) are what a Visual Bot chooses by: give them a moment to load.
    await page.evaluate(PICTURES_LOADED_SCRIPT).catch(() => {});
    let count = 0;
    let mapped: PageElement[] = [];
    if (marks) {
      const labels = (await page.evaluate(MARKS_SCRIPT).catch(() => [])) as PageElement[];
      count = labels.length;
      mapped = labels;
      this.seen.set(botId, new Map(labels.map((element) => [element.ref, element])));
    }
    const picture = await this.shoot(page, 60);
    if (marks) await page.evaluate(`document.getElementById("mrog-marks")?.remove()`).catch(() => {});
    const check = Boolean(await page.evaluate(HUMAN_CHECK_SCRIPT).catch(() => false));
    this.humanCheck.set(botId, check);
    const lines = [
      `Address bar: ${page.url()}`,
      `Tab title: ${await page.title().catch(() => "")}`,
      marks ? `${count} numbered boxes mark what you can click or type into.` : "Screenshot without boxes.",
    ];
    if (marks) lines.push("", formatScreenMap(mapped));
    if (check) lines.push(HUMAN_CHECK_NOTE);
    this.changed();
    return {
      text: lines.join("\n"),
      images: [{ mediaType: "image/jpeg", data: picture.toString("base64") }],
    };
  }

  /**
   * A short clip: `frames` screenshots spread over `seconds`, for following something that moves (a playing
   * video, a slideshow, a page still loading). The model can't take in live video; a few frames is how it sees
   * change. Frames are saved at lower quality than a normal look to keep a clip light.
   */
  async watch(botId: string, seconds: number, frames: number): Promise<ToolResult> {
    const page = await this.page(botId);
    if (page.url() === "about:blank") return { text: "The tab is empty: nothing to watch.", images: [] };
    const gap = frames > 1 ? (seconds * 1000) / (frames - 1) : 0;
    const images: ToolResult["images"] = [];
    const started = Date.now();
    for (let index = 0; index < frames; index++) {
      if (index > 0) await page.waitForTimeout(Math.max(0, started + index * gap - Date.now()));
      const shot = await this.shoot(page, 45);
      images.push({ mediaType: "image/jpeg", data: shot.toString("base64") });
    }
    this.changed();
    const times = images.map((_, index) => `${((index * gap) / 1000).toFixed(1)}s`).join(", ");
    return {
      text: `Address bar: ${page.url()}\nA clip of ${images.length} frames, taken at ${times}. Compare them to see what moved or changed. (No numbered boxes here: use screen_look before clicking.)`,
      images,
    };
  }

  /** A box the bot last saw (for approval cards). */
  mark(botId: string, ref: number): PageElement | undefined {
    return this.seen.get(botId)?.get(ref);
  }

  /** Whether the page in a bot's tab has a control with this number now (a click on any other number is refused). */
  async hasNumber(botId: string, ref: number): Promise<boolean> {
    const page = this.pages.get(botId);
    if (!page || page.isClosed()) return false;
    return (
      (await page
        .locator(`[data-mrog-ref="${ref}"]`)
        .count()
        .catch(() => 0)) > 0
    );
  }

  /**
   * A click's approval: judged by what the bot saw there. A number that isn't on the page at all is let through
   * unasked, because the click is refused straight away ("there's no [n]"): a card about it would only hold the bot
   * (and you) on something that can't happen.
   */
  async clickApproval(botId: string, ref: number, summary: string): Promise<Risk> {
    const element = this.mark(botId, ref);
    if (!element && !(await this.hasNumber(botId, ref)))
      return safe(`${summary} (there's no such number on the page, so this will be refused)`);
    return clickRisk(element, summary);
  }

  /** The control under a spot of the latest screenshot (the smallest box around it), if any. */
  markAt(botId: string, x: number, y: number): PageElement | undefined {
    let best: PageElement | undefined;
    for (const element of this.seen.get(botId)?.values() ?? []) {
      const { x: left = 0, y: top = 0, w = 0, h = 0 } = element;
      if (x < left || y < top || x > left + w || y > top + h) continue;
      if (!best || w * h < (best.w ?? 0) * (best.h ?? 0)) best = element;
    }
    return best;
  }

  /** The control that has keyboard focus in a bot's tab now (what Enter or Space acts on), if any. */
  async focused(botId: string): Promise<PageElement | undefined> {
    const page = this.pages.get(botId);
    if (!page || page.isClosed()) return undefined;
    return ((await page.evaluate(FOCUSED_SCRIPT).catch(() => null)) as PageElement | null) ?? undefined;
  }

  private async showClick(page: Page, x: number, y: number) {
    await page.evaluate(clickDot(Math.round(x), Math.round(y))).catch(() => {});
    await page.waitForTimeout(250);
  }

  /** Clicks the middle of a numbered box. */
  async clickMark(botId: string, ref: number): Promise<ToolResult> {
    const { page, locator } = await this.element(botId, ref);
    const box = await locator.boundingBox();
    if (!box)
      throw new Error(`Box ${ref} isn't on the screen any more. Call screen_look for a fresh picture.`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.checkLanding(page, x, y, ref, `Box ${ref}`);
    await this.showClick(page, x, y);
    await this.clickPoint(page, x, y);
    return this.look(botId);
  }

  /**
   * A Visual Bot clicks a spot, and whatever is on top there takes the click: a cookie banner, a popup or a
   * see-through layer over the box it chose (`ref`, when it chose one). Its approval was judged by that box, so a
   * click that would land on a control that asks first (Subscribe, Accept all) is refused, naming it. Something
   * harmless (Close, a plain link, a layer that is no control) may take it; the next look shows what happened.
   */
  private async checkLanding(page: Page, x: number, y: number, ref: number | null, what: string) {
    const landing = (await page
      .evaluate(landingScript(Math.round(x), Math.round(y), ref))
      .catch(() => null)) as {
      reaches: boolean;
      control: PageElement | null;
    } | null;
    if (!landing?.control || landing.reaches) return;
    // Only a control on top that would itself ask is refused. Layers that aren't controls are common on big sites
    // (YouTube's hover preview over a thumbnail, a video frame) and refusing those broke ordinary clicks.
    if (clickRisk(landing.control, "").level === "safe") return;
    const there = landing.control.label ? `“${landing.control.label}”` : "a control with no name";
    throw new Error(
      `${what} is covered by ${there}, so the click would land there instead. Look again (screen_look) and deal with what covers it first.`,
    );
  }

  /** Clicks a spot in the screenshot (pixels, as in the picture), for things without a box. */
  async clickAt(botId: string, x: number, y: number): Promise<ToolResult> {
    const page = await this.page(botId);
    const size = page.viewportSize() ?? { width: 1280, height: 860 };
    if (x < 0 || y < 0 || x > size.width || y > size.height) {
      throw new Error(`The picture is ${size.width}×${size.height} pixels; ${x},${y} is outside it.`);
    }
    await this.checkLanding(
      page,
      x,
      y,
      this.markAt(botId, x, y)?.ref ?? null,
      `The spot ${Math.round(x)}, ${Math.round(y)}`,
    );
    await this.showClick(page, x, y);
    await this.clickPoint(page, x, y);
    return this.look(botId);
  }

  private clickPoint(page: Page, x: number, y: number) {
    return this.clickAndFollow(page, () => page.mouse.click(x, y));
  }

  /** What has keyboard focus in a tab, for typing (null when nothing does). */
  private typingTarget(page: Page): Promise<TypingTarget | null> {
    return page.evaluate(TYPING_TARGET_SCRIPT).catch(() => null) as Promise<TypingTarget | null>;
  }

  /**
   * Types into whatever the bot clicked last, like a person typing. Space and Enter press a focused button or tick a
   * checkbox, so nothing is typed unless the focus is a box for text. A line break in the text is an Enter press
   * (judged as one by the approval), and in a one-line box it ends the typing there if the page moves on.
   */
  async typeText(botId: string, text: string, enter: boolean): Promise<ToolResult> {
    const page = await this.page(botId);
    const focused = await this.typingTarget(page);
    if (!focused) {
      throw new Error(
        "Nothing to type into is selected. Click the text box first (screen_click), then type.",
      );
    }
    if (focused.secret) {
      throw new Error(
        "Bots don't type passwords or card numbers. Use browser_sign_in or ask the user with browser_handoff.",
      );
    }
    if (!takesTyping(focused)) {
      throw new Error(
        `What is selected is ${focused.type ? `a ${focused.type} input` : `a ${focused.tag.toLowerCase()}`}, not a text box, so typing could press it instead. Click the text box first (screen_click), then type.`,
      );
    }
    // What's in the box is replaced, as a person selects the old text before typing over it: a search box that
    // still holds the last search, or a second try at the same text, would otherwise run the two together.
    await page.keyboard.press("ControlOrMeta+A");
    const lines = text.split(/\r\n|\r|\n/);
    let submitted = false;
    let stopped = false;
    if (text) {
      for (const [index, line] of lines.entries()) {
        if (index > 0) {
          if (focused.multiline) await page.keyboard.press("Enter");
          else {
            submitted = true;
            await this.acting(page, () => page.keyboard.press("Enter"));
            // The page may have moved on (a form sent): the rest of the text isn't typed at whatever has focus now.
            if (!takesTyping(await this.typingTarget(page))) {
              stopped = true;
              break;
            }
          }
        }
        if (line) await page.keyboard.type(line, { delay: 20 });
      }
    } else await page.keyboard.press("Backspace");
    // Read back before Enter moves on: autocomplete or the page itself may have changed what was typed.
    const held = submitted
      ? null
      : ((await page
          .evaluate(
            `(() => { const el = document.activeElement; if (!el) return null; const value = el.isContentEditable ? el.innerText : el.value; return typeof value === "string" ? value.replace(/\\s+/g, " ").trim().slice(0, 200) : null; })()`,
          )
          .catch(() => null)) as string | null);
    if (enter && !stopped) {
      await this.acting(page, () => page.keyboard.press("Enter"));
    }
    const after = await this.look(botId);
    if (stopped)
      return {
        ...after,
        text: `Enter was pressed at a line break and the page moved on, so the text after it was not typed.\n${after.text}`,
      };
    if (held === null) return after;
    const note =
      held === text.replace(/\s+/g, " ").trim()
        ? `The box now holds “${held}”${enter ? ", and Enter was pressed" : ""}.`
        : `⚠ The box now holds “${held}”, not exactly what you typed. Check it before going on.`;
    return { ...after, text: `${note}\n${after.text}` };
  }

  async pressKey(botId: string, key: string): Promise<ToolResult> {
    const page = await this.page(botId);
    await this.acting(page, () => page.keyboard.press(key));
    return this.look(botId);
  }

  async goTo(botId: string, url: string, approved = false): Promise<ToolResult> {
    const page = await this.page(botId);
    await this.navigate(page, url, approved);
    await this.settle(page);
    return this.look(botId);
  }

  async scrollView(botId: string, direction: "down" | "up"): Promise<ToolResult> {
    const page = await this.page(botId);
    await page.mouse.wheel(0, direction === "down" ? 650 : -650);
    await page.waitForTimeout(600);
    return this.look(botId);
  }

  async goBack(botId: string): Promise<ToolResult> {
    const page = await this.page(botId);
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    await this.settle(page);
    return this.look(botId);
  }

  // ---- the live view in the app: what the user sees and does in a bot's tab ----------------------------

  hasTab(botId: string): boolean {
    const page = this.pages.get(botId);
    return Boolean(page && !page.isClosed());
  }

  /**
   * Streams a bot's tab as video for the Browser panel: the browser sends a frame whenever the page changes, at
   * most about 15 a second, until `signal` aborts or the tab closes. `onFrame` resolves once the viewer can take
   * the next frame, so a slow viewer slows the stream down instead of piling frames up.
   */
  async screencast(
    botId: string,
    onFrame: (jpeg: Buffer) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const page = this.pages.get(botId);
    if (!page || page.isClosed()) throw new Error("This bot has no browser tab open.");
    // A browser being watched isn't closed to make room for another bot's.
    this.viewers.set(botId, (this.viewers.get(botId) ?? 0) + 1);
    const unwatch = () => {
      const left = (this.viewers.get(botId) ?? 1) - 1;
      if (left > 0) this.viewers.set(botId, left);
      else this.viewers.delete(botId);
    };
    let cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>>;
    try {
      cdp = await page.context().newCDPSession(page);
    } catch (error) {
      unwatch();
      throw error;
    }
    let ended!: () => void;
    const end = new Promise<void>((resolve) => (ended = resolve));
    try {
      let next = 0;
      cdp.on("Page.screencastFrame", (frame) => {
        void (async () => {
          await onFrame(Buffer.from(frame.data, "base64"));
          // The browser sends the next frame only after an ack: delaying it caps the frame rate.
          const wait = Math.max(0, next - Date.now());
          next = Date.now() + wait + FRAME_MS;
          setTimeout(() => {
            void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
          }, wait);
        })();
      });
      if (signal.aborted) return;
      signal.addEventListener("abort", ended, { once: true });
      page.once("close", ended);
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1280, maxHeight: 860 });
      await end;
    } finally {
      unwatch();
      signal.removeEventListener("abort", ended);
      page.off("close", ended);
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
    }
  }

  /** A picture of a bot's tab for the Browser panel, or null when it has none. */
  async view(botId: string): Promise<Buffer | null> {
    const page = this.pages.get(botId);
    if (!page || page.isClosed()) return null;
    return page.screenshot({ type: "jpeg", quality: 55 });
  }

  /** The user clicks in the panel; x and y are fractions of the picture's width and height. */
  async userClick(botId: string, x: number, y: number): Promise<void> {
    const page = this.pages.get(botId);
    if (!page || page.isClosed()) throw new Error("This bot has no browser tab open.");
    const size = page.viewportSize() ?? { width: 1280, height: 860 };
    await page.mouse.click(Math.round(x * size.width), Math.round(y * size.height));
  }

  /** The user types in the panel: into whatever has focus, like typing into the real window. */
  async userType(botId: string, text: string, key?: string): Promise<void> {
    const page = this.pages.get(botId);
    if (!page || page.isClosed()) throw new Error("This bot has no browser tab open.");
    if (text) await page.keyboard.type(text);
    if (key) await page.keyboard.press(key);
  }

  /** The user opens an address in a bot's tab from the panel (to sign in for it, say): theirs to open, local too. */
  async userGo(botId: string, url: string): Promise<void> {
    const page = this.pages.get(botId);
    if (!page || page.isClosed()) throw new Error("This bot has no browser tab open.");
    if (!isWebUrl(url)) throw new Error("Only http and https pages can be opened.");
    await this.navigate(page, url, true);
    this.changed();
  }

  async userScroll(botId: string, dy: number): Promise<void> {
    const page = this.pages.get(botId);
    if (!page || page.isClosed()) throw new Error("This bot has no browser tab open.");
    await page.mouse.wheel(0, dy);
  }
}

export function registerBrowserRoutes(app: FastifyInstance, browser: BrowserManager) {
  app.get("/api/browser", async () => ({ settings: browser.settings(), status: await browser.status() }));

  app.put("/api/browser/settings", async (request, reply) => {
    const body = parse(BrowserSettings, request.body, reply);
    if (!body) return reply;
    return { settings: await browser.saveSettings(body) };
  });

  app.post("/api/browser/open", async (request, reply) => {
    const body = parse(z.object({ botId: z.string().min(1).max(80).optional() }), request.body ?? {}, reply);
    if (!body) return reply;
    if (body.botId && !browser.botExists(body.botId))
      return fail(reply, 404, "not_found", "There's no such bot.");
    try {
      await browser.open(body.botId);
    } catch (error) {
      return fail(reply, 502, "browser_failed", (error as Error).message);
    }
    return { status: await browser.status() };
  });

  app.post("/api/browser/close", async () => {
    await browser.close();
    return { status: await browser.status() };
  });

  // The Browser panel: watch a bot's tab and act in it yourself.
  app.get<{ Params: { botId: string } }>("/api/browser/tabs/:botId/view", async (request, reply) => {
    const picture = await browser.view(request.params.botId).catch(() => null);
    if (!picture) return fail(reply, 404, "no_tab", "This bot has no browser tab open.");
    return reply.header("cache-control", "no-store").type("image/jpeg").send(picture);
  });

  // Live video of a bot's tab: each frame is a 4-byte big-endian length followed by a JPEG.
  app.get<{ Params: { botId: string } }>("/api/browser/tabs/:botId/stream", async (request, reply) => {
    const { botId } = request.params;
    if (!browser.hasTab(botId)) return fail(reply, 404, "no_tab", "This bot has no browser tab open.");
    const stop = new AbortController();
    request.raw.on("close", () => stop.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    });
    const res = reply.raw;
    const send = async (jpeg: Buffer) => {
      if (res.writableEnded || res.destroyed) return;
      const length = Buffer.alloc(4);
      length.writeUInt32BE(jpeg.length);
      res.write(length);
      // Full buffer: wait until the viewer has taken it (or left) before the next frame is asked for.
      if (!res.write(jpeg)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.on("drain", done);
          res.on("close", done);
        });
      }
    };
    await browser.screencast(botId, send, stop.signal).catch(() => {});
    reply.raw.end();
  });

  const act = async (reply: FastifyReply, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      return fail(reply, 409, "browser_action_failed", (error as Error).message.split("\n")[0]!);
    }
    return reply.code(204).send();
  };

  app.post<{ Params: { botId: string } }>("/api/browser/tabs/:botId/click", async (request, reply) => {
    const body = parse(
      z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
      request.body,
      reply,
    );
    if (!body) return reply;
    return act(reply, () => browser.userClick(request.params.botId, body.x, body.y));
  });

  app.post<{ Params: { botId: string } }>("/api/browser/tabs/:botId/type", async (request, reply) => {
    const body = parse(
      z.object({
        text: z.string().max(2000).default(""),
        key: z.enum(["Enter", "Tab", "Backspace", "Escape", "ArrowDown", "ArrowUp"]).optional(),
      }),
      request.body,
      reply,
    );
    if (!body) return reply;
    return act(reply, () => browser.userType(request.params.botId, body.text, body.key));
  });

  app.post<{ Params: { botId: string } }>("/api/browser/tabs/:botId/go", async (request, reply) => {
    const body = parse(z.object({ url: z.url().max(4000) }), request.body, reply);
    if (!body) return reply;
    return act(reply, () => browser.userGo(request.params.botId, body.url));
  });

  app.post<{ Params: { botId: string } }>("/api/browser/tabs/:botId/scroll", async (request, reply) => {
    const body = parse(z.object({ dy: z.number().min(-5000).max(5000) }), request.body, reply);
    if (!body) return reply;
    return act(reply, () => browser.userScroll(request.params.botId, body.dy));
  });
}

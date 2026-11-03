import { z } from "zod";

import type { Bot } from "@mrog/shared";
import {
  addressRisk,
  BADGES,
  defineTool,
  isWebUrl,
  mayReachLocal,
  safe,
  type Risk,
  type ToolSpec,
} from "@mrog/tools";

import type { BrowserManager, PageElement } from "./browser";

/**
 * Tools a Visual Bot keeps besides its screen tools. Everything that reads pages as text (fetch_url, web_search,
 * browser_read…) or runs commands is left out, so every decision comes from looking at the screen.
 */
export const VISUAL_BOT_KEEPS = new Set([
  "ask_user",
  "update_plan",
  "remember",
  "forget",
  "list_files",
  "read_file",
  "write_file",
  "request_secret",
]);

/**
 * Words on a control that may buy, send, delete, share or sign up for something: clicking it asks first. Also the
 * same in a few common languages, matched as whole words.
 */
const CONSEQUENTIAL = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[
    // English
    "buy|pay|payment|purchase|order|checkout|check ?out|add to (?:cart|bag|basket)|subscribe|sign ?up|register|submit|send|post|publish|delete|remove|trash|discard|erase|empty|wipe|deactivate|close (?:my |your |the )?account|cancel (?:my |your |the )?(?:subscription|membership|plan|order|booking|account)|archive|save|reply|comment|share|invite|accept|agree|allow|authori[sz]e|grant|bid|sell|rent|hire|upload|enroll|join|claim|redeem|withdraw|deposit|confirm|book|reserve|transfer|donate|unsubscribe|log ?out|sign ?out",
    // Spanish, Portuguese, French, German, Italian, Dutch
    "comprar|pagar|enviar|eliminar|borrar|excluir|apagar|confirmar|reservar|publicar|guardar|salvar|aceptar|aceitar|suscribirse|assinar|registrarse|cadastrar",
    "acheter|payer|envoyer|supprimer|confirmer|commander|réserver|publier|enregistrer|accepter|valider|s'abonner|s'inscrire|ajouter au panier",
    "kaufen|bezahlen|senden|absenden|löschen|entfernen|bestätigen|bestellen|buchen|veröffentlichen|speichern|akzeptieren|abonnieren|registrieren|in den warenkorb",
    "acquista|compra|paga|invia|elimina|cancella|conferma|ordina|prenota|pubblica|salva|accetta|iscriviti",
    "kopen|betalen|verzenden|verwijderen|bevestigen|boeken|opslaan|accepteren",
  ].join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

/** Controls that do something when clicked (as opposed to links and text boxes). */
const BUTTON_KINDS = /^(?:button|menuitem|input:(?:submit|button|image))$/;
/** Controls that Space presses, like a click. */
const PRESSED_BY_SPACE =
  /^(?:button|menuitem|checkbox|radio|tab|switch|input:(?:submit|button|image|checkbox|radio))$/;

/**
 * A name the word list can't read: another script (Cyrillic, Arabic, Chinese…) or only an emoji (🗑). What such a
 * button does is unknown.
 */
const unreadable = (label: string) =>
  !/\p{Script=Latin}/u.test(label) && /[\p{L}\p{Extended_Pictographic}]/u.test(label);

/** Pressing Enter in a search box only searches; anywhere else it may send or submit something. */
export const isSearchBox = (element?: PageElement): boolean => Boolean(element?.search);

const acts = (summary: string): Risk => ({ level: "ask", kind: "general", badges: [BADGES.acts], summary });

/**
 * A click asks first when the control may buy, send or change something, when it's a button with no name (or one
 * the word list can't read) to judge it by, or when nothing known is there at all.
 */
export function clickRisk(element: PageElement | undefined, summary: string): Risk {
  if (!element) return acts(`${summary} (nothing on the latest look is there, so it can't be judged)`);
  if (CONSEQUENTIAL.test(element.label)) return acts(summary);
  if (BUTTON_KINDS.test(element.kind)) {
    if (!element.label) return acts(`${summary} (a button with no name)`);
    if (unreadable(element.label)) return acts(summary);
  }
  return safe(summary);
}

/**
 * Enter does what the focused control does: searches in a search box, follows a link, presses a button. In any
 * other box (or with nothing focused) it may post a comment, send a message or submit a form, so it asks first.
 */
export function enterRisk(focused: PageElement | undefined, summary: string): Risk {
  if (isSearchBox(focused)) return safe(summary);
  const where = focused?.label ? ` on “${focused.label}”` : "";
  if (focused && (focused.kind.endsWith("link") || PRESSED_BY_SPACE.test(focused.kind)))
    return clickRisk(focused, `${summary}${where}`);
  return acts(`${summary}${where} (Enter may send or submit it)`);
}

/** Space presses a focused button or ticks a checkbox, like a click; anywhere else it types a space or scrolls. */
export function spaceRisk(focused: PageElement | undefined, summary: string): Risk {
  if (focused && PRESSED_BY_SPACE.test(focused.kind))
    return clickRisk(focused, `${summary}${focused.label ? ` on “${focused.label}”` : ""}`);
  return safe(summary);
}

export function visualPrompt(bot: Bot): string[] {
  return [
    [
      `You are a Visual Bot: you use the web only by looking at the screen, the way a person does. ${bot.name} sees screenshots of its own browser tab and acts on what it sees.`,
      "Every screenshot comes with a screen map: the controls on screen by box number, grouped by area (top bar, left side, main area, right side, bottom), with what each is and the name written on it.",
      "On every new screen, first read the map to know what controls this screen has and where they are, then look at the picture to decide which one you want, then act. Check the next screenshot and its map before the next move.",
      "Move fast, like a person clicking around: before each action write at most one short sentence (or nothing), then act. Save explanations for your final answer.",
      "To follow something that moves (a playing video, a slideshow, a page that is still loading), use screen_watch: it shows you several frames over a few seconds.",
      "To find something, start at google.com like a person: click the search box, type your search with enter, then look at the results and pick the one whose title, site name or picture matches what you want. Do the same on YouTube and other sites with their own search boxes.",
      "Numbered boxes on the screenshot mark what you can click or type into. Click a box by its number (screen_click). For a spot without a box, such as inside a video, use screen_click_at with pixel coordinates from the picture. To type, click the text box first, then screen_type.",
      "Never guess web addresses. Only use screen_go_to for a site's home page you know (like google.com or youtube.com).",
      "Scroll to see more of a page. Read prices, names and details from the picture carefully, and say where you saw them (the address bar shows the page address).",
      'If you see a CAPTCHA, a "verify you\'re human" check, a sign-in or a payment form, call browser_handoff so the user can do it, or browser_sign_in for a sign-in form when a saved login exists.',
    ].join(" "),
  ];
}

/** The Visual Bot's hands and eyes. Every action answers with a fresh screenshot. */
export function visualTools(browser: BrowserManager, bot: Bot, sites: string[]): ToolSpec[] {
  const id = bot.id;
  const mark = (ref: number) => browser.mark(id, ref);
  return [
    defineTool({
      name: "screen_look",
      description:
        "Take a screenshot of your browser tab. Numbered boxes mark what you can click or type into; set marks to false for a clean picture.",
      args: z.object({ marks: z.boolean().default(true) }),
      risk: () => safe("Look at the screen"),
      run: (args) => browser.look(id, args.marks),
    }),
    defineTool({
      name: "screen_watch",
      description:
        "Watch the screen for a few seconds: get several frames as a short clip, to follow a playing video, a slideshow or a page that is changing.",
      args: z.object({
        seconds: z.number().min(1).max(30).default(6),
        frames: z.number().int().min(2).max(6).default(4),
      }),
      risk: (args) => safe(`Watch the screen for ${args.seconds} seconds`),
      run: (args) => browser.watch(id, args.seconds, args.frames),
    }),
    defineTool({
      name: "screen_go_to",
      description:
        "Type an address into the address bar, like a person would: for a site's home page you know (google.com, youtube.com). Never guess deeper addresses.",
      args: z.object({ address: z.string().trim().min(3).max(500) }),
      prepare: (args) => {
        const address = typeof args.address === "string" ? args.address.trim() : args.address;
        return {
          address:
            typeof address === "string" && !/^[a-z]+:\/\//i.test(address) ? `https://${address}` : address,
        };
      },
      risk: (args) => addressRisk(args, args.address, `Open ${args.address}`),
      run: async (args) => {
        if (!isWebUrl(args.address)) return "Only http and https addresses can be opened.";
        return browser.goTo(id, args.address, mayReachLocal(args, args.address));
      },
    }),
    defineTool({
      name: "screen_click",
      description: "Click the thing in numbered box N on the latest screenshot.",
      args: z.object({ box: z.number().int().min(1) }),
      prepare: (args) => ({ box: args.box ?? args.ref ?? args.mark ?? args.number }),
      risk: (args) => {
        const element = mark(args.box);
        return clickRisk(element, `Click box ${args.box}${element?.label ? ` (“${element.label}”)` : ""}`);
      },
      run: (args) => browser.clickMark(id, args.box),
    }),
    defineTool({
      name: "screen_click_at",
      description:
        "Click a spot in the latest screenshot by its pixel position (x from the left, y from the top), for things without a numbered box.",
      // Models also send the point as "306, 472", [306, 472] or {point: …}.
      prepare: (args) => {
        const point = args.point ?? args.coordinates ?? args.position ?? args.x;
        const pair =
          typeof point === "string"
            ? point
                .split(/[\s,]+/)
                .filter(Boolean)
                .map(Number)
            : Array.isArray(point)
              ? point.map(Number)
              : null;
        return pair && pair.length === 2 && args.y === undefined ? { x: pair[0], y: pair[1] } : args;
      },
      args: z.object({ x: z.number().min(0).max(4000), y: z.number().min(0).max(4000) }),
      // Judged by the control under that spot, so a click by position can't skip the question a box click asks.
      risk: (args) => {
        const element = browser.markAt(id, args.x, args.y);
        const at = `Click at ${Math.round(args.x)}, ${Math.round(args.y)}`;
        return clickRisk(element, element?.label ? `${at} (“${element.label}”)` : at);
      },
      run: (args) => browser.clickAt(id, args.x, args.y),
    }),
    defineTool({
      name: "screen_type",
      description:
        "Type text into the box you clicked last (click it first). enter presses Enter afterwards, e.g. to search.",
      args: z.object({ text: z.string().max(2000), enter: z.boolean().default(false) }),
      // Enter is judged by what really has focus now, not by what was clicked last.
      risk: async (args) => {
        const summary = `Type “${args.text.slice(0, 60)}”`;
        return args.enter
          ? enterRisk(await browser.focused(id), `${summary} and press Enter`)
          : safe(summary);
      },
      run: (args) => browser.typeText(id, args.text, args.enter),
    }),
    defineTool({
      name: "screen_press",
      description:
        "Press a key: Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, Space, PageDown or PageUp.",
      args: z.object({
        key: z.enum([
          "Enter",
          "Tab",
          "Escape",
          "Backspace",
          "ArrowDown",
          "ArrowUp",
          "Space",
          "PageDown",
          "PageUp",
        ]),
      }),
      risk: async (args) => {
        if (args.key === "Enter") return enterRisk(await browser.focused(id), "Press Enter");
        if (args.key === "Space") return spaceRisk(await browser.focused(id), "Press Space");
        return safe(`Press ${args.key}`);
      },
      run: (args) => browser.pressKey(id, args.key === "Space" ? " " : args.key),
    }),
    defineTool({
      name: "screen_scroll",
      description: "Scroll the page to see more.",
      args: z.object({ direction: z.enum(["down", "up"]).default("down") }),
      risk: () => safe("Scroll"),
      run: (args) => browser.scrollView(id, args.direction),
    }),
    defineTool({
      name: "screen_back",
      description: "Go back to the previous page.",
      args: z.object({}),
      risk: () => safe("Go back"),
      run: () => browser.goBack(id),
    }),
    defineTool({
      name: "browser_handoff",
      description:
        "Ask the user to do something in your browser tab themselves (solve a CAPTCHA or human check, sign in, pay), then wait until they're done.",
      args: z.object({ reason: z.string().trim().min(1).max(500).describe("What the user should do") }),
      risk: () => safe("Ask the user to take over the browser"),
      run: async (args, ctx) => {
        const shown = browser.settings().show;
        if (shown) await browser.focus(id);
        const where = shown
          ? `in the browser window (${bot.name}'s tab) or in the Browser panel of this chat`
          : "in the Browser panel of this chat";
        const answer = await ctx.ask(`${args.reason}\n\nDo it ${where}, then reply here, e.g. “done”.`);
        const after = await browser.look(id);
        return { text: `The user replied: ${answer}\n${after.text}`, images: after.images };
      },
    }),
    ...(sites.length > 0
      ? [
          defineTool({
            name: "browser_sign_in",
            description: `Sign in on the page with a login the user saved in the Vault. The app types the password; you never see it. Give the box numbers of the username box and the password box. Works only on: ${sites.join(", ")}.`,
            args: z.object({
              username_box: z.number().int().min(1),
              password_box: z.number().int().min(1),
              submit: z.boolean().default(true),
            }),
            risk: () => ({
              level: "ask",
              kind: "general",
              badges: [BADGES.security],
              summary: "Sign in on this page with your saved login",
            }),
            run: async (args) => {
              await browser.signIn(id, args.username_box, args.password_box, args.submit);
              return browser.look(id);
            },
          }),
        ]
      : []),
  ];
}

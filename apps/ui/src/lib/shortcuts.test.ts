import { describe, expect, it } from "vitest";

import { globalShortcut, type KeyLike } from "./shortcuts";

const press = (key: string, over: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});
/** What Windows reports for AltGr: Ctrl and Alt down, and the AltGraph modifier set. */
const altGr = (key: string, over: Partial<KeyLike> = {}) =>
  press(key, { ctrlKey: true, altKey: true, getModifierState: (name) => name === "AltGraph", ...over });

const win = { mac: false, typing: false };
const mac = { mac: true, typing: false };

describe("global shortcuts", () => {
  it("resolves the documented ones", () => {
    expect(globalShortcut(press("[", { ctrlKey: true }), win)).toEqual({ type: "back" });
    expect(globalShortcut(press("]", { ctrlKey: true }), win)).toEqual({ type: "forward" });
    expect(globalShortcut(press("[", { metaKey: true }), mac)).toEqual({ type: "back" });
    expect(globalShortcut(press("k", { ctrlKey: true }), win)).toEqual({ type: "palette" });
    expect(globalShortcut(press(",", { ctrlKey: true }), win)).toEqual({ type: "settings" });
    expect(globalShortcut(press("/", { ctrlKey: true }), win)).toEqual({ type: "shortcuts" });
    expect(globalShortcut(press("3", { ctrlKey: true }), win)).toEqual({ type: "select", number: 3 });
    expect(globalShortcut(press("N", { ctrlKey: true, shiftKey: true }), win)).toEqual({ type: "newGroup" });
    expect(globalShortcut(press("Tab", { ctrlKey: true, shiftKey: true }), win)).toEqual({
      type: "cycle",
      backwards: true,
    });
    expect(globalShortcut(press("ArrowDown", { altKey: true }), win)).toEqual({ type: "step", delta: 1 });
    expect(globalShortcut(press("ArrowDown", { altKey: true }), { mac: false, typing: true })).toBeNull();
  });

  it("opens Details with Ctrl+Alt+B, or Cmd+Alt+B on a Mac", () => {
    const keys = { key: "b", code: "KeyB" };
    expect(globalShortcut(press(keys.key, { ...keys, ctrlKey: true, altKey: true }), win)).toEqual({
      type: "details",
    });
    expect(
      globalShortcut(
        press(keys.key, { ...keys, ctrlKey: true, altKey: true, getModifierState: () => false }),
        win,
      ),
    ).toEqual({ type: "details" });
    expect(globalShortcut(press("∫", { code: "KeyB", metaKey: true, altKey: true }), mac)).toEqual({
      type: "details",
    });
  });

  it("leaves AltGr keystrokes to typing", () => {
    // [ and ] are AltGr+8 and AltGr+9 on German, Nordic and Portuguese keyboards.
    expect(globalShortcut(altGr("["), win)).toBeNull();
    expect(globalShortcut(altGr("]"), win)).toBeNull();
    // AltGr+B types { on Czech and Slovak ones.
    expect(globalShortcut(altGr("{", { code: "KeyB" }), win)).toBeNull();
    expect(globalShortcut(altGr("b", { code: "KeyB" }), win)).toBeNull();
    expect(globalShortcut(altGr("/"), win)).toBeNull();
    expect(globalShortcut(altGr("5"), win)).toBeNull();
  });

  it("needs Alt up for Ctrl shortcuts that are not Details, even if the browser does not report AltGr", () => {
    const keys = { ctrlKey: true, altKey: true };
    expect(globalShortcut(press("[", keys), win)).toBeNull();
    expect(globalShortcut(press(",", keys), win)).toBeNull();
    expect(globalShortcut(press("5", keys), win)).toBeNull();
    expect(globalShortcut(press("k", keys), win)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { nextFocus, tabbable, type Focusable } from "./focus";

const item = (over: Partial<Focusable> = {}): Focusable => ({ tabIndex: 0, rendered: true, ...over });

describe("which elements Tab can land on", () => {
  it("takes ordinary controls", () => {
    expect(tabbable(item())).toBe(true);
    expect(tabbable(item({ type: "text" }))).toBe(true);
  });

  it("leaves out disabled, hidden, removed-from-order, unrendered and inert ones", () => {
    expect(tabbable(item({ disabled: true }))).toBe(false);
    expect(tabbable(item({ hidden: true }))).toBe(false);
    expect(tabbable(item({ tabIndex: -1 }))).toBe(false);
    expect(tabbable(item({ rendered: false }))).toBe(false);
    expect(tabbable(item({ blocked: true }))).toBe(false);
    expect(tabbable(item({ type: "hidden" }))).toBe(false);
  });
});

describe("where Tab goes inside a dialog", () => {
  it("leaves the middle of the dialog to the browser", () => {
    expect(nextFocus(4, 1, false)).toBeNull();
    expect(nextFocus(4, 2, true)).toBeNull();
  });

  it("goes round at the ends", () => {
    expect(nextFocus(4, 3, false)).toBe(0);
    expect(nextFocus(4, 0, true)).toBe(3);
    // A dialog with one control keeps focus on it either way.
    expect(nextFocus(1, 0, false)).toBe(0);
    expect(nextFocus(1, 0, true)).toBe(0);
  });

  it("brings focus in from outside: Tab to the first control, Shift+Tab to the last", () => {
    expect(nextFocus(4, -1, false)).toBe(0);
    expect(nextFocus(4, -1, true)).toBe(3);
  });

  it("keeps focus on the dialog itself when it has nothing to tab to", () => {
    expect(nextFocus(0, -1, false)).toBe(-1);
    expect(nextFocus(0, -1, true)).toBe(-1);
  });

  it("never lets repeated Tab leave a dialog, in either direction", () => {
    for (const count of [1, 2, 5]) {
      for (const backwards of [false, true]) {
        let at = -1;
        for (let press = 0; press < 40; press++) {
          const target = nextFocus(count, at, backwards);
          // null means the browser moves one step within the dialog.
          at = target ?? at + (backwards ? -1 : 1);
          expect(
            at,
            `${count} controls, ${backwards ? "back" : "forward"}, press ${press}`,
          ).toBeGreaterThanOrEqual(0);
          expect(at).toBeLessThan(count);
        }
      }
    }
  });
});

import { describe, expect, it } from "vitest";

import { createLayerStack } from "./layers";

describe("layer stack", () => {
  it("closes only the topmost layer on Escape", () => {
    const stack = createLayerStack();
    const closed: string[] = [];
    stack.push(() => closed.push("settings"));
    const popEditor = stack.push(() => closed.push("editor"));
    expect(stack.escape()).toBe(true);
    expect(closed).toEqual(["editor"]);
    popEditor();
    expect(stack.escape()).toBe(true);
    expect(closed).toEqual(["editor", "settings"]);
  });

  it("forgets removed layers, whatever order they go in", () => {
    const stack = createLayerStack();
    const closed: string[] = [];
    const popA = stack.push(() => closed.push("a"));
    const popB = stack.push(() => closed.push("b"));
    popA();
    popA();
    expect(stack.open).toBe(true);
    stack.escape();
    expect(closed).toEqual(["b"]);
    popB();
    expect(stack.open).toBe(false);
    expect(stack.escape()).toBe(false);
  });
});

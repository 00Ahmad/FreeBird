import { describe, expect, it } from "vitest";

import { step, visit, type History } from "./history";

const empty: History = { back: [], forward: [] };

describe("chat history", () => {
  it("goes back and forward through the chats you opened", () => {
    let history = visit(empty, null, "a");
    history = visit(history, "a", "b");
    history = visit(history, "b", "c");
    const back = step(history, "c", "back", () => true)!;
    expect(back.target).toBe("b");
    const again = step(back.history, "b", "back", () => true)!;
    expect(again.target).toBe("a");
    const forward = step(again.history, "a", "forward", () => true)!;
    expect(forward.target).toBe("b");
    expect(forward.history).toEqual({ back: ["a"], forward: ["c"] });
  });

  it("forgets forward when you open another chat, and ignores reopening the same one", () => {
    const history = { back: ["a"], forward: ["c"] };
    expect(visit(history, "b", "b")).toBe(history);
    expect(visit(history, "b", "d")).toEqual({ back: ["a", "b"], forward: [] });
  });

  it("skips deleted chats and stops when nothing is left", () => {
    const history = { back: ["a", "gone"], forward: [] };
    const back = step(history, "b", "back", (id) => id !== "gone")!;
    expect(back.target).toBe("a");
    expect(step(back.history, "a", "back", () => true)).toBeNull();
    expect(step(empty, null, "forward", () => true)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { diagramProject, hasCodeLinks, shownView } from "./codingLinks";

const planned = [{ id: "e1", files: ["n1", "n2"], description: "the page loads the script" }];
const code = [{ id: "c1", files: ["n1", "n2"], description: "index.html loads app.js" }];

describe("which connections the diagram draws", () => {
  it("draws the code's once there are any, and the plan's when asked", () => {
    const project = { edges: planned, codeLinks: code };
    expect(hasCodeLinks(project)).toBe(true);
    expect(diagramProject(project, "code").edges).toEqual(code);
    expect(diagramProject(project, "plan").edges).toEqual(planned);
  });

  it("draws the plan's while no code has been written, whatever was asked", () => {
    for (const codeLinks of [undefined, []]) {
      const project = { edges: planned, codeLinks };
      expect(hasCodeLinks(project)).toBe(false);
      expect(shownView(project, "code")).toBe("plan");
      expect(diagramProject(project, "code").edges).toEqual(planned);
    }
  });
});

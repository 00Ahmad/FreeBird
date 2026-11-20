import { describe, expect, it } from "vitest";

import type { CodingProject } from "@mrog/shared";

import { fileCardsFor } from "./coding-plan";
import { developerMessage, finalCheckMessage, qaMessage } from "./coding-tools";

/** Each card is sent what it needs: the files it connects to with their purposes, the rest by name only. */

const nodes = [
  { id: "n1", path: "index.html", purpose: "THE PAGE PURPOSE" },
  { id: "n2", path: "app.js", purpose: "THE SCRIPT PURPOSE" },
  { id: "n3", path: "README.md", purpose: "THE README PURPOSE" },
];
const edges = [{ id: "e1", files: ["n1", "n2"], description: "the page loads the script" }];
const project = {
  brief: "A task list",
  outputFolder: "/out",
  round: 0,
  nodes,
  edges,
  cards: fileCardsFor(nodes),
} as unknown as CodingProject;
const cardOf = (path: string) => project.cards.find((card) => card.title === path)!;

describe("what a card is told about the rest of the project", () => {
  it("gives the Developer the purposes of the files its card connects to, and only the names of the others", () => {
    const text = developerMessage(project, cardOf("app.js"), null, () => false);
    expect(text).toContain("The files this card connects to:\n- index.html: THE PAGE PURPOSE");
    expect(text).toContain("The project's other files (by name): README.md");
    expect(text).not.toContain("THE README PURPOSE");
    // Its own purpose is in the card itself, once.
    expect(text.split("THE SCRIPT PURPOSE")).toHaveLength(2);
  });

  it("does the same for QA", () => {
    const text = qaMessage(project, cardOf("app.js"), false, "linux");
    expect(text).toContain("- index.html: THE PAGE PURPOSE");
    expect(text).not.toContain("THE README PURPOSE");
  });

  it("still gives the whole-project check every file's purpose", () => {
    const text = finalCheckMessage(project, "nothing found", false, "linux");
    for (const purpose of ["THE PAGE PURPOSE", "THE SCRIPT PURPOSE", "THE README PURPOSE"])
      expect(text).toContain(purpose);
  });
});

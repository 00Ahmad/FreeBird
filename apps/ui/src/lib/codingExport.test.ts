import { describe, expect, it } from "vitest";

import { MAX_PLAN_EDGES, MAX_PLAN_FILES } from "@mrog/shared";

// The server's own reader of a plan: what an export has to survive.
import { planFromReply, validatePlan } from "../../../../packages/harness/src/coding-plan";
import { comment, connectorCard, edge, fileCard, node, project, withWork } from "./codingFixture";
import {
  exportName,
  legendLines,
  mermaidText,
  planningPrompt,
  planToFile,
  PLAN_FORMAT,
  snapshotOf,
  tintHex,
  toMarkdown,
  toMermaid,
  toSvg,
  xmlEscape,
} from "./codingExport";

const nodes = [
  node("n1", "src/main.py", "Starts the app."),
  node("n2", "src/storage.py", "Saves and loads\nthe data."),
  node("n3", "src/ui.py", "Draws the screen."),
  node("n4", "README.md", "How to run it."),
];
const edges = [
  edge("e1", ["n1", "n2"], "main calls storage"),
  edge("e2", ["n1", "n2", "n3"], 'ui "reads" <data> & main'),
];
const sample = (over = {}) =>
  project({
    brief: "A tiny notes app",
    nodes,
    edges,
    cards: [
      fileCard("n1", "done"),
      fileCard("n2", "todo", [comment("qa", "load() is missing")]),
      fileCard("n3", "in_progress"),
      fileCard("n4", "qa"),
      connectorCard("e1", "done"),
      connectorCard("e2", "qa"),
    ],
    ...over,
  });

describe("the plan file", () => {
  it("uses paths, not ids, in the plan's order", () => {
    const file = planToFile(sample());
    expect(file.format).toBe(PLAN_FORMAT);
    expect(file.version).toBe(1);
    expect(file.brief).toBe("A tiny notes app");
    expect(file.nodes.map((n) => n.path)).toEqual([
      "src/main.py",
      "src/storage.py",
      "src/ui.py",
      "README.md",
    ]);
    expect(file.edges[1]).toEqual({
      files: ["src/main.py", "src/storage.py", "src/ui.py"],
      description: 'ui "reads" <data> & main',
    });
    expect(JSON.stringify(file)).not.toMatch(/"n[1-4]"|"e[12]"/);
  });

  it("drops a connection that has lost its files", () => {
    const file = planToFile(project({ nodes: [nodes[0]!], edges: [edge("x", ["n1", "gone"])] }));
    expect(file.edges).toEqual([]);
  });

  it("is read back by the server's reader as the same files and connections", () => {
    const file = planToFile(sample());
    for (const text of [file, JSON.parse(JSON.stringify(file))]) {
      const result = validatePlan(text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.nodes.map((n) => [n.path, n.purpose])).toEqual(nodes.map((n) => [n.path, n.purpose]));
      const paths = new Map(result.nodes.map((n) => [n.id, n.path]));
      expect(result.edges.map((e) => [e.files.map((id) => paths.get(id)), e.description])).toEqual(
        edges.map((e) => [e.files.map((id) => nodes.find((n) => n.id === id)!.path), e.description]),
      );
    }
  });

  it("is found by the reader inside a chat reply too", () => {
    const reply = `Here is the plan:\n\n\`\`\`json\n${JSON.stringify(planToFile(sample()), null, 2)}\n\`\`\`\nHope that helps!`;
    const result = validatePlan(planFromReply(reply));
    expect(result.ok && result.nodes.length).toBe(4);
  });
});

describe("Markdown", () => {
  const text = toMarkdown(sample(), "Notes bot");

  it("lists the files, the connections and the checklist", () => {
    expect(text).toContain("# Notes bot");
    expect(text).toContain("> A tiny notes app");
    expect(text).toContain("## Files (4)");
    expect(text).toContain("- `src/main.py`: Starts the app.");
    expect(text).toContain("## Connections (2)");
    expect(text).toContain("- **e2** ");
    expect(text).toContain("`src/main.py`, `src/storage.py`, `src/ui.py`");
    expect(text).toContain("## Checklist (2 of 6 done)");
  });

  it("ticks what is done", () => {
    expect(text).toContain("- [x] `src/main.py`");
    expect(text).toContain("- [ ] `src/storage.py`");
    expect(text).toContain("- [x] **e1**");
    expect(text).toContain("- [ ] **e2**");
  });

  it("keeps a multi-line purpose on one line", () => {
    expect(text).toContain("Saves and loads the data.");
  });

  it("copes with an empty plan", () => {
    const empty = toMarkdown(project({ nodes: [], edges: [], cards: [], brief: "" }));
    expect(empty).toContain("No files yet.");
    expect(empty).toContain("No connections.");
    expect(empty).toContain("0 of 0 done");
    expect(empty).not.toContain(">");
  });
});

describe("Mermaid", () => {
  const text = toMermaid(sample());

  it("starts a flowchart with a node per file", () => {
    expect(text.startsWith("flowchart LR\n")).toBe(true);
    expect(text).toContain('f1["src/main.py"]');
    expect(text).toContain('f4["README.md"]');
  });

  it("draws a two-file connection as a labelled line", () => {
    expect(text).toContain('f1 ---|"main calls storage"| f2');
  });

  it("draws a connection of three files as a junction joined to each", () => {
    expect(text).toContain("j2([");
    expect(text).toContain("e2: ");
    for (const file of ["f1", "f2", "f3"]) expect(text).toContain(`${file} --- j2`);
    expect(text).not.toContain("f4 --- j2");
  });

  it("escapes names so they can't break the diagram", () => {
    expect(mermaidText('a "b" <c> & #d `e`')).toBe("a #quot;b#quot; #lt;c#gt; #amp; #35;d #96;e#96;");
    expect(text).toContain("ui #quot;reads#quot; #lt;data#gt; #amp; main");
    // Nothing between the quotes of a label is a bare quote or bracket.
    for (const line of text.split("\n").filter((l) => l.includes("["))) {
      const inner = line.slice(line.indexOf('["') + 2, line.lastIndexOf('"]'));
      expect(inner).not.toMatch(/["<>]/);
    }
    expect(toMermaid(project({ nodes: [node("a", 'we"ird.ts')] }))).toContain('f1["we#quot;ird.ts"]');
  });

  it("skips a connection with fewer than two known files", () => {
    expect(toMermaid(project({ nodes: [node("a")], edges: [edge("x", ["a", "ghost"])] }))).not.toContain(
      "---",
    );
  });
});

describe("snapshot", () => {
  const at = new Date("2026-02-03T04:05:06.000Z");
  const log = [{ at: "2026-01-01T10:00:00.000Z", text: "Plan ready" }];
  const snap = snapshotOf(sample({ round: 2, log, status: "developing" }), at);

  it("holds the plan, the board with its comments, the round and the log", () => {
    expect(snap.format).toBe("freebird-coding-snapshot");
    expect(snap.exportedAt).toBe("2026-02-03T04:05:06.000Z");
    expect(snap.round).toBe(2);
    expect(snap.maxRounds).toBe(5);
    expect(snap.plan).toEqual(planToFile(sample()));
    expect(snap.log).toEqual(log);
    expect(snap.cards).toHaveLength(6);
    expect(snap.cards[1]).toMatchObject({
      kind: "file",
      ref: "src/storage.py",
      column: "todo",
      comments: [expect.objectContaining({ author: "qa", text: "load() is missing" })],
    });
    expect(snap.cards[5]).toMatchObject({ kind: "connector", ref: "e2", column: "qa" });
  });

  it("is plain JSON and is not a plan to import", () => {
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(snap.format).not.toBe(PLAN_FORMAT);
  });

  it("has an empty log when the project has none", () => {
    expect(snapshotOf(sample(), at).log).toEqual([]);
  });
});

describe("planning prompt", () => {
  const text = planningPrompt("  Build a tiny notes app  ");

  it("names the exact format, the limits and the rules", () => {
    expect(text).toContain(`"format": "${PLAN_FORMAT}"`);
    expect(text).toContain('"nodes"');
    expect(text).toContain('"edges"');
    expect(text).toContain(`At most ${MAX_PLAN_FILES} files`);
    expect(text).toContain(`At most ${MAX_PLAN_EDGES} connections`);
    expect(MAX_PLAN_FILES).toBe(40);
    expect(MAX_PLAN_EDGES).toBe(80);
    expect(text).toMatch(/relative/);
    expect(text).toMatch(/purpose/);
    expect(text).toMatch(/2 or more/);
    expect(text).toMatch(/JSON only/);
  });

  it("includes the brief, trimmed", () => {
    expect(text).toContain("Project:\nBuild a tiny notes app\n");
  });

  it("asks for a description when there is no brief", () => {
    expect(planningPrompt("   ")).toContain("(Describe the project here.)");
  });

  it("shows an example the server's reader accepts", () => {
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}", text.indexOf("Rules:")) + 1);
    expect(validatePlan(JSON.parse(json)).ok).toBe(true);
  });
});

describe("download names", () => {
  it("builds <bot>-<kind>.<ext>", () => {
    expect(exportName("Notes Bot", "plan")).toBe("notes-bot-plan.json");
    expect(exportName("Notes Bot", "markdown")).toBe("notes-bot-plan.md");
    expect(exportName("Notes Bot", "mermaid")).toBe("notes-bot-plan.mmd");
    expect(exportName("Notes Bot", "svg")).toBe("notes-bot-diagram.svg");
    expect(exportName("Notes Bot", "snapshot")).toBe("notes-bot-snapshot.json");
  });

  it("makes a safe name from anything", () => {
    expect(exportName("  My / Bot: v2?! ", "plan")).toBe("my-bot-v2-plan.json");
    expect(exportName("???", "plan")).toBe("coding-bot-plan.json");
    expect(exportName("Café Bot", "plan")).toBe("cafe-bot-plan.json");
    expect(exportName("a".repeat(100), "plan").length).toBeLessThanOrEqual(40 + "-plan.json".length);
  });
});

describe("SVG file", () => {
  const svg = toSvg(sample());

  it("is a stand-alone SVG with a box per file and a junction per connection", () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain("src/main.py");
    expect(svg.match(/<circle [^>]*r="14"/g)).toHaveLength(2);
    expect(svg.match(/rx="9"/g)).toHaveLength(4);
  });

  it("has every style written in, so it opens on its own", () => {
    expect(svg).not.toContain("var(");
    expect(svg).not.toContain("color-mix");
    expect(svg).not.toContain("class=");
    expect(svg).not.toContain("<style");
    expect(svg).toContain('fill="#ffffff"');
  });

  it("escapes text", () => {
    expect(svg).toContain("ui &quot;reads&quot; &lt;data&gt; &amp; main");
    expect(svg).not.toMatch(/<data>/);
    expect(xmlEscape(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("marks cards QA sent back and cards that passed, with signs as well as colour", () => {
    expect(svg).toContain(">!</text>");
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain("Done");
    expect(svg).toContain("In progress");
  });

  it("colours each box by its card's column, and red when QA sent it back", () => {
    const stroke = (path: string) =>
      new RegExp(
        `<rect [^>]*stroke="(#[0-9a-f]{6})"[^>]*/>\\s*<circle [^>]*/>\\s*<text [^>]*>${path}</text>`,
      ).exec(svg)?.[1];
    expect(stroke("src/main.py")).toBe("#16a34a"); // done
    expect(stroke("src/storage.py")).toBe("#c2410c"); // todo, sent back
    expect(stroke("src/ui.py")).toBe("#b45309"); // in progress
    expect(stroke("README.md")).toBe("#3b9ae6"); // QA
  });

  it("marks a slow card with a clock, unless its sent-back or done mark wins", () => {
    const slow = (column: "in_progress" | "done") =>
      toSvg(
        project({
          nodes: [node("a", "src/a.py")],
          cards: [withWork(fileCard("a", column), { seconds: 900 })],
        }),
      );
    expect(slow("in_progress")).toContain('stroke-width="1.6"');
    expect(slow("done")).not.toContain('stroke-width="1.6"');
    expect(slow("done")).toContain('stroke-width="1.8"');
    expect(svg).not.toContain('stroke-width="1.6"');
  });

  it("lists the connections under the picture", () => {
    expect(svg).toContain("e1  main calls storage");
  });

  it("wraps a long connection onto lines that fit a small picture, and makes room for them", () => {
    const long = "word ".repeat(60).trim();
    const small = project({ nodes: [node("a"), node("b")], edges: [edge("x", ["a", "b"], long)], cards: [] });
    const out = toSvg(small);
    const width = Number(/width="(\d+)"/.exec(out)![1]);
    const [entry] = legendLines(small.edges, width);
    expect(entry!.label).toBe("e1");
    expect(entry!.lines.length).toBeGreaterThan(1);
    expect(entry!.lines.length).toBeLessThanOrEqual(3);
    // Every line fits across the picture at about 6.2 px a character, after the left margin and the label.
    for (const line of entry!.lines) expect(24 + (line.length + 4) * 6.2).toBeLessThanOrEqual(width - 24);
    expect(entry!.lines.at(-1)!.endsWith("…")).toBe(true);
    // The picture is tall enough for every line.
    const height = Number(/height="(\d+)"/.exec(out)![1]);
    const ys = [...out.matchAll(/<text [^>]*y="(\d+(?:\.\d+)?)"[^>]*>(?:e1 {2})?word/g)].map((m) =>
      Number(m[1]),
    );
    expect(ys).toHaveLength(entry!.lines.length);
    expect(Math.max(...ys)).toBeLessThan(height);
  });

  it("leaves out characters XML can't hold, so the file always opens", () => {
    expect(xmlEscape("a\u0000b\u0007c\u001Fd")).toBe("abcd");
    // Tab, line feed and carriage return are allowed.
    expect(xmlEscape("a\tb\nc\rd")).toBe("a\tb\nc\rd");
    expect(xmlEscape("x\u{FFFE}y\uD800z\u{FFFF}")).toBe("xyz");
    expect(xmlEscape("a\uDC00b")).toBe("ab");
    // A real emoji (a surrogate pair) stays.
    expect(xmlEscape("ok 😀")).toBe("ok 😀");
    const dirty = project({
      nodes: [node("a", "src/a\u0001.ts", "Does\u0008 things"), node("b")],
      edges: [edge("x", ["a", "b"], "bad\u000Bchar")],
      cards: [],
    });
    const controls = [...toSvg(dirty)].filter((char) => {
      const code = char.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    });
    expect(controls).toEqual([]);
  });

  it("is balanced and sized for its content", () => {
    expect(svg.match(/<g>/g)?.length).toBe(svg.match(/<\/g>/g)?.length);
    const [, width, height] = /width="(\d+)" height="(\d+)"/.exec(svg)!.map(Number) as [
      unknown,
      number,
      number,
    ];
    expect(width).toBeGreaterThan(300);
    expect(height).toBeGreaterThan(100);
  });

  it("draws an empty plan as a note", () => {
    const empty = toSvg(project({ nodes: [], edges: [], cards: [] }));
    expect(empty).toContain("This plan has no files yet.");
    expect(empty.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("mixes a colour over white", () => {
    expect(tintHex("#000000", 50)).toBe("#808080");
    expect(tintHex("#16a34a", 100)).toBe("#16a34a");
    expect(tintHex("#16a34a", 0)).toBe("#ffffff");
  });
});

describe("done checks in the exports", () => {
  const withChecks = () =>
    sample({
      nodes: [
        {
          ...nodes[0]!,
          done: ["#list has items", 'type #task "Milk" then click #add -> #list contains "Milk"'],
        },
        ...nodes.slice(1),
      ],
    });

  it("keeps them in the plan file, for the files that have them, and the server reads them back", () => {
    const file = planToFile(withChecks());
    expect(file.nodes[0]!.done).toEqual([
      "#list has items",
      'type #task "Milk" then click #add -> #list contains "Milk"',
    ]);
    expect(file.nodes[1]).not.toHaveProperty("done");
    const read = validatePlan(file);
    expect(read.ok && read.nodes[0]!.done).toEqual(file.nodes[0]!.done);
  });

  it("lists them under their file in the Markdown", () => {
    expect(toMarkdown(withChecks())).toContain(
      "- `src/main.py`: Starts the app.\n  - Done when: `#list has items`",
    );
  });

  it("tells a flagship model the forms they can take", () => {
    const text = planningPrompt("A to-do list");
    expect(text).toContain('a "done" list');
    expect(text).toContain('"#list has items"');
    expect(text).toContain('"click #refresh -> #list changes"');
  });
});

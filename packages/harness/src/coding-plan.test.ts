import { describe, expect, it } from "vitest";

import { MAX_PLAN_BYTES, normalizePlanPath, planFromReply, readPlanInput, validatePlan } from "./coding-plan";

const node = (path: string, purpose = "does a thing") => ({ path, purpose });
const errors = (...paths: string[]) => {
  const result = validatePlan({ nodes: paths.map((path) => node(path)) });
  return result.ok ? [] : result.errors;
};
const accepted = (...paths: string[]) => {
  const result = validatePlan({ nodes: paths.map((path) => node(path)) });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.nodes.map((n) => n.path);
};

describe("plan paths", () => {
  it("drops ./ steps anywhere, so one file written two ways is one file listed twice", () => {
    expect(normalizePlanPath("src/./a.js")).toBe("src/a.js");
    expect(normalizePlanPath("./src/././a.js")).toBe("src/a.js");
    expect(normalizePlanPath(".\\src\\.\\a.js")).toBe("src/a.js");
    expect(normalizePlanPath("src/.hidden/.env.example")).toBe("src/.hidden/.env.example");
    expect(errors("src/a.js", "src/./a.js")).toEqual([
      "nodes[1] “src/a.js”: listed twice (also nodes[0]). Each file appears once.",
    ]);
    // A connection may name the file either way.
    const plan = validatePlan({
      nodes: [node("src/a.js"), node("b.js")],
      edges: [{ files: ["./src/./a.js", "b.js"], description: "a uses b" }],
    });
    expect(plan.ok).toBe(true);
  });

  it("refuses a folder and an empty path however they are written", () => {
    expect(errors("src/.").join("\n")).toContain("that is a folder");
    expect(errors("src/./").join("\n")).toContain("that is a folder");
    expect(errors(".").join("\n")).toContain("the path is empty");
    expect(errors("./").join("\n")).toContain("the path is empty");
  });

  it("counts a name in two Unicode forms, or in two cases, as one name", () => {
    const composed = "café.js";
    const decomposed = "cafe\u0301.js";
    expect(composed).not.toBe(decomposed);
    expect(errors(composed, decomposed).join("\n")).toContain("listed twice (also nodes[0])");
    expect(errors("Café.js", decomposed).join("\n")).toContain("listed twice (also nodes[0])");
    expect(accepted(decomposed)).toEqual([composed]);
  });

  it("refuses the names Windows keeps for devices, in any case and with any extension", () => {
    for (const path of ["CON", "con.js", "src/aux/x.js", "NUL.txt", "Com1.ts", "lpt9", "src/prn.d.ts"])
      expect(errors(path).join("\n"), path).toContain("is a name Windows keeps for a device; rename it");
    expect(accepted("console.js", "src/con-fig.js", "auxiliary.ts", "com10.js")).toHaveLength(4);
  });

  it("refuses a name ending in a dot or a space", () => {
    for (const path of ["src./a.js", "a.js.", "src /a.js", "docs/v1. /x.md"])
      expect(errors(path).join("\n"), path).toContain("ends in a dot or a space");
    expect(accepted("docs/v1.0/readme.md", ".gitignore", "src/.config/x.json")).toHaveLength(3);
  });

  it("refuses control and invisible characters that make one name look like another", () => {
    for (const path of [
      "a\u0007.js",
      "a\u007f.js",
      "a\u0085.js",
      "a\u200b.js",
      "a\u200d.js",
      "invoice\u202egnp.js",
      "a\u2066.js",
      "a\ufeffb.js",
    ])
      expect(errors(path).join("\n"), JSON.stringify(path)).toContain("invisible characters");
    // Letters from any language are fine.
    expect(accepted("src/ünïcødé/日本.ts")).toHaveLength(1);
  });

  it("refuses a path over 200 characters, or a name in it over 100", () => {
    const long = `${"folder/".repeat(30)}a.js`;
    expect(long.length).toBeGreaterThan(200);
    expect(errors(long).join("\n")).toContain(`the path is ${long.length} characters; keep it under 200`);
    expect(errors(`${"n".repeat(101)}.js`).join("\n")).toContain("keep each name in the path under 100");
    expect(accepted(`${"n".repeat(96)}.js`, `${"d/".repeat(98)}x.js`)).toHaveLength(2);
  });

  it("refuses what the team may never write, and says why", () => {
    expect(errors(".git/hooks/pre-commit").join("\n")).toContain(
      "files in .git belong to a tool, not to the project, so the team may not write it; leave it out of the plan",
    );
    expect(errors("node_modules/x/index.js").join("\n")).toContain("files in node_modules belong to a tool");
    expect(errors(".vscode/tasks.json").join("\n")).toContain("can run commands when the project is opened");
    expect(errors("./.npmrc").join("\n")).toContain("can run commands");
    expect(accepted(".vscode/notes.md", "src/hooks/useThing.ts")).toHaveLength(2);
  });
});

describe("reading a plan from text", () => {
  const plan = { nodes: [{ path: "a.ts", purpose: "x" }], edges: [] };

  it("finds a plan after a { that never closes, even with a stray quote after it", () => {
    expect(planFromReply(`I'd use { braces here. The plan: ${JSON.stringify(plan)}`)).toEqual(plan);
    expect(planFromReply(`Use { for blocks on the 5" screen: ${JSON.stringify(plan)} done`)).toEqual(plan);
    expect(planFromReply(`a } b ${JSON.stringify(plan)} {`)).toEqual(plan);
    expect(planFromReply(`{"note": "a { in a string"} then ${JSON.stringify(plan)}`)).toEqual(plan);
    // The last plan wins, also after some pieces that look like one but don't parse.
    const broken = '```json\n{"nodes": [oops\n```\n'.repeat(20);
    expect(
      planFromReply(`${JSON.stringify({ ...plan, edges: null })}\n${broken}${JSON.stringify(plan)}`),
    ).toEqual(plan);
  });

  const quick = (label: string, read: () => unknown) => {
    const started = performance.now();
    read();
    const took = performance.now() - started;
    expect(took, `${label} took ${Math.round(took)} ms`).toBeLessThan(1000);
  };

  it("reads hostile text of 1 MB in linear time", () => {
    const size = MAX_PLAN_BYTES;
    for (const [label, unit] of [
      ["{", "{"],
      ['"{', '"{'],
      ["{}", "{}"],
      ['{"nodes":', '{"nodes":'],
      ["<think>", "<think>"],
      ["```", "```"],
      ["```json", "```json\n{"],
      ["\\", '{"\\'],
      // Pieces that name the files but don't parse: each failed parse is slow, so they are capped.
      ["bad objects", '{"nodes":}'],
      ["bad blocks", '```json\n{"nodes":}\n```\n'],
      ["bad nested", '{"files":x}{'],
    ] as const) {
      const text = unit.repeat(Math.floor(size / unit.length));
      quick(label, () => expect(planFromReply(text)).toBeNull());
    }
    // Through the import as well, just under the limit.
    quick("readPlanInput", () => expect(readPlanInput("{".repeat(MAX_PLAN_BYTES - 1))).toBeNull());
  });

  it("refuses more than 1 MB, counted in UTF-8 bytes, with a message", () => {
    const over = readPlanInput("x".repeat(MAX_PLAN_BYTES + 1));
    expect(over).toMatchObject({ error: expect.stringContaining("a plan can be at most 1 MB") });
    expect(readPlanInput("x".repeat(MAX_PLAN_BYTES))).toBeNull();
    // Fewer characters than the limit, but more bytes.
    expect(readPlanInput("é".repeat(MAX_PLAN_BYTES / 2 + 1))).toHaveProperty("error");
    // A parsed plan that big too.
    const big = { nodes: [{ path: "a.ts", purpose: "x".repeat(MAX_PLAN_BYTES) }] };
    expect(readPlanInput(big)).toHaveProperty("error");
    expect(readPlanInput(plan)).toEqual({ plan, brief: null });
  });
});

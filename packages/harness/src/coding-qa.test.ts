import { afterEach, describe, expect, it } from "vitest";

import { messageText, type CodingProject } from "@mrog/shared";
import type { ToolContext } from "@mrog/tools";

import { cardsFor } from "./coding-plan";
import {
  finalCheckMessage,
  finishCheckTool,
  qaMessage,
  roleRules,
  shellNote,
  type TurnCapture,
} from "./coding-tools";
import {
  cleanTmp,
  codingTeam,
  finalChecksOf,
  getProject,
  makeCoding,
  tmp,
  turnsOf,
  type,
  until,
} from "./coding-testing";
import { makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanTmp();
});

const startTeam = (team: ReturnType<typeof codingTeam>) =>
  makeHarness({ config: { dataDir: tmp("data") }, handlers: team.handlers });

const watch = (target: TestHarness) => {
  const published: CodingProject[] = [];
  target.bus.subscribe((event) => {
    if (event.type === "coding.updated") published.push(event.project);
  });
  return published;
};

const keyOf = (task: string) => /^(?:File|Connection): (.+)$/m.exec(task)![1];

// ---- the weather app from the user's run -------------------------------------------------------------------

const WEATHER = {
  nodes: [
    { path: "index.html", purpose: "the page" },
    { path: "weather-app.js", purpose: "fetches and shows the weather" },
    { path: "api-config.js", purpose: "holds the API key" },
  ],
  edges: [
    { files: ["index.html", "weather-app.js"], description: "page loads the script" },
    { files: ["weather-app.js", "api-config.js"], description: "script reads the config" },
  ],
};
const PAGE_MODULE = `<div id="weather"></div><script type="module" src="weather-app.js"></script>\n`;
const PAGE_PLAIN = `<div id="weather"></div><script src="weather-app.js"></script>\n`;
const WITH_IMPORT = `import { API_KEY } from './api-config.js';\ndocument.getElementById('weather').textContent = API_KEY;\n`;
const INLINED = `const API_KEY = 'YOUR_API_KEY_HERE';\ndocument.getElementById('weather').textContent = API_KEY;\n`;
const CONFIG = `export const API_KEY = 'YOUR_API_KEY_HERE';\n`;

const PAIR = {
  nodes: [WEATHER.nodes[0]!, WEATHER.nodes[1]!],
  edges: [WEATHER.edges[0]!],
};
const SHOW = `export function show() {\n  document.getElementById('weather').textContent = 'sunny';\n}\n`;

describe("a file that changes sends the cards that rely on it back to QA", () => {
  it("replays the weather app: the connection fix edits a shared file, the passed cards are checked again, and only then is it done", async () => {
    const team = codingTeam({
      plans: [{ tool: WEATHER }],
      develop: (card, attempt) => {
        if (card.key === "index.html") return { write: PAGE_MODULE };
        if (card.key === "weather-app.js") return { write: attempt === 1 ? WITH_IMPORT : INLINED };
        if (card.key === "api-config.js") return { write: CONFIG };
        // The Developer "fixes" the connection by putting the import back into the script.
        if (card.key === "script reads the config")
          return { extra: { path: "weather-app.js", content: WITH_IMPORT } };
        return {};
      },
      review: (card, nth) =>
        card.key === "weather-app.js" && nth === 1
          ? { pass: false, comment: "ES6 import won't work in a plain <script>" }
          : card.key === "script reads the config" && nth === 1
            ? {
                pass: false,
                comment: "does not import api-config.js, add import { API_KEY } from './api-config.js'",
              }
            : { pass: true },
    });
    h = await startTeam(team);
    const published = watch(h);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "A weather page");
    const done = await until(h, bot.id, (p) => p.status === "done");

    // Round 3 looked at the script and the page connection again, because the fix changed the script.
    expect(turnsOf(team, "qa").map((s) => keyOf(s.task))).toEqual([
      "index.html",
      "weather-app.js",
      "api-config.js",
      "weather-app.js",
      "page loads the script",
      "script reads the config",
      "weather-app.js",
      "page loads the script",
      "script reads the config",
    ]);
    expect(done.round).toBe(3);
    const lines = done.log!.map((l) => l.text);
    expect(lines).toContain(
      "weather-app.js changed while fixing weather-app.js ↔ api-config.js; weather-app.js goes back to QA",
    );
    expect(lines).toContain(
      "weather-app.js changed while fixing weather-app.js ↔ api-config.js; index.html ↔ weather-app.js goes back to QA",
    );
    const script = done.cards.find((c) => c.title === "weather-app.js")!;
    expect(script.comments.some((c) => c.text.startsWith("Back in QA: weather-app.js changed"))).toBe(true);
    // At no moment was the project done while one of those cards waited.
    for (const project of published)
      if (project.status === "done") expect(project.cards.every((c) => c.column === "done")).toBe(true);
    const requeued = published.find(
      (p) =>
        p.cards.find((c) => c.title === "index.html ↔ weather-app.js")?.column === "qa" &&
        p.cards.find((c) => c.title === "weather-app.js")?.column === "qa" &&
        p.round === 2,
    );
    expect(requeued).toBeTruthy();
    expect(requeued!.status).not.toBe("done");
  });

  it("tells QA what was said on the cards around the one it is reviewing", async () => {
    const team = codingTeam({
      plans: [{ tool: WEATHER }],
      develop: (card, attempt) =>
        card.key === "weather-app.js"
          ? { write: attempt === 1 ? WITH_IMPORT : INLINED }
          : card.key === "index.html"
            ? { write: PAGE_MODULE }
            : card.key === "api-config.js"
              ? { write: CONFIG }
              : {},
      review: (card, nth) =>
        card.key === "weather-app.js" && nth === 1
          ? { pass: false, comment: "ES6 import won't work in a plain <script>" }
          : { pass: true },
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "A weather page");
    await until(h, bot.id, (p) => p.status === "done");
    // The connection between the script and the config is first reviewed in round 2, when the script has a comment.
    const review = turnsOf(team, "qa").find((s) => keyOf(s.task) === "script reads the config")!;
    expect(review.task).toContain("What was said about the files around this card:");
    expect(review.task).toContain("weather-app.js: QA (round 1): ES6 import won't work in a plain <script>");
    expect(review.task).toContain("api-config.js: Developer (round 0): Did api-config.js");
    expect(review.task).toContain(shellNote());
  });
});

describe("the check of the whole project", () => {
  it("catches the plain <script> that loads a module, sends the connection back, and finishes only after the fix", async () => {
    const team = codingTeam({
      plans: [{ tool: PAIR }],
      develop: (card, attempt) =>
        card.key === "index.html"
          ? { write: PAGE_PLAIN }
          : card.key === "weather-app.js"
            ? { write: SHOW }
            : attempt === 2
              ? { extra: { path: "index.html", content: PAGE_MODULE } }
              : {},
    });
    h = await startTeam(team);
    const published = watch(h);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "A weather page");
    const done = await until(h, bot.id, (p) => p.status === "done");

    const connection = done.cards.find((c) => c.title === "index.html ↔ weather-app.js")!;
    const comment = connection.comments.find((c) => c.author === "qa" && c.text.includes("plain <script"))!;
    expect(comment.text).toContain('type="module"');
    expect(comment.round).toBe(1);
    expect(done.log!.map((l) => l.text)).toContain(
      `The automatic check sent index.html ↔ weather-app.js back: ${comment.text.slice(0, 69).trim()}…`,
    );
    // The model is asked about the whole project only once the automatic check finds nothing.
    expect(finalChecksOf(team)).toHaveLength(1);
    expect(done.round).toBe(2);
    // It was sent back, fixed, checked by QA again, and only then done.
    const back = published.findIndex(
      (p) => p.cards[2]?.column === "todo" && p.round === 1 && p.status === "developing",
    );
    const finished = published.findIndex((p) => p.status === "done");
    expect(back).toBeGreaterThan(-1);
    expect(finished).toBeGreaterThan(back);
  });

  it("sends a card back when QA's look at the whole project finds a problem, and carries on", async () => {
    const team = codingTeam({
      plans: [{ tool: PAIR }],
      develop: (card) =>
        card.key === "index.html"
          ? { write: PAGE_MODULE }
          : card.key === "weather-app.js"
            ? { write: SHOW }
            : {},
      finalCheck: (nth) =>
        nth === 1
          ? { ok: false, problems: [{ file: "weather-app.js", comment: "the page never calls show()" }] }
          : { ok: true },
    });
    h = await startTeam(team);
    const published = watch(h);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "A weather page");
    const done = await until(h, bot.id, (p) => p.status === "done");

    expect(finalChecksOf(team)).toHaveLength(2);
    const script = done.cards.find((c) => c.title === "weather-app.js")!;
    expect(script.comments.filter((c) => c.author === "qa").map((c) => [c.text, c.round])).toEqual([
      ["the page never calls show()", 1],
    ]);
    expect(done.log!.map((l) => l.text)).toContain(
      "QA's check of the whole project sent weather-app.js back: the page never calls show()",
    );
    expect(done.round).toBe(2);
    // The project did not finish on the first look.
    const sentBack = published.findIndex((p) => p.cards[1]?.column === "todo" && p.round === 1);
    expect(sentBack).toBeGreaterThan(-1);
    expect(published.findIndex((p) => p.status === "done")).toBeGreaterThan(sentBack);
    expect(published.slice(sentBack).some((p) => p.status === "developing")).toBe(true);
    // The final check asked about the whole project: files, connections and what the automatic checks said.
    const asked = finalChecksOf(team)[0]!.task;
    expect(asked).toContain("FINAL CHECK OF THE WHOLE PROJECT");
    expect(asked).toContain("- index.html: the page");
    expect(asked).toContain("page loads the script (index.html, weather-app.js)");
    expect(asked).toContain("The automatic checks: all clear");
    expect(asked).toContain("finish_check");
  });

  it("stops with an error when QA never gives a usable verdict on the whole project, and starts the check again on resume", async () => {
    const team = codingTeam({
      plans: [{ tool: PAIR }],
      develop: (card) =>
        card.key === "index.html"
          ? { write: PAGE_MODULE }
          : card.key === "weather-app.js"
            ? { write: SHOW }
            : {},
      // A file that isn't in the project is refused by the tool, so there is no verdict.
      finalCheck: () => ({ ok: false, problems: [{ file: "nope.js", comment: "x" }] }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "A weather page");
    const failed = await until(h, bot.id, (p) => p.status === "error");
    expect(failed.error).toContain("never called finish_check");
    expect(finalChecksOf(team)).toHaveLength(3);
    expect(failed.cards.every((c) => c.column === "done")).toBe(true);

    team.behave.finalCheck = () => ({ ok: true });
    await h.app.inject({
      method: "POST",
      url: `/api/bots/${bot.id}/coding/resume`,
      headers: { authorization: `Bearer ${"t".repeat(64)}` },
    });
    await until(h, bot.id, (p) => p.status === "done");
    expect(finalChecksOf(team)).toHaveLength(4);
  });

  it("counts the final check in the round limit", async () => {
    const team = codingTeam({
      plans: [{ tool: PAIR }],
      develop: (card) =>
        card.key === "index.html"
          ? { write: PAGE_MODULE }
          : card.key === "weather-app.js"
            ? { write: SHOW }
            : {},
      finalCheck: () => ({ ok: false, problems: [{ file: "weather-app.js", comment: "still broken" }] }),
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true, maxRounds: 2 });
    await type(h, bot, "A weather page");
    const stuck = await until(h, bot.id, (p) => p.status === "needs_you");
    expect(stuck.round).toBe(2);
    expect(stuck.note).toContain("weather-app.js");
    expect(stuck.note).toContain("still broken");
    expect(getProject(h, bot.id).status).toBe("needs_you");
  });
});

describe("the closing message", () => {
  it("ends with what to do before running it: placeholders to fill in and the local web server", async () => {
    const team = codingTeam({
      plans: [{ tool: WEATHER }],
      develop: (card) =>
        card.key === "index.html"
          ? { write: PAGE_MODULE }
          : card.key === "weather-app.js"
            ? { write: WITH_IMPORT }
            : card.key === "api-config.js"
              ? { write: CONFIG }
              : {},
    });
    h = await startTeam(team);
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "A weather page");
    await until(h, bot.id, (p) => p.status === "done");
    const last = messageText(h.store.messages.list(bot.threadId).at(-1)!);
    expect(last).toMatch(/^Done: all 5 cards passed QA\. The project is in /);
    expect(last).toContain(
      "\n\nBefore you run it:\n- add your own API key in api-config.js\n- open it through a local web server (for example run `python -m http.server` in the folder), not by double-clicking the file",
    );
  });

  it("leaves the list out when there is nothing to say", async () => {
    h = await startTeam(
      codingTeam({ plans: [{ tool: { nodes: [{ path: "a.txt", purpose: "a note" }], edges: [] } }] }),
    );
    const { bot } = await makeCoding(h, tmp("out"), { autoApprove: true });
    await type(h, bot, "A note");
    await until(h, bot.id, (p) => p.status === "done");
    const last = messageText(h.store.messages.list(bot.threadId).at(-1)!);
    expect(last).toMatch(/^Done: all 1 cards passed QA\./);
    expect(last).not.toContain("Before you run it");
  });
});

describe("what QA and the Developer are told", () => {
  const project = () => {
    const nodes = [
      { id: "n1", path: "a.js", purpose: "a" },
      { id: "n2", path: "b.js", purpose: "b" },
    ];
    const edges = [{ id: "e1", files: ["n1", "n2"], description: "a uses b" }];
    const cards = cardsFor(nodes, edges);
    const say = (card: number, author: "qa" | "developer", text: string, round: number) =>
      cards[card]!.comments.push({ author, text, round, at: new Date().toISOString() });
    say(0, "qa", "a: one", 1);
    for (let i = 2; i <= 5; i++) say(0, "developer", `a: note ${i}`, i);
    say(1, "qa", "b: wrong name", 1);
    say(2, "qa", "link: needs an import", 2);
    return {
      brief: "b",
      outputFolder: "/out",
      round: 2,
      nodes,
      edges,
      cards,
    } as unknown as CodingProject;
  };

  it("gives a connection card the last 3 comments of each file it links", () => {
    const p = project();
    const text = qaMessage(p, p.cards[2]!, false, "linux");
    expect(text).toContain("What was said about the files around this card:");
    expect(text).toContain("- a.js: Developer (round 5): a: note 5");
    expect(text).toContain("- a.js: Developer (round 3): a: note 3");
    expect(text).not.toContain("a: note 2");
    expect(text).not.toContain("a: one");
    expect(text).toContain("- b.js: QA (round 1): b: wrong name");
    // Its own comments are under the card's own heading, not in the neighbours' list.
    expect(text).toContain("Notes on this card so far:");
  });

  it("gives a file card the comments of the connections that touch it", () => {
    const p = project();
    const text = qaMessage(p, p.cards[1]!, false, "linux");
    expect(text).toContain("- a.js ↔ b.js: QA (round 2): link: needs an import");
    expect(text).not.toContain("a: note");
  });

  it("has no neighbours section when nobody has said anything", () => {
    const p = project();
    p.cards.forEach((card) => (card.comments = []));
    expect(qaMessage(p, p.cards[0]!, false, "linux")).not.toContain("What was said about");
  });

  it("says which shell commands run in, and to check for real", () => {
    const p = project();
    const windows = qaMessage(p, p.cards[0]!, false, "win32");
    expect(windows).toContain("Windows PowerShell 5.1");
    expect(windows).toContain("no && (join commands with ;)");
    expect(windows).toContain("Select-String");
    expect(windows).toContain("node --check");
    const unix = qaMessage(p, p.cards[0]!, false, "linux");
    expect(unix).toContain("Commands run in sh");
    expect(unix).not.toContain("PowerShell");
    expect(finalCheckMessage(p, "all clear", false, "win32")).toContain("Windows PowerShell 5.1");
    expect(shellNote("darwin")).toContain("sh");
    // The note follows this computer when nobody says otherwise.
    expect(shellNote()).toBe(shellNote(process.platform));
    // And each command still asks the user first.
    expect(windows).toContain("each command asks the user first");
  });

  it("forbids invented secrets, and has QA accept a marked placeholder", () => {
    const developer = roleRules("developer", "/out");
    expect(developer).toContain("Never invent an API key, token, password or any other secret");
    expect(developer).toContain("YOUR_API_KEY_HERE");
    const qa = roleRules("qa", "/out");
    expect(qa).toContain("accept it and never ask for a real key");
    expect(qa).toContain("Fail a file that contains what looks like a real secret");
    const p = project();
    expect(qaMessage(p, p.cards[0]!)).toContain("never ask for a real key");
    expect(finalCheckMessage(p, "all clear")).toContain("never ask for a real key");
  });
});

describe("finish_check", () => {
  const planned = ["index.html", "src/app.js"];
  const call = async (args: Record<string, unknown>) => {
    const capture: TurnCapture = {};
    const tool = finishCheckTool(capture, () => planned);
    const parsed = tool.args.safeParse(tool.prepare ? tool.prepare(args) : args);
    if (!parsed.success) return { result: "invalid", capture };
    return { result: String(await tool.run(parsed.data, {} as ToolContext)), capture };
  };

  it("takes ok true with no problems", async () => {
    const { result, capture } = await call({ ok: true });
    expect(result).toContain("Verdict recorded: ok");
    expect(capture.check).toEqual({ ok: true, problems: [] });
  });

  it("refuses ok true with problems, and ok false with none", async () => {
    const withProblems = await call({ ok: true, problems: [{ file: "index.html", comment: "x" }] });
    expect(withProblems.result).toContain("ok is true but you listed problems");
    expect(withProblems.capture.check).toBeUndefined();
    const none = await call({ ok: false });
    expect(none.result).toContain("ok is false but you listed no problems");
    expect(none.capture.check).toBeUndefined();
  });

  it("needs a known planned file and a comment for each problem", async () => {
    const unknown = await call({ ok: false, problems: [{ file: "other.js", comment: "bad" }] });
    expect(unknown.result).toContain(
      '"other.js" is not one of the project\'s files. Files: index.html, src/app.js',
    );
    expect(unknown.capture.check).toBeUndefined();
    const silent = await call({ ok: false, problems: [{ file: "index.html", comment: "   " }] });
    expect(silent.result).toContain("has no comment");
    expect(silent.capture.check).toBeUndefined();
  });

  it("records valid problems under the planned path, and takes the shapes small models send", async () => {
    const { result, capture } = await call({
      ok: false,
      problems: JSON.stringify([
        { file: "SRC\\App.js", comment: " the config is never read " },
        { file: "index.html", comment: "no script tag" },
      ]),
    });
    expect(result).toContain("2 problems");
    expect(capture.check).toEqual({
      ok: false,
      problems: [
        { file: "src/app.js", comment: "the config is never read" },
        { file: "index.html", comment: "no script tag" },
      ],
    });
    const single = await call({ ok: false, problems: { file: "index.html", comment: "one" } });
    expect(single.capture.check!.problems).toHaveLength(1);
    expect(
      (await call({ pass: false, problems: [{ file: "index.html", comment: "c" }] })).capture.check!.ok,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  consoleFindings,
  controlFindings,
  errorLine,
  fileFromText,
  fileFromUrl,
  launchFindings,
  MAX_FINDINGS,
  mergeFindings,
} from "./index";

const planned = ["index.html", "js/app.js", "style.css", "app.py", "src/views/home.py"];
const origin = "http://127.0.0.1:5173";

describe("mapping what the app said to planned files", () => {
  it("finds a planned file by address on the app's own origin only", () => {
    expect(fileFromUrl(`${origin}/js/app.js?v=2`, origin, planned)).toBe("js/app.js");
    expect(fileFromUrl("https://cdn.example.com/js/app.js", origin, planned)).toBeUndefined();
    expect(fileFromUrl(`${origin}/JS/App.js`, origin, planned)).toBe("js/app.js");
  });

  it("takes the deepest own frame of a traceback, as whole path parts", () => {
    const trace = [
      "Traceback (most recent call last):",
      '  File "C:\\out\\app.py", line 3, in <module>',
      '  File "C:\\out\\src\\views\\home.py", line 9, in render',
      "NameError: name 'tittle' is not defined",
    ].join("\n");
    expect(fileFromText(trace, planned)).toBe("src/views/home.py");
    expect(fileFromText('File "C:\\out\\myapp.py", line 1', planned)).toBeUndefined();
    expect(fileFromText("    at render (http://127.0.0.1:5173/js/app.js:12:5)", planned)).toBe("js/app.js");
  });

  it("picks the line that says what went wrong", () => {
    expect(errorLine("Starting…\nModuleNotFoundError: No module named 'flask'\n")).toBe(
      "ModuleNotFoundError: No module named 'flask'",
    );
    expect(errorLine("just output\nlast line")).toBe("last line");
  });
});

describe("the launch check", () => {
  it("sends a crash on start back to the file the traceback names", () => {
    const found = launchFindings(
      {
        started: false,
        exitCode: 1,
        output: 'Traceback (most recent call last):\n  File "app.py", line 2\nSyntaxError: invalid syntax',
      },
      planned,
      "app.py",
    );
    expect(found).toEqual([
      {
        file: "app.py",
        problem: expect.stringContaining(
          "stopped as soon as it started (exit code 1): SyntaxError: invalid syntax",
        ),
      },
    ]);
  });

  it("reports an app that never answered, and a traceback printed while running", () => {
    expect(
      launchFindings({ started: false, exitCode: null, timedOut: true, output: "" }, planned, "app.py")[0]!
        .problem,
    ).toContain("never came up");
    expect(
      launchFindings(
        {
          started: true,
          exitCode: null,
          output: 'Traceback (most recent call last):\n  File "src/views/home.py"\nKeyError: x',
        },
        planned,
        "app.py",
      ),
    ).toEqual([{ file: "src/views/home.py", problem: expect.stringContaining("KeyError: x") }]);
  });

  it("finds nothing when it started cleanly", () => {
    expect(
      launchFindings(
        { started: true, exitCode: null, output: " * Running on http://127.0.0.1:5000" },
        planned,
        "app.py",
      ),
    ).toEqual([]);
  });
});

describe("the console check", () => {
  const context = { origin, planned, page: "index.html" };

  it("sends a script error to the script, with the page as related", () => {
    expect(
      consoleFindings(
        [{ type: "error", text: "TypeError: x is null", source: `${origin}/js/app.js` }],
        context,
      ),
    ).toEqual([
      {
        file: "js/app.js",
        problem: expect.stringContaining("TypeError: x is null"),
        related: ["index.html"],
      },
    ]);
  });

  it("sends a file that failed to load to the page that loads it", () => {
    const found = consoleFindings(
      [
        { type: "response", url: `${origin}/js/app.js`, status: 404 },
        { type: "response", url: `${origin}/js/missing.js`, status: 404 },
      ],
      context,
    );
    expect(found[0]).toMatchObject({ file: "index.html", related: ["js/app.js"] });
    expect(found[1]!.problem).toContain("/js/missing.js, which isn't there (HTTP 404)");
  });

  it("ignores other sites, the browser's own icon request and aborted loads", () => {
    expect(
      consoleFindings(
        [
          { type: "error", text: "ad blocked", source: "https://ads.example.com/a.js" },
          { type: "response", url: `${origin}/favicon.ico`, status: 404 },
          { type: "response", url: "https://cdn.example.com/x.js", status: 404 },
          { type: "request", url: `${origin}/api`, text: "net::ERR_ABORTED" },
        ],
        context,
      ),
    ).toEqual([]);
  });

  it("sends a server error to the server's main file, once", () => {
    const found = consoleFindings(
      [
        { type: "response", url: `${origin}/`, status: 500 },
        { type: "response", url: `${origin}/`, status: 500 },
      ],
      { ...context, page: "templates/index.html", main: "app.py" },
    );
    expect(found).toEqual([{ file: "app.py", problem: expect.stringContaining("HTTP 500") }]);
  });
});

describe("the control check", () => {
  it("names the control and what is wrong with it", () => {
    const found = controlFindings(
      [
        { kind: "no-handler", label: "Add task" },
        { kind: "covered", label: "Save", by: "Cookie banner" },
        { kind: "no-size", label: "" },
      ],
      "index.html",
      ["js/app.js", "index.html"],
    );
    expect(found[0]).toEqual({
      file: "index.html",
      problem: expect.stringContaining("“Add task” does nothing when clicked"),
      related: ["js/app.js"],
    });
    expect(found[1]!.problem).toContain("“Cookie banner” lies on top of it");
    expect(found[2]!.problem).toContain("a button with no name");
  });

  it("merges lists without repeats, capped", () => {
    const one = { file: "a", problem: "x" };
    expect(mergeFindings([one], [one, { file: "b", problem: "y" }])).toHaveLength(2);
    const many = Array.from({ length: 20 }, (_, i) => ({ file: "a", problem: String(i) }));
    expect(mergeFindings(many)).toHaveLength(MAX_FINDINGS);
  });
});

describe("a program the computer doesn't have", () => {
  it("is named, so it isn't sent to the Developer as a bug", async () => {
    const { missingProgram } = await import("./index");
    expect(
      missingProgram("Python was not found; run without arguments to install from the Microsoft Store", 9009),
    ).toBe("Python");
    expect(
      missingProgram(
        "npm : The term 'npm' is not recognized as the name of a cmdlet, function, script file",
        1,
      ),
    ).toBe("npm");
    expect(missingProgram("/bin/sh: 1: python3: not found", 127)).toBe("python3");
    expect(missingProgram("ModuleNotFoundError: No module named 'flask'", 1)).toBeNull();
  });
});

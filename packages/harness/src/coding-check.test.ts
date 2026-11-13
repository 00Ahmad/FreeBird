import { describe, expect, it } from "vitest";

import { beforeYouRun, checkProject, usesModuleSyntax } from "./coding-check";

/** The project's files as a map; every file is planned unless `planned` says which are. */
const run = (files: Record<string, string>, planned = Object.keys(files)) =>
  checkProject({ files: planned, read: (path) => files[path] ?? null });
const problems = (files: Record<string, string>, planned?: string[]) =>
  run(files, planned).map((finding) => finding.problem);

// The files from the weather app that passed QA although the page could not work.
const PAGE = (tag: string) => `<!doctype html><html><body><div id="weather"></div>${tag}</body></html>`;
const WEATHER_JS = `import { API_KEY } from './api-config.js';\ndocument.getElementById('weather').textContent = API_KEY;\n`;
const CONFIG_JS = `export const API_KEY = 'YOUR_API_KEY_HERE';\n`;

describe("a page loads a script", () => {
  it("flags a plain <script src> whose file uses import/export (the weather-app bug)", () => {
    const found = run({
      "index.html": PAGE('<script src="weather-app.js"></script>'),
      "weather-app.js": WEATHER_JS,
      "api-config.js": CONFIG_JS,
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "index.html", related: ["weather-app.js"] });
    expect(found[0]!.problem).toContain('plain <script src="weather-app.js"> tag');
    expect(found[0]!.problem).toContain('type="module"');
  });

  it("is happy with type=module, in any spelling", () => {
    for (const tag of [
      '<script type="module" src="weather-app.js"></script>',
      "<script type='module' src='weather-app.js'></script>",
      '<script src="weather-app.js" type="MODULE"></script>',
    ])
      expect(
        problems({ "index.html": PAGE(tag), "weather-app.js": WEATHER_JS, "api-config.js": CONFIG_JS }),
      ).toEqual([]);
  });

  it("is happy with a plain script that has no import or export", () => {
    const script = `const API_KEY = 'YOUR_API_KEY_HERE';\n// import { x } from './y.js'\ndocument.getElementById('weather');\n`;
    expect(
      problems({ "index.html": PAGE('<script src="weather-app.js"></script>'), "weather-app.js": script }),
    ).toEqual([]);
    expect(usesModuleSyntax("const x = require('y');\nmodule.exports = x;")).toBe(false);
    expect(usesModuleSyntax("const m = await import('./x.js');")).toBe(false);
    expect(usesModuleSyntax("/* import a from 'b' */\nlet x = 1;")).toBe(false);
    expect(usesModuleSyntax("export default function () {}")).toBe(true);
    expect(usesModuleSyntax("import './side-effect.js';")).toBe(true);
  });

  it("finds the script in a folder relative to the page", () => {
    const found = run({
      "web/index.html": PAGE('<script src="js/app.js"></script>'),
      "web/js/app.js": "export const a = 1;",
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toContain("web/js/app.js");
  });

  it("flags a script, stylesheet or picture that is not there, and ignores web addresses and site paths", () => {
    const html = PAGE(
      [
        '<script src="missing.js"></script>',
        '<link rel="stylesheet" href="styles.css">',
        '<img src="logo.png">',
        '<script src="https://cdn.example.com/lib.js"></script>',
        '<script src="//cdn.example.com/lib.js"></script>',
        '<link rel="stylesheet" href="/static/site.css">',
        '<img src="data:image/png;base64,AAAA">',
        '<script src="{{ url }}"></script>',
        "<script>console.log(1)</script>",
      ].join(""),
    );
    const found = problems({ "index.html": html, "styles.css": "body {}" });
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("loads missing.js with a <script> tag, but there is no such file");
    expect(found[1]).toContain("<img> pointing at logo.png");
  });
});

describe("imports between scripts", () => {
  it("flags an import of a file that is not there, and resolves the endings a bundler would", () => {
    expect(problems({ "a.js": "import { x } from './nope.js';" })).toEqual([
      "a.js imports ./nope.js, but there is no such file.",
    ]);
    expect(problems({ "a.js": "import { x } from './b';", "b.js": "export const x = 1;" })).toEqual([]);
    expect(problems({ "a.js": "import { x } from './lib';", "lib/index.js": "export const x = 1;" })).toEqual(
      [],
    );
    expect(problems({ "src/a.ts": "import { x } from '../b.js';", "b.js": "export const x = 1;" })).toEqual(
      [],
    );
    // Packages are not files of the project.
    expect(problems({ "a.js": "import React from 'react';\nimport x from 'node:fs';" })).toEqual([]);
  });

  it("flags a name the other file doesn't export, and a default import with no default export", () => {
    const found = problems({
      "a.js": "import { load, save as keep, missing } from './b.js';",
      "b.js": "export function load() {}\nexport const save = 1;",
    });
    expect(found).toEqual(["a.js imports missing from ./b.js, but b.js doesn't export it."]);
    expect(problems({ "a.js": "import thing from './b.js';", "b.js": "export const x = 1;" })[0]).toContain(
      "the default export",
    );
    expect(
      problems({ "a.js": "import thing, { x } from './b.js';", "b.js": "export default 1;\nexport { x };" }),
    ).toEqual([]);
    expect(
      problems({ "a.js": "import { y } from './b.js';", "b.js": "const x = 1;\nexport { x as y };" }),
    ).toEqual([]);
    expect(problems({ "a.js": "import * as b from './b.js';", "b.js": "export const x = 1;" })).toEqual([]);
  });

  it("only speaks when it is sure what the other file exports", () => {
    for (const other of [
      "module.exports = { x: 1 };",
      "exports.x = 1;",
      "export * from './c.js';",
      "export const { x } = obj;",
    ])
      expect(
        problems({ "a.js": "import { x } from './b.js';", "b.js": other, "c.js": "export const x = 1;" }),
      ).toEqual([]);
  });

  it("checks re-exports and side-effect imports too", () => {
    expect(problems({ "a.js": "export { x } from './b.js';", "b.js": "export const y = 1;" })[0]).toContain(
      "imports x from ./b.js",
    );
    expect(problems({ "a.js": "import './setup.js';" })).toEqual([
      "a.js imports ./setup.js, but there is no such file.",
    ]);
    expect(problems({ "a.js": "// import { x } from './nope.js';\nlet a = 1;" })).toEqual([]);
  });
});

describe("element ids", () => {
  const page = '<div id="weather"></div><button id="go-btn"></button>';

  it("flags an id a script looks for that no page has, and leaves classes alone", () => {
    const found = run({
      "index.html": page,
      "app.js": `document.getElementById('weather');\ndocument.querySelector('#city-input');\ndocument.querySelector('.card');\nconst b = document.getElementById("go-btn");`,
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toBe(
      'app.js looks for the element with id "city-input", but no page in the project has id="city-input".',
    );
    expect(found[0]!.related).toEqual(["index.html"]);
  });

  it("counts ids that a script makes itself", () => {
    expect(
      problems({
        "index.html": page,
        "app.js": `const el = document.createElement('div');\nel.id = 'made';\ndocument.getElementById('made');\ndocument.body.innerHTML = '<p id="inline"></p>';\ndocument.getElementById('inline');`,
      }),
    ).toEqual([]);
  });

  it("says nothing when ids are built at run time, or when there is no page", () => {
    expect(
      problems({ "index.html": page, "app.js": `el.id = name;\ndocument.getElementById('anything');` }),
    ).toEqual([]);
    expect(problems({ "app.js": `document.getElementById('anything');` })).toEqual([]);
    expect(problems({ "index.html": page, "app.js": "// document.getElementById('gone')\n" })).toEqual([]);
  });
});

describe("JSON files", () => {
  it("flags one that doesn't parse", () => {
    expect(problems({ "data.json": '{"a": 1,}' })[0]).toMatch(/^data\.json is not valid JSON/);
    expect(problems({ "data.json": '{"a": [1, 2]}' })).toEqual([]);
  });
});

describe("secrets", () => {
  it("flags a made-up key (the 32-hex key the Developer invented) and accepts a marked placeholder", () => {
    const real = problems({
      "api-config.js": `export const API_KEY = 'x';\nconst config = { apiKey: "3f2a9c4e8b7d41a0b6c5d2e9f8a7b6c5" };`,
    });
    expect(real).toHaveLength(1);
    expect(real[0]).toContain("looks like a real key");
    expect(real[0]).toContain("YOUR_API_KEY_HERE");
    expect(problems({ "api-config.js": CONFIG_JS })).toEqual([]);
    expect(problems({ "api-config.js": `const apiKey = 'YOUR_API_KEY_HERE_PLEASE_1234';` })).toEqual([]);
  });

  it("recognises names and quoting, and skips short values, markers and non-alphanumeric text", () => {
    expect(problems({ "a.js": `const token = 'abcdefghij1234567890ab';` })).toHaveLength(1);
    expect(problems({ "a.json": `{"secret": "abcdefghij1234567890ab"}` })).toHaveLength(1);
    expect(problems({ "a.js": `const password = "abcdefghij1234567890ab";` })).toHaveLength(1);
    expect(problems({ "a.js": `const apiKey = 'short123';` })).toEqual([]);
    expect(problems({ "a.js": `const apiKey = 'REPLACEwithyourkey1234567890';` })).toEqual([]);
    expect(problems({ "a.js": `const apiKey = 'XXXXXXXXXXXXXXXXXXXXXXXX';` })).toEqual([]);
    expect(problems({ "a.js": `const apiKey = '<paste your key here please>';` })).toEqual([]);
    expect(problems({ "a.js": `const apiKey = process.env.WEATHER_KEY_FROM_THE_ENVIRONMENT;` })).toEqual([]);
    expect(problems({ "a.js": `const label = 'abcdefghij1234567890abcdef';` })).toEqual([]);
  });
});

describe("only planned files are checked", () => {
  it("ignores a file nobody planned, though it can be a script's target", () => {
    const files = {
      "index.html": PAGE('<script src="extra.js"></script>'),
      "extra.js": "let a = 1;",
      "notes.js": "import { x } from './nope.js';",
    };
    expect(problems(files, ["index.html"])).toEqual([]);
    // A plain script whose target is a file that was never planned still counts.
    expect(problems({ ...files, "extra.js": "export const a = 1;" }, ["index.html"])).toHaveLength(1);
  });
});

describe("before you run it", () => {
  const read = (files: Record<string, string>) => ({
    files: Object.keys(files),
    read: (p: string) => files[p] ?? null,
  });

  it("lists the placeholders to fill in, as words, and the web server for module pages", () => {
    const lines = beforeYouRun(
      read({
        "index.html": PAGE('<script type="module" src="weather-app.js"></script>'),
        "weather-app.js": WEATHER_JS,
        "api-config.js": CONFIG_JS,
      }),
    );
    expect(lines).toEqual([
      "add your own API key in api-config.js",
      "open it through a local web server (for example run `python -m http.server` in the folder), not by double-clicking the file",
    ]);
  });

  it("covers other placeholders, and a module script without type=module in the page", () => {
    const lines = beforeYouRun(
      read({
        "index.html": PAGE("<p>hi</p>"),
        "app.js": "export const x = 'YOUR_CITY_NAME_HERE';\nconst y = 'REPLACE_WITH_TOKEN';",
      }),
    );
    expect(lines).toContain("add your own city name in app.js");
    expect(lines).toContain("add your own token in app.js");
    expect(lines.at(-1)).toContain("local web server");
  });

  it("says nothing when there is nothing to say", () => {
    expect(
      beforeYouRun(read({ "index.html": PAGE('<script src="a.js"></script>'), "a.js": "let a = 1;" })),
    ).toEqual([]);
    // A module project that isn't for a browser needs no web server.
    expect(beforeYouRun(read({ "main.js": "export const a = 1;" }))).toEqual([]);
    expect(beforeYouRun(read({ "README.txt": "hello" }))).toEqual([]);
  });
});

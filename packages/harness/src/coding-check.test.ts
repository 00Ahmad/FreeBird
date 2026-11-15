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

  it("flags a script or stylesheet that is not there, and ignores web addresses, site paths and pictures", () => {
    const html = PAGE(
      [
        '<script src="missing.js"></script>',
        '<link rel="stylesheet" href="styles.css">',
        '<link rel="stylesheet" href="theme.css">',
        // A picture is the user's to add: the Developer can't draw one.
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
    expect(found[1]).toContain("<link> pointing at theme.css, but there is no such file");
  });

  it("says nothing of missing pictures, icons, fonts, sound or video, but still of pages, styles and JSON", () => {
    const media = PAGE(
      [
        '<img src="img/hero.jpg">',
        '<link rel="icon" href="favicon.ico">',
        '<link rel="shortcut icon" href="favicon.png">',
        '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
        '<link rel="manifest" href="site.webmanifest">',
        '<link rel="preload" href="fonts/inter.woff2" as="font">',
        '<video src="intro.mp4"></video>',
      ].join(""),
    );
    expect(problems({ "index.html": media })).toEqual([]);
    expect(problems({ "app.js": "import logo from './logo.svg';\nimport './styles.css';" })).toEqual([
      "app.js imports ./styles.css, but there is no such file.",
    ]);
    const written = PAGE(
      [
        '<link rel="stylesheet" href="a.css">',
        '<link rel="alternate" href="b.html">',
        '<link rel="preload" href="c.json">',
      ].join(""),
    );
    expect(problems({ "index.html": written })).toHaveLength(3);
  });

  it("ignores tags inside an HTML comment", () => {
    const html = PAGE(
      '<!-- <script src="old.js"></script> --><!--\n<link rel="stylesheet" href="gone.css">\n--><script src="app.js"></script>',
    );
    expect(problems({ "index.html": html, "app.js": "let a = 1;" })).toEqual([]);
    // Outside the comment it still counts.
    expect(
      problems({ "index.html": `${html}<script src="old.js"></script>`, "app.js": "let a = 1;" }),
    ).toHaveLength(1);
  });

  it("flags an inline script that uses import/export without type=module, and skips JSON and templates", () => {
    const inline = (tag: string) => problems({ "index.html": PAGE(tag), "a.js": "export const a = 1;" });
    expect(inline("<script>\nimport { a } from './a.js';\nconsole.log(a);\n</script>")).toEqual([
      'index.html has an inline <script> that uses import/export, which only works in a module script. Add type="module" to that <script> tag.',
    ]);
    expect(inline('<script type="text/javascript">import "./a.js";</script>')).toHaveLength(1);
    expect(inline('<script type="module">\nimport { a } from "./a.js";\n</script>')).toEqual([]);
    expect(inline("<script>\nconst m = await import('./a.js');\n</script>")).toEqual([]);
    expect(inline('<script type="importmap">{"imports": {"x": "./a.js"}}</script>')).toEqual([]);
    expect(inline('<script type="application/ld+json">{"export": 1}</script>')).toEqual([]);
    expect(inline('<script type="text/template">\nexport default x\n</script>')).toEqual([]);
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

describe("TypeScript projects", () => {
  it("doesn't read `import type` as a default import, and leaves type-only names to TypeScript", () => {
    const b = "export interface Foo { a: number }\nexport const bar = 1;";
    expect(problems({ "a.ts": "import type { Foo } from './b';", "b.ts": b })).toEqual([]);
    expect(problems({ "a.ts": "import type Foo from './b';", "b.ts": b })).toEqual([]);
    expect(problems({ "a.ts": "import { type Foo, bar } from './b';", "b.ts": b })).toEqual([]);
    // A value is still checked, and the file must still be there.
    expect(problems({ "a.ts": "import { type Foo, baz } from './b';", "b.ts": b })).toEqual([
      "a.ts imports baz from ./b, but b.ts doesn't export it.",
    ]);
    expect(problems({ "a.ts": "import type { Foo } from './nope';" })).toEqual([
      "a.ts imports ./nope, but there is no such file.",
    ]);
    // A default import that happens to be called `type` is a default import.
    expect(problems({ "a.ts": "import type, { bar } from './b';", "b.ts": b })[0]).toContain(
      "the default export",
    );
  });

  it("knows TypeScript's own kinds of export", () => {
    const b = [
      "export type Id = string;",
      "export interface User { id: Id }",
      "export enum Color { Red }",
      "export const enum Size { S }",
      "export declare const VERSION: string;",
      "export declare function helper(): void;",
      "export abstract class Shape {}",
      "export namespace Geometry { export const pi = 3; }",
      "export async function* stream() {}",
      "export function *gen() {}",
      "type Hidden = 1;",
      "export type { Hidden };",
      "const v = 1;",
      "export { type Hidden as Shown, v };",
    ].join("\n");
    const names = "Id, User, Color, Size, VERSION, helper, Shape, Geometry, stream, gen, Hidden, Shown, v";
    expect(problems({ "a.ts": `import { ${names} } from './b';`, "b.ts": b })).toEqual([]);
    expect(problems({ "a.ts": "import { Nope } from './b';", "b.ts": b })[0]).toContain("doesn't export it");
    // `export =` is CommonJS in TypeScript's clothes: nothing can be said.
    expect(problems({ "a.ts": "import { x } from './b';", "b.ts": "const o = {};\nexport = o;" })).toEqual(
      [],
    );
    expect(problems({ "a.ts": "export type { Gone } from './b';", "b.ts": b })).toEqual([]);
    expect(problems({ "a.ts": "export type { X } from './missing';" })).toHaveLength(1);
  });

  it("finds b.ts for an import of './b.js' (NodeNext), and the other TypeScript endings", () => {
    expect(
      problems({ "src/a.ts": "import { x } from './b.js';", "src/b.ts": "export const x = 1;" }),
    ).toEqual([]);
    expect(problems({ "a.tsx": "import { C } from './c.jsx';", "c.tsx": "export function C() {}" })).toEqual(
      [],
    );
    expect(problems({ "a.mts": "import { x } from './m.mjs';", "m.mts": "export const x = 1;" })).toEqual([]);
    expect(problems({ "a.ts": "import { y } from './b.js';", "b.ts": "export const x = 1;" })).toEqual([
      "a.ts imports y from ./b.js, but b.ts doesn't export it.",
    ]);
    expect(problems({ "a.ts": "import { x } from './gone.js';" })).toEqual([
      "a.ts imports ./gone.js, but there is no such file.",
    ]);
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

  it("still checks every id when a script only compares ids or sets a written one", () => {
    const found = problems({
      "index.html": page,
      "app.js": [
        "document.body.addEventListener('click', (e) => { if (e.target.id === 'go-btn') go(); });",
        'if (el.id == "weather") show();',
        "const made = document.createElement('p');",
        "made.id = 'made';",
        "made.setAttribute('id', 'also-made');",
        "document.getElementById('made');",
        "document.getElementById('also-made');",
        "document.getElementById('missing');",
      ].join("\n"),
    });
    expect(found).toEqual([
      'app.js looks for the element with id "missing", but no page in the project has id="missing".',
    ]);
    // An id built at run time still means nothing can be said.
    for (const maker of ["el.id = `card-${n}`;", "el.setAttribute('id', name);", "<div id={name} />"])
      expect(
        problems({ "index.html": page, "app.js": `${maker}\ndocument.getElementById('missing');` }),
      ).toEqual([]);
  });
});

describe("JSON files", () => {
  it("flags one that doesn't parse", () => {
    expect(problems({ "data.json": '{"a": 1,}' })[0]).toMatch(/^data\.json is not valid JSON/);
    expect(problems({ "data.json": '{"a": [1, 2]}' })).toEqual([]);
    expect(problems({ "package.json": '{\n  // a comment\n  "name": "x"\n}' })[0]).toContain(
      "not valid JSON",
    );
  });

  it("allows comments and trailing commas where tools do (tsconfig, editor settings, .jsonc)", () => {
    const jsonc = `{
  // TypeScript allows this
  "compilerOptions": {
    "paths": { "@/*": ["./src/*"] }, /* a block comment */
    "note": "a // and a /* in a string are text",
    "strict": true,
  },
  "include": ["src/**/*.ts",],
}`;
    for (const name of [
      "tsconfig.json",
      "tsconfig.app.json",
      "jsconfig.json",
      ".vscode/settings.json",
      "app.jsonc",
    ])
      expect(problems({ [name]: jsonc }), name).toEqual([]);
    // Still JSON underneath: what is really broken is still flagged.
    expect(problems({ "tsconfig.json": '{ "a": 1 "b": 2 }' })[0]).toContain(
      "tsconfig.json is not valid JSON",
    );
    expect(problems({ "tsconfig.json": '{ "a": "/* not closed" ' })[0]).toContain("not valid JSON");
    expect(problems({ "data.json": jsonc })[0]).toContain("not valid JSON");
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

  const KEY = "3f2a9c4e8b7d41a0b6c5d2e9f8a7b6c5";
  const flagged = (name: string, text: string) => expect(problems({ [name]: text }), text).toHaveLength(1);
  const clean = (name: string, text: string) => expect(problems({ [name]: text }), text).toEqual([]);

  it("knows a key's name with words before it, in any style", () => {
    for (const name of [
      "OPENWEATHER_API_KEY",
      "WEATHER_KEY",
      "appKey",
      "client_secret",
      "ACCESS_KEY",
      "authToken",
      "db-password",
      "STRIPE_SECRET",
      "privateKey",
    ])
      flagged("a.js", `const ${name.replaceAll("-", "_")} = "${KEY}";`);
    flagged("a.json", `{"auth token": "${KEY}"}`);
    flagged("a.ts", `class Api { private readonly apiKey: string = "${KEY}"; }`);
    flagged("a.go", `apiKey := "${KEY}"`);
    flagged("a.php", `$config = ['api_key' => '${KEY}'];`);
    flagged("a.ps1", `$env:API_KEY = "${KEY}"`);
    flagged("a.js", `const apiKey = \`${KEY}\`;`);
  });

  it("knows a key with dashes, underscores, slashes, plus signs, equals signs or dots in it", () => {
    for (const value of [
      "a1B2-c3D4_e5F6-g7H8_i9J0",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzz1kA2",
      "abc123+def456/ghi789==",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlMTIz",
    ])
      flagged("a.js", `const secret = "${value}";`);
  });

  it("reads unquoted values in .env, .ini, .properties, YAML and TOML files", () => {
    flagged(".env", `OPENWEATHER_API_KEY=${KEY}\n`);
    flagged(".env.example", `export WEATHER_KEY=${KEY}`);
    flagged("config.yaml", `weather:\n  api_key: ${KEY} # from the dashboard\n`);
    flagged("app.properties", `api.key=${KEY}`);
    flagged("settings.ini", `[api]\nsecret = ${KEY}`);
    flagged("app.toml", `[api]\ntoken = "${KEY}"`);
    clean(".env.example", "OPENWEATHER_API_KEY=your_api_key_here\nPORT=3000\nDEBUG=true\n");
    clean("config.yml", "api_key: ${WEATHER_KEY}\nname: weather-app\n");
    // An unquoted value in code is a variable, not a key.
    clean("a.js", `const apiKey = process.env.OPENWEATHER_API_KEY_${"X".repeat(3)};`);
  });

  it("knows keys by their start wherever they are", () => {
    // Made-up keys, built from pieces so no key-like string sits in the source (push protection matches patterns).
    const keys = [
      "sk-abc123def456ghi789jkl012mno345",
      "sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1w",
      ["sk_live", "_51HxYzAbC123dEf456GhI789"].join(""),
      ["pk_live", "_51HxYzAbC123dEf456GhI789"].join(""),
      ["ghp", "_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"].join(""),
      ["gho", "_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"].join(""),
      ["github", "_pat_11ABCDEFG0aB3dE6gH9jK2mN5pQ8sT1vW4yZ7"].join(""),
      ["xoxb", "-123456789012-1234567890123-aB3dE6gH9jK2"].join(""),
      ["AKIA", "IOSFODNN7ABCDEFG"].join(""),
      ["AIza", "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"].join(""),
    ];
    for (const key of keys) {
      flagged("notes.md", `Use ${key} to call it.`);
      flagged("main.py", `client = Client("${key}")`);
    }
    // Not inside a longer word, and not a word that merely starts the same way.
    clean("a.css", ".task-list-item-container-wrapper { color: red }\n.mask-image-gradient-overlay-left {}");
    clean("a.js", "const cls = 'sk-fading-circle-loader-animation';");
  });

  it("finds a key in a web address, but not one filled in at run time", () => {
    flagged("a.js", `fetch("https://api.openweathermap.org/data/2.5/weather?q=London&appid=${KEY}");`);
    flagged("a.py", `URL = f"https://maps.example.com/api?key=AbCdEf123456GhIjKl789"`);
    flagged("README.md", `curl "https://api.example.com/v1?api_key=${KEY}"`);
    clean("a.js", "fetch(`https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${API_KEY}`);");
    clean("a.js", "fetch('https://api.openweathermap.org/data/2.5/weather?q=' + city + '&appid=' + key);");
    clean("a.js", 'fetch("https://api.openweathermap.org/data/2.5/weather?q=London&appid=YOUR_API_KEY");');
  });

  it("checks every text file of the plan, not just scripts", () => {
    for (const name of [
      "a.rb",
      "a.cs",
      "A.java",
      "a.sh",
      "a.ps1",
      "a.go",
      "a.php",
      "a.yaml",
      "a.toml",
      "a.txt",
    ])
      flagged(name, `api_key = "${KEY}"`);
    // Not pictures or fonts.
    clean("logo.png", `api_key = "${KEY}"`);
  });

  it("keeps clearly marked placeholders unflagged, but not a key that merely has 'your' inside", () => {
    for (const value of [
      "YOUR_OPENWEATHER_API_KEY",
      "your-api-key-goes-here-123",
      "yourApiKeyHere1234567",
      "<your-api-key>",
      "xxxxxxxxxxxxxxxxxxxxxxxx",
      "XXXX-XXXX-XXXX-XXXX-1234",
      "sk-...",
      "changeme1234567890abc",
      "placeholder_key_1234567",
      "replace_me_with_a_real_one_1",
      "example-key-1234567890",
      "dummy_token_1234567890",
      "not-a-real-key-1234567890",
      "0000000000000000000000",
    ])
      clean("a.js", `const apiKey = "${value}";`);
    flagged("a.js", `const apiKey = "a8Fk2yourZ9qL3mX7pR1tW5vB";`);
    flagged("a.js", `const apiKey = "Q7w8E9r0yourT1y2U3i4O5p6";`);
  });

  it("leaves common things that aren't keys alone", () => {
    clean("a.js", "// fixed in 3f2a9c4e8b7d41a0b6c5d2e9f8a7b6c5d2e9f8a7 (git commit)\nlet a = 1;");
    clean("a.css", "body { color: #3f2a9c; background: #a0b6c5d2; }");
    clean(
      "a.html",
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==">',
    );
    clean("a.js", `const config = { id: "550e8400-e29b-41d4-a716-446655440000", sessionId: "${KEY}" };`);
    clean(
      "a.js",
      `const STORAGE_KEY = "weather-app-favorite-cities-v2";\nconst cacheKey = "forecast_cache_2024";`,
    );
    // Words joined up are a name even under a key's name, with separators or in camelCase.
    clean("a.js", `const FAVORITES_KEY = "weatherAppFavoriteCities2024";`);
    clean(
      "a.js",
      `const SETTINGS_KEY = "weatherDashboardSettings";\nconst themeKey = "darkMode-preferredTheme";`,
    );
    clean("a.js", `const settingsKey = "weather-app-settings-v2";\nconst token = "user_profile_page_2024";`);
    clean(
      "a.js",
      `const authDomain = "myapp-12345.firebaseapp.com";\nconst tokenUrl = "https://example.com/oauth2/token";`,
    );
  });

  it("doesn't take a hash, checksum, sha or uuid for a key", () => {
    for (const line of [
      `const hash = "${KEY}";`,
      `const fileHash = "${KEY}";`,
      `{"checksum": "${KEY}"}`,
      `const sha = "${KEY}d2e9f8a7";`,
      `const commitSha256 = "${KEY}${KEY}";`,
      `const uuid = "550e8400-e29b-41d4-a716-446655440000";`,
      `const apiKeyId = "${KEY}";`,
      `const fileHashKey = "${KEY}";`,
      `const SHA_KEY = "${KEY}";`,
      `const uuidKey = "550e8400-e29b-41d4-a716-446655440000";`,
      `const idempotencyKey = "550e8400-e29b-41d4-a716-446655440000";`,
      `const integrity = "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC";`,
    ])
      clean(line.startsWith("{") ? "a.json" : "a.js", line);
    // A uuid given to a key's name is still a key.
    flagged("a.js", `const apiKey = "550e8400-e29b-41d4-a716-446655440000";`);
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

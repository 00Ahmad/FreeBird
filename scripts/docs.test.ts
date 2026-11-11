// The documentation can't drift from the app unnoticed: links resolve, versions agree, and what the docs list
// (providers, built-in tools, settings pages) is what the app has.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SETTINGS_PAGES } from "../apps/ui/src/components/settings/pages";
import { PROVIDER_PRESETS } from "../packages/shared/src/providers";
import { BUILTIN_TOOLS } from "../packages/tools/src/builtins";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8");

const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const markdownFiles = [
  ...readdirSync(root).filter((name) => name.endsWith(".md")),
  ...walk("docs").filter((name) => name.endsWith(".md")),
].map((name) => name.replaceAll("\\", "/"));

/** Text outside code blocks: links and headings in examples don't count. */
const prose = (text: string) => text.replace(/```[\s\S]*?```/g, "");

/** How GitHub names a heading's anchor. */
const anchorOf = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/`|\*|_/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

const anchorsIn = (file: string) =>
  [...prose(read(file)).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => anchorOf(match[1]!));

describe("documentation", () => {
  it("finds the markdown files", () => {
    expect(markdownFiles).toEqual(expect.arrayContaining(["README.md", "docs/features.md", "CHANGELOG.md"]));
  });

  it("links only to files and headings that exist", () => {
    const broken: string[] = [];
    for (const file of markdownFiles) {
      for (const match of prose(read(file)).matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = match[1]!;
        if (/^(https?:|mailto:)/.test(link)) continue;
        const [path, anchor] = link.split("#");
        const target = path ? normalize(join(dirname(file), path)).replaceAll("\\", "/") : file;
        if (!existsSync(join(root, target))) {
          broken.push(`${file} → ${link} (no such file)`);
        } else if (anchor && target.endsWith(".md") && !anchorsIn(target).includes(anchor)) {
          broken.push(`${file} → ${link} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("keeps personal paths and addresses out of the files a public repo shows", () => {
    const personal =
      /OneDrive|@(gmail|outlook|hotmail|yahoo|icloud)\.com|C:\\Users\\(?!a\\|me\\)|\/Users\/[a-z]+\/Desktop/i;
    const found = [...markdownFiles, "package.json"].filter((file) => personal.test(read(file)));
    expect(found).toEqual([]);
  });

  it("names every provider the app offers", () => {
    const docs = read("docs/models-and-providers.md").toLowerCase();
    const missing = PROVIDER_PRESETS.map((preset) => preset.label).filter(
      (label) => !docs.includes(label.toLowerCase()),
    );
    expect(missing).toEqual([]);
  });

  it("lists every built-in tool", () => {
    const docs = read("docs/features.md");
    const missing = BUILTIN_TOOLS.map((tool) => tool.name).filter((name) => !docs.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  it("describes every settings page", () => {
    const docs = read("docs/features.md");
    const missing = SETTINGS_PAGES.map((page) => page.label).filter(
      (label) => !docs.includes(`**${label}**`),
    );
    expect(missing).toEqual([]);
  });
});

describe("versions", () => {
  const manifests = [
    "package.json",
    ...["apps", "packages"].flatMap((dir) =>
      readdirSync(join(root, dir)).map((name) => join(dir, name, "package.json")),
    ),
  ]
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => existsSync(join(root, file)));
  const version = (JSON.parse(read("package.json")) as { version: string }).version;

  it("is the same in every package and in the app itself", () => {
    const differing = manifests.filter(
      (file) => (JSON.parse(read(file)) as { version: string }).version !== version,
    );
    expect(differing).toEqual([]);
    expect(/APP_VERSION = "([^"]+)"/.exec(read("packages/shared/src/api.ts"))?.[1]).toBe(version);
  });

  it("has a changelog entry", () => {
    expect(read("CHANGELOG.md")).toMatch(new RegExp(`^## ${version.replaceAll(".", "\\.")}( |$)`, "m"));
  });
});

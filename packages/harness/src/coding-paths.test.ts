import { describe, expect, it } from "vitest";

import { nameProblem, protectedPathReason, secretFileReason } from "./coding-paths";

describe("paths a Coding Bot's roles must not write", () => {
  it("refuses tool folders and files that run commands", () => {
    for (const path of [
      ".git/config",
      ".git/hooks/pre-commit",
      ".GIT\\HOOKS\\post-checkout",
      "node_modules/.bin/node",
      "sub/node_modules/x.js",
      ".vscode/tasks.json",
      ".VSCode/Launch.json",
      ".husky/pre-push",
      ".npmrc",
      ".gitattributes",
      "./.git/info/exclude",
      ".",
      "",
    ])
      expect(protectedPathReason(path), path).not.toBeNull();
  });

  it("lets the project's own files through", () => {
    for (const path of [
      "index.html",
      "src/app.ts",
      "css/styles.css",
      ".gitignore",
      ".env.example",
      "docs/hooks.md",
      "src/hooks/useThing.ts",
      ".vscode/notes.md",
      "README.md",
    ])
      expect(protectedPathReason(path), path).toBeNull();
  });
});

describe("names Windows can't keep as they are", () => {
  it("refuses device names in any case and with any extension, and a dot or space at the end", () => {
    for (const name of [
      "CON",
      "con",
      "Nul.txt",
      "aux.tar.gz",
      "COM1",
      "lpt9.log",
      "CON .txt",
      "conin$",
      "COM¹",
    ])
      expect(nameProblem(name), name).toContain("keeps for a device");
    for (const name of ["app.", "app ", "...", "v1. "])
      expect(nameProblem(name), name).toContain("ends in a dot or a space");
    for (const name of ["console", "icon.png", "com10", "com0", "lpt", ".gitignore", "my.app", " lead"])
      expect(nameProblem(name), name).toBeNull();
  });
});

describe("files a Coding Bot's roles must not read", () => {
  it("refuses files that may hold real secrets", () => {
    for (const path of [
      ".env",
      ".env.local",
      "config/.env.production",
      "server.key",
      "cert.pem",
      "id_rsa",
      ".npmrc",
    ])
      expect(secretFileReason(path), path).not.toBeNull();
  });

  it("lets examples and ordinary files through", () => {
    for (const path of [
      ".env.example",
      ".env.sample",
      "env.ts",
      "keys.md",
      "src/api-config.js",
      "package.json",
    ])
      expect(secretFileReason(path), path).toBeNull();
  });
});

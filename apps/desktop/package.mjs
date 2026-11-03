// Builds the Windows installer: release/FreeBird-Setup-<version>.exe.
// The app is staged in a plain folder with an npm install of its runtime dependencies, because pnpm's linked
// node_modules don't pack reliably.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const stage = join(here, "out", "stage");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const electronVersion = pkg.devDependencies.electron;
const run = (command, cwd = here) => execSync(command, { cwd, stdio: "inherit" });

run("pnpm --filter @mrog/ui build", join(here, "../.."));
run("node build.mjs");

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });
for (const file of ["main.cjs", "preload.cjs", "harness.mjs"])
  cpSync(join(here, "dist", file), join(stage, "dist", file));
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "freebird",
      productName: pkg.productName,
      version: pkg.version,
      description: "Local AI bots on your own computer",
      author: "FreeBird",
      main: pkg.main,
      dependencies: pkg.dependencies,
    },
    null,
    2,
  ),
);
run("npm install --omit=dev --no-audit --no-fund", stage);

const config = {
  appId: "com.freebird.app",
  productName: pkg.productName,
  electronVersion,
  directories: { app: stage, output: join(here, "release") },
  files: ["dist/**", "package.json", "node_modules/**"],
  // The browser driver reads and starts files from its own folder, so it lives outside the archive.
  asarUnpack: ["node_modules/playwright-core/**", "node_modules/@napi-rs/**"],
  extraResources: [{ from: join(here, "../ui/dist"), to: "ui" }],
  win: { target: [{ target: "nsis", arch: ["x64"] }], icon: join(here, "build", "icon.ico") },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: pkg.productName,
    artifactName: "${productName}-Setup-${version}.${ext}",
  },
};
const configPath = join(here, "out", "builder.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));
run(`pnpm exec electron-builder --win --config "${configPath}" --publish never`);

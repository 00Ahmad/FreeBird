// Bundles the Electron main + preload, and the harness the packaged app runs as a utility process.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node22", sourcemap: true, logLevel: "info" };

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/main.ts"],
    outfile: "dist/main.cjs",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/preload.ts"],
    outfile: "dist/preload.cjs",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["../../packages/harness/src/main.ts"],
    outfile: "dist/harness.mjs",
    format: "esm",
    // Loaded from node_modules at runtime, never bundled: a native addon, and the browser driver (which finds
    // its own files on disk).
    external: ["@napi-rs/keyring", "playwright-core"],
    // Some bundled CommonJS deps call require(); give the ESM bundle one.
    banner: {
      js: "import { createRequire as __mrogCreateRequire } from 'node:module'; const require = __mrogCreateRequire(import.meta.url);",
    },
  }),
]);

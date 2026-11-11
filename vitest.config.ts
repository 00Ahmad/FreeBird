import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/*.test.ts"],
    environment: "node",
    // Some tests start PowerShell or a real browser, which is slow on a busy machine.
    testTimeout: 20_000,
  },
});

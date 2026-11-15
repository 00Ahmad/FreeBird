import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config";

const before = process.env.MROG_TOKEN;
afterEach(() => {
  if (before === undefined) delete process.env.MROG_TOKEN;
  else process.env.MROG_TOKEN = before;
});

describe("the access token", () => {
  it("is read from the environment and then removed from it, so nothing the app starts inherits it", () => {
    process.env.MROG_TOKEN = "t".repeat(64);
    const config = loadConfig(process.env);
    expect(config.token).toBe("t".repeat(64));
    expect(process.env.MROG_TOKEN).toBeUndefined();
    expect("MROG_TOKEN" in process.env).toBe(false);
  });

  it("is removed from a given environment too, and from the process's own", () => {
    process.env.MROG_TOKEN = "left-over";
    const env: NodeJS.ProcessEnv = { MROG_TOKEN: "x".repeat(64) };
    expect(loadConfig(env).token).toBe("x".repeat(64));
    expect(env.MROG_TOKEN).toBeUndefined();
    expect(process.env.MROG_TOKEN).toBeUndefined();
  });
});

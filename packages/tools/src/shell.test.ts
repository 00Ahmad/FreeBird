import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { commandEnv, runShell } from "./shell";

const SET = {
  MROG_TOKEN: "app-token-must-not-leak",
  MROG_DATA_DIR: "C:\\secret\\data",
  mrog_preferred_port: "51234",
  VITE_MROG_TOKEN: "ui-token-must-not-leak",
  NODE_OPTIONS: "--require ./evil.js",
  ELECTRON_RUN_AS_NODE: "1",
};
const before = new Map(Object.keys(SET).map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const [name, value] of before)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

describe("what a command can see", () => {
  it("leaves out the app's token and settings and node's code-loading variables, keeps the rest", () => {
    Object.assign(process.env, SET);
    const env = commandEnv({ GH_TOKEN: "granted" });
    for (const name of Object.keys(SET))
      expect(Object.keys(env).map((key) => key.toUpperCase())).not.toContain(name.toUpperCase());
    // What PowerShell and the user's tools need is still there, and the secrets it was given are on top.
    expect(Object.keys(env).some((key) => key.toUpperCase() === "PATH")).toBe(true);
    expect(env.GH_TOKEN).toBe("granted");
  });

  it("a command run through runShell can't read the token, even though the app's process has it", async () => {
    Object.assign(process.env, SET);
    const windows = process.platform === "win32";
    const result = await runShell(
      windows
        ? 'Write-Output "token=[$env:MROG_TOKEN] data=[$env:MROG_DATA_DIR] opts=[$env:NODE_OPTIONS] given=[$env:GIVEN]"'
        : 'echo "token=[$MROG_TOKEN] data=[$MROG_DATA_DIR] opts=[$NODE_OPTIONS] given=[$GIVEN]"',
      {
        cwd: tmpdir(),
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        env: { GIVEN: "yes" },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("token=[] data=[] opts=[] given=[yes]");
    expect(result.output).not.toContain("must-not-leak");
  });
});

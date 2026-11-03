import { EventEmitter } from "node:events";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OllamaLauncher, ollamaCommands } from "./ollama";

interface Spawned {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A spawn that records calls; `fails` names commands that don't exist (ENOENT). */
function fakeSpawn(spawned: Spawned[], onSpawn: () => void, fails: string[] = []) {
  return ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    spawned.push({ command, args, env: options.env });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    if (fails.includes(command)) queueMicrotask(() => child.emit("error", new Error("ENOENT")));
    else onSpawn();
    return child;
  }) as never;
}

describe("Ollama launcher", () => {
  it("prefers the Windows tray app, then ollama.exe, then PATH", () => {
    const dir = join("C:\\Users\\a\\AppData\\Local", "Programs", "Ollama");
    const commands = ollamaCommands("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, () => true);
    expect(commands).toEqual([
      { command: join(dir, "ollama app.exe"), args: [] },
      { command: join(dir, "ollama.exe"), args: ["serve"] },
      { command: "ollama", args: ["serve"] },
    ]);
    expect(ollamaCommands("linux", {}, () => false)).toEqual([{ command: "ollama", args: ["serve"] }]);
  });

  it("does nothing when Ollama already answers", async () => {
    const spawned: Spawned[] = [];
    const launcher = new OllamaLauncher({
      url: () => "http://127.0.0.1:11434",
      reachable: async () => true,
      spawn: fakeSpawn(spawned, () => {}),
    });
    expect(await launcher.start()).toBe("running");
    expect(spawned).toEqual([]);
  });

  it("starts it once on the configured port, even when asked twice", async () => {
    let up = false;
    let started = 0;
    const spawned: Spawned[] = [];
    const launcher = new OllamaLauncher({
      url: () => "http://localhost:11500",
      reachable: async () => up,
      onStarted: () => (started += 1),
      platform: "linux",
      env: {},
      spawn: fakeSpawn(spawned, () => (up = true), []),
    });
    const [a, b] = await Promise.all([launcher.start(), launcher.start()]);
    expect([a, b]).toEqual(["started", "started"]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      command: "ollama",
      args: ["serve"],
      env: { OLLAMA_HOST: "localhost:11500" },
    });
    expect(started).toBe(1);
  });

  it("explains when Ollama isn't installed or runs elsewhere", async () => {
    const spawned: Spawned[] = [];
    const missing = new OllamaLauncher({
      url: () => "http://127.0.0.1:11434",
      reachable: async () => false,
      platform: "linux",
      env: {},
      spawn: fakeSpawn(spawned, () => {}, ["ollama"]),
    });
    await expect(missing.start()).rejects.toMatchObject({ code: "ollama_not_found" });

    const remote = new OllamaLauncher({
      url: () => "http://192.168.1.20:11434",
      reachable: async () => false,
      spawn: fakeSpawn(spawned, () => {}),
    });
    await expect(remote.start()).rejects.toMatchObject({ code: "ollama_remote" });
    expect(spawned.map((s) => s.command)).toEqual(["ollama"]);
  });

  it("lets callers wait for a start that is under way", async () => {
    let up = false;
    const order: string[] = [];
    const launcher = new OllamaLauncher({
      url: () => "http://127.0.0.1:11434",
      reachable: async () => up,
      platform: "linux",
      env: {},
      spawn: fakeSpawn([], () => setTimeout(() => (up = true), 600)),
    });
    await launcher.settled();
    const starting = launcher.start().then(() => order.push("started"));
    await launcher.settled().then(() => order.push("settled"));
    await starting;
    expect(order).toEqual(["started", "settled"]);
  });
});

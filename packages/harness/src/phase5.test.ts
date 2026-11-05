import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message, type MessagePart } from "@mrog/shared";

import { ComputerManager, type DockerRunner } from "./computer";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const call = (name: string, args: Record<string, unknown>) => ({
  message: { tool_calls: [{ function: { name, arguments: args } }] },
});

async function withBot(replies: unknown[][] = []) {
  const requests: any[] = [];
  h = await makeHarness({
    handlers: {
      ...fakeOllama((body) => {
        requests.push(body);
        return ndjson([...(replies.shift() ?? [{ message: { content: "ok" } }]), { done: true }]);
      }),
      "stt.example/v1/audio/transcriptions": async () => Response.json({ text: " hello world " }),
    },
  });
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const bot = (
    await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
  ).json().bot as Bot;
  return { bot, requests };
}

describe("vault", () => {
  it("stores logins, cards and contacts with secrets only in the keychain", async () => {
    await withBot();
    const login = await h!.app.inject({
      method: "POST",
      url: "/api/vault",
      headers: auth,
      payload: { kind: "login", website: "https://github.com", username: "ada", password: "hunter2" },
    });
    expect(login.statusCode).toBe(201);
    await h!.app.inject({
      method: "POST",
      url: "/api/vault",
      headers: auth,
      payload: { kind: "card", name: "Ada L", number: "4242 4242 4242 4242", expiry: "12/29", cvc: "123" },
    });
    const list = await h!.app.inject({ url: "/api/vault", headers: auth });
    expect(list.json().items).toMatchObject([
      { kind: "login", website: "https://github.com", username: "ada" },
      { kind: "card", label: "Ada L", last4: "4242" },
    ]);
    expect(list.body).not.toContain("hunter2");
    expect(list.body).not.toContain("4242 4242");
  });

  it("imports a password-manager CSV, skipping duplicates, non-https sites and rows without passwords", async () => {
    await withBot();
    const csv =
      'name,url,username,password\nGH,https://github.com,ada,"pa,ss"\nGH again,https://github.com,ada,x\nOld,http://old.example,ada,x\nNoPass,https://x.example,ada,\n';
    const res = await h!.app.inject({
      method: "POST",
      url: "/api/vault/import",
      headers: auth,
      payload: { csv },
    });
    expect(res.json()).toEqual({ imported: 1, skipped: 3 });
    const bad = await h!.app.inject({
      method: "POST",
      url: "/api/vault/import",
      headers: auth,
      payload: { csv: "a,b\n1,2" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("asks for a secret through a secure card; the bot only ever sees its name", async () => {
    const { bot, requests } = await withBot([
      [call("request_secret", { name: "GITHUB_TOKEN", reason: "To open pull requests" })],
      [{ message: { content: "Thanks, saved." } }],
    ]);
    const card = nextEvent<Extract<MessagePart, { type: "secret" }>>(h!.bus, (e) => {
      if (e.type !== "message.updated") return undefined;
      const part = e.message.parts.find((p: MessagePart) => p.type === "secret");
      return part?.type === "secret" && !part.saved && part;
    });
    const done = nextEvent<Message>(
      h!.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && e.message,
    );
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "connect github" },
    });
    const part = await card;
    expect(part).toMatchObject({ name: "GITHUB_TOKEN", reason: "To open pull requests" });
    const saved = await h!.app.inject({
      method: "POST",
      url: `/api/secret-requests/${part.requestId}`,
      headers: auth,
      payload: { name: "GITHUB_TOKEN", value: "ghp_supersecret" },
    });
    expect(saved.statusCode).toBe(204);
    const reply = await done;

    expect(reply.parts.find((p) => p.type === "secret")).toMatchObject({ saved: true });
    expect(JSON.stringify(reply)).not.toContain("ghp_supersecret");
    expect(JSON.stringify(requests)).not.toContain("ghp_supersecret");
    expect(h!.services.vaultService.envFor(bot)).toEqual({ GITHUB_TOKEN: "ghp_supersecret" });
  });

  it("grants a saved login to commands as environment variables after approval", async () => {
    const { bot } = await withBot([
      [call("use_login", { website: "github.com" })],
      [{ message: { content: "Ready." } }],
    ]);
    h!.services.vaultService.add({
      kind: "login",
      website: "https://github.com",
      username: "ada",
      password: "hunter2",
    });
    const card = nextEvent<string>(h!.bus, (e) => {
      if (e.type !== "message.updated") return undefined;
      const part = e.message.parts.find((p: MessagePart) => p.type === "tool");
      return part?.type === "tool" && part.approval?.id;
    });
    const done = nextEvent<Message>(
      h!.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && e.message,
    );
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "log in" },
    });
    await h!.app.inject({
      method: "POST",
      url: `/api/approvals/${await card}`,
      headers: auth,
      payload: { decision: "allow_once" },
    });
    const reply = await done;
    expect(reply.parts.find((p) => p.type === "tool")).toMatchObject({
      result: expect.stringContaining("GITHUB_COM_PASSWORD"),
    });
    expect(h!.services.vaultService.envFor(bot)).toEqual({
      GITHUB_COM_USERNAME: "ada",
      GITHUB_COM_PASSWORD: "hunter2",
    });
  });
});

describe("computer", () => {
  function fakeDocker(state: { running: boolean; available: boolean; names?: string[] }) {
    const calls: string[][] = [];
    const docker = {
      calls,
      /** How long `docker exec` takes (it gives up early when its signal aborts, like the real client). */
      delay: 0,
      exec: async () => ({ stdout: "Linux\n", stderr: "", code: 0 }),
      runner: (async (args, _timeoutMs, signal) => {
        calls.push(args);
        const [command] = args;
        if (!state.available)
          return { stdout: "", stderr: "error during connect: docker isn't running", code: 1 };
        if (command === "version") return { stdout: "29.6.2\n", stderr: "", code: 0 };
        if (command === "ps") return { stdout: (state.names ?? []).join("\n"), stderr: "", code: 0 };
        if (command === "inspect")
          return state.running
            ? { stdout: "running\n", stderr: "", code: 0 }
            : { stdout: "", stderr: "No such object", code: 1 };
        if (command === "run") {
          state.running = true;
          return { stdout: "abc123\n", stderr: "", code: 0 };
        }
        if (command === "port") return { stdout: "127.0.0.1:49200\n", stderr: "", code: 0 };
        if (command === "exec") {
          if (docker.delay > 0 && args[1] === "-e") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, docker.delay);
              signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
          return signal?.aborted ? { stdout: "", stderr: "aborted", code: 1 } : docker.exec();
        }
        return { stdout: "", stderr: "", code: 0 };
      }) as DockerRunner,
    };
    return docker;
  }

  it("reports when Docker isn't running", async () => {
    await withBot();
    const manager = new ComputerManager(h!.services, fakeDocker({ running: false, available: false }).runner);
    expect((await manager.status()).docker).toMatchObject({
      available: false,
      error: expect.stringContaining("isn't running"),
    });
  });

  it("announces a removed computer only when there was one", async () => {
    const { bot } = await withBot();
    const seen: string[] = [];
    const off = h!.bus.subscribe((event) => {
      if (event.type === "data.changed") seen.push(event.keys.join());
    });
    await new ComputerManager(h!.services, fakeDocker({ running: false, available: false }).runner).remove(
      bot.id,
    );
    expect(seen).toEqual([]);

    const live = new ComputerManager(h!.services, fakeDocker({ running: false, available: true }).runner);
    await live.start(bot.id);
    seen.length = 0;
    await live.remove(bot.id);
    off();
    expect(seen).toEqual(["computer"]);
  });

  it("starts a desktop bound to this computer only, then offers the bot a command tool", async () => {
    const { bot } = await withBot();
    const docker = fakeDocker({ running: false, available: true });
    const manager = new ComputerManager(h!.services, docker.runner);
    expect(manager.tools(bot)).toEqual([]);
    const computer = await manager.start(bot.id);
    expect(computer).toEqual({ state: "running", url: "http://127.0.0.1:49200", error: null });
    const run = docker.calls.find((args) => args[0] === "run")!;
    expect(run).toEqual(expect.arrayContaining(["-p", "127.0.0.1::3000", `mrog-${bot.id}`]));
    const [tool] = manager.tools(bot);
    expect(tool?.name).toBe("computer_run");
    const output = await tool!.run({ command: "uname", timeout_seconds: 5 }, {} as never);
    expect(output).toBe("Linux\n\nExit code: 0");
  });

  it("keeps the host's names off this computer and asks before commands that reach the local network", async () => {
    const { bot } = await withBot();
    const docker = fakeDocker({ running: false, available: true });
    const manager = new ComputerManager(h!.services, docker.runner);
    await manager.start(bot.id);
    expect(docker.calls.find((args) => args[0] === "run")).toEqual(
      expect.arrayContaining(["--add-host", "host.docker.internal:127.0.0.1"]),
    );
    const [tool] = manager.tools(bot);
    const risk = (command: string) => tool!.risk({ command, timeout_seconds: 5 }, {} as never);
    for (const command of [
      "curl http://192.168.1.1/admin",
      "curl -s http://host.docker.internal:11434/api/tags",
      "ping nas.lan",
      "wget http://nas:5000/",
    ]) {
      expect(await risk(command), command).toMatchObject({
        level: "ask",
        badges: ["Reaches your local network"],
      });
    }
    for (const command of ["uname -a", "curl http://localhost:3000/", "curl https://example.com/"]) {
      expect(await risk(command), command).toMatchObject({ level: "safe" });
    }
  });

  it("limits a new computer's processes, memory and privileges, and never gives it the host's network or devices", async () => {
    const { bot } = await withBot();
    const docker = fakeDocker({ running: false, available: true });
    await new ComputerManager(h!.services, docker.runner).start(bot.id);
    const run = docker.calls.find((args) => args[0] === "run")!;
    expect(run).toEqual(
      expect.arrayContaining(["--pids-limit=4096", "--memory=8g", "--cap-drop=NET_RAW", "--cap-drop=MKNOD"]),
    );
    // The image needs root for its init and sudo for the bot: these would break it, and must not creep in.
    expect(run).not.toContain("--cap-drop=ALL");
    expect(run).not.toContain("--privileged");
    expect(run.join(" ")).not.toMatch(/--network[= ]host|--pid[= ]host|--net[= ]host|no-new-privileges/);
    // Flags go before the image name, or docker would pass them to the container's command.
    expect(run.indexOf("--pids-limit=4096")).toBeLessThan(
      run.indexOf(`lscr.io/linuxserver/webtop:ubuntu-xfce`),
    );
  });

  it("finds computers still running from before a restart", async () => {
    const { bot } = await withBot();
    const docker = fakeDocker({ running: true, available: true, names: [`mrog-${bot.id}`] });
    const manager = new ComputerManager(h!.services, docker.runner);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.tools(bot).map((tool) => tool.name)).toEqual(["computer_run"]);
  });

  it("ends a command in the container on its time limit or on Stop, and says it timed out", async () => {
    const { bot } = await withBot();
    const docker = fakeDocker({ running: true, available: true });
    const manager = new ComputerManager(h!.services, docker.runner);
    await manager.get(bot.id);
    const [tool] = manager.tools(bot);
    const context = (signal: AbortSignal) => ({ signal }) as never;

    docker.exec = async () => ({ stdout: "partial\n", stderr: "", code: 137 });
    const started = Date.now();
    docker.delay = 1000;
    const timedOut = await tool!.run(
      { command: "sleep 100", timeout_seconds: 1 },
      context(new AbortController().signal),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(timedOut).toBe("partial\n\nTimed out after 1s and was stopped.");
    const exec = docker.calls.findLast((args) => args[0] === "exec")!;
    expect(exec).toEqual(expect.arrayContaining(["sh", "-c", "1", "sleep 100"]));
    expect(exec.join(" ")).toContain("timeout -s KILL");

    // Stop: the client gives up at once and the command's processes in the container are killed.
    docker.delay = 60_000;
    const stop = new AbortController();
    const running = tool!.run({ command: "sleep 100", timeout_seconds: 600 }, context(stop.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    await expect(running).rejects.toThrow();
    const tag = docker.calls.findLast((args) => args[0] === "exec" && args[1] === "-e")![2]!;
    expect(docker.calls.at(-1)!.join(" ")).toContain(tag);
    expect(docker.calls.at(-1)!.join(" ")).toContain("kill -KILL");
  });
});

describe("voice", () => {
  it("transcribes through the configured provider, and explains when none is set", async () => {
    await withBot();
    const missing = await h!.app.inject({
      method: "POST",
      url: "/api/voice/transcribe",
      headers: auth,
      payload: { audio: "AAAA", mediaType: "audio/webm" },
    });
    expect(missing.statusCode).toBe(409);

    await h!.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "openai-compatible", label: "STT", baseUrl: "http://stt.example/v1", apiKey: "k" },
    });
    await h!.app.inject({
      method: "PUT",
      url: "/api/voice",
      headers: auth,
      payload: { sttProvider: "openai-compatible", sttModel: "whisper-1" },
    });
    const res = await h!.app.inject({
      method: "POST",
      url: "/api/voice/transcribe",
      headers: auth,
      payload: { audio: Buffer.from("fake audio").toString("base64"), mediaType: "audio/webm;codecs=opus" },
    });
    expect(res.json()).toEqual({ text: "hello world" });
    const sent = h!.calls.find((c) => c.url.includes("audio/transcriptions"));
    expect(sent?.headers.get("authorization")).toBe("Bearer k");
  });
});

describe("saved logins for web pages", () => {
  it("match only the login's own site, and its subdomains only when the login allows them", async () => {
    const harness = await makeHarness();
    const { vaultService } = harness.services;
    vaultService.add({ kind: "login", website: "https://www.daraz.pk/", username: "u", password: "p" });
    const host = (name: string) => vaultService.loginForHost(name)?.password ?? null;
    expect(host("daraz.pk")).toBe("p");
    expect(host("www.daraz.pk")).toBe("p");
    expect(host("member.daraz.pk")).toBeNull();
    expect(host("daraz.pk.evil.com")).toBeNull();
    expect(host("evildaraz.pk")).toBeNull();

    vaultService.add({
      kind: "login",
      website: "https://example.com",
      username: "u",
      password: "e",
      subdomains: true,
    });
    expect(host("accounts.example.com")).toBe("e");
    // Each shop on a shared domain belongs to someone else.
    vaultService.add({
      kind: "login",
      website: "https://myshopify.com",
      username: "u",
      password: "s",
      subdomains: true,
    });
    expect(host("attacker.myshopify.com")).toBeNull();
    await harness.close();
  });
});

describe("secret requests", () => {
  it("save only under the name the bot asked for", async () => {
    const { bot } = await withBot([
      [call("request_secret", { name: "GITHUB_TOKEN", reason: "PRs" })],
      [{ message: { content: "ok" } }],
    ]);
    h!.services.vault.set("OPENAI_API_KEY", "sk-real");
    const card = nextEvent<Extract<MessagePart, { type: "secret" }>>(h!.bus, (e) => {
      if (e.type !== "message.updated") return undefined;
      const part = e.message.parts.find((p: MessagePart) => p.type === "secret");
      return part?.type === "secret" && !part.saved && part;
    });
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "connect" },
    });
    const part = await card;
    const res = await h!.app.inject({
      method: "POST",
      url: `/api/secret-requests/${part.requestId}`,
      headers: auth,
      payload: { name: "OPENAI_API_KEY", value: "ghp_x" },
    });
    expect(res.statusCode).toBe(204);
    expect(h!.services.vault.get("GITHUB_TOKEN")).toBe("ghp_x");
    expect(h!.services.vault.get("OPENAI_API_KEY")).toBe("sk-real");
  });
});

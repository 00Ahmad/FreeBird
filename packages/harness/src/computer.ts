import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { BotId, type Bot, type BotComputer, type ComputerStatus } from "@mrog/shared";
import { BADGES, defineTool, isPrivateHost, safe, type Risk, type ToolSpec } from "@mrog/tools";

import { fail, parse } from "./http";
import type { Services } from "./services";

/** A desktop in a container, viewed in the browser (KasmVNC/noVNC on port 3000 inside). */
const DEFAULT_IMAGE = "lscr.io/linuxserver/webtop:ubuntu-xfce";
const WEB_PORT = 3000;

export type DockerRunner = (
  args: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string; code: number }>;

const runDocker: DockerRunner = (args, timeoutMs = 60_000, signal) =>
  new Promise((resolve) => {
    execFile(
      "docker",
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? Number((error as { code: number }).code)
            : 1
          : 0;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr) || (error && code === 1 ? error.message : ""),
          code,
        });
      },
    );
  });

const containerName = (botId: string) => `mrog-${botId}`;

/**
 * Limits for a bot's computer. The image runs its init as root and bots use `sudo`, so `--cap-drop ALL` and
 * `no-new-privileges` would break it: only what a desktop never needs is taken away.
 *  - the process cap stops a fork bomb from taking the host's process table (browsers use many threads);
 *  - the memory cap keeps a runaway browser from starving this computer (room for Chrome and a few tabs);
 *  - no raw sockets (packet crafting, ARP spoofing; ping still works) and no device nodes.
 * They apply to a container when it is created; an existing one gets them on Reset.
 */
export const COMPUTER_LIMITS = [
  "--pids-limit=4096",
  "--memory=8g",
  "--cap-drop=NET_RAW",
  "--cap-drop=MKNOD",
] as const;

/** Exit codes of `timeout` when it ended the command: 124, or 137 when the KILL signal also reached `timeout`. */
const TIMED_OUT = new Set([124, 137]);

/**
 * Runs the command under `timeout` inside the container, so a time limit ends it there too (not only the docker
 * client). Images without `timeout` run it as is.
 */
const WITH_TIME_LIMIT =
  'command -v timeout >/dev/null 2>&1 && exec timeout -s KILL "$0" sh -lc "$1"; exec sh -lc "$1"';

/** Kills every process started with this run's tag (they inherit it), e.g. when the user presses Stop. */
const killTagged = (tag: string) =>
  `for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx "MROG_RUN=${tag}" && kill -KILL "\${p#/proc/}" 2>/dev/null; done; true`;

/**
 * The container can reach this computer and the local network (Ollama, a router's admin page), which bots
 * otherwise need approval for. The host's own names point back into the container; commands that name a local
 * address ask first. Loopback inside the container is the container itself, so that stays free.
 */
const LOCAL_TARGET =
  /\b(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|internal|home\.arpa))\b|[a-z][\w+.-]*:\/\/([^\s/:'"@]+)/gi;

function computerRisk(command: string): Risk {
  const summary = `On its computer: ${command}`;
  for (const match of command.matchAll(LOCAL_TARGET)) {
    const host = (match[1] ?? match[0]).toLowerCase();
    const loopback = host === "localhost" || host.startsWith("127.") || host === "0.0.0.0";
    if (!loopback && isPrivateHost(host))
      return { level: "ask", kind: "general", badges: [BADGES.network], summary, outward: true };
  }
  // Runs without asking, but it still does things (in its own container): a restart mid-command must say so.
  return { ...safe(summary), outward: true };
}

/**
 * Each bot's own computer: a Docker container with a desktop you can watch and take over.
 * Commands the bot runs there stay inside the container, apart from your computer.
 */
export class ComputerManager {
  constructor(
    private readonly services: Pick<Services, "store" | "bus">,
    private readonly docker: DockerRunner = runDocker,
  ) {
    // Computers still running from before a restart get their tool back without anyone opening their panel.
    void this.findRunning();
  }

  image(): string {
    return this.services.store.settings.get<string>("computer.image") ?? DEFAULT_IMAGE;
  }

  async status(): Promise<ComputerStatus> {
    const result = await this.docker(["version", "--format", "{{.Server.Version}}"], 10_000);
    const available = result.code === 0 && result.stdout.trim() !== "";
    return {
      docker: {
        available,
        version: available ? result.stdout.trim() : null,
        error: available ? null : result.stderr.trim().split("\n")[0] || "Docker isn't running.",
      },
      image: this.image(),
    };
  }

  /** Bots whose computer was running when last checked (tools are offered only to these). */
  private readonly running = new Set<string>();

  private async findRunning() {
    const result = await this.docker(
      ["ps", "--filter", "label=freebird=1", "--format", "{{.Names}}"],
      10_000,
    ).catch(() => null);
    if (result?.code !== 0) return;
    for (const name of result.stdout.split(/\r?\n/)) {
      if (name.startsWith("mrog-")) this.running.add(name.slice("mrog-".length));
    }
  }

  async get(botId: string): Promise<BotComputer> {
    const inspect = await this.docker(
      ["inspect", "--format", "{{.State.Status}}", containerName(botId)],
      10_000,
    );
    const status = inspect.code === 0 ? inspect.stdout.trim() : "none";
    if (status === "running") this.running.add(botId);
    else this.running.delete(botId);
    if (status === "none") return { state: "none", url: null, error: null };
    if (status !== "running")
      return { state: status === "created" ? "starting" : "stopped", url: null, error: null };
    const port = await this.docker(["port", containerName(botId), String(WEB_PORT)], 10_000);
    const match = /:(\d+)\s*$/m.exec(port.stdout);
    return { state: "running", url: match ? `http://127.0.0.1:${match[1]}` : null, error: null };
  }

  private changed() {
    this.services.bus.publish({ type: "data.changed", keys: ["computer"] });
  }

  async start(botId: string): Promise<BotComputer> {
    const current = await this.get(botId);
    if (current.state === "running") return current;
    const name = containerName(botId);
    const result =
      current.state === "none"
        ? await this.docker(
            [
              "run",
              "-d",
              "--name",
              name,
              // Only this computer can reach the desktop's web view.
              "-p",
              `127.0.0.1::${WEB_PORT}`,
              "--shm-size=1g",
              ...COMPUTER_LIMITS,
              "-e",
              "PUID=1000",
              "-e",
              "PGID=1000",
              "-v",
              `${name}-home:/config`,
              // The host's names lead back into the container instead of to this computer.
              "--add-host",
              "host.docker.internal:127.0.0.1",
              "--add-host",
              "gateway.docker.internal:127.0.0.1",
              "--label",
              "freebird=1",
              this.image(),
            ],
            15 * 60_000,
          )
        : await this.docker(["start", name], 60_000);
    this.changed();
    if (result.code !== 0)
      return { state: "error", url: null, error: result.stderr.trim() || "Could not start the computer." };
    return this.get(botId);
  }

  async stop(botId: string): Promise<BotComputer> {
    await this.docker(["stop", containerName(botId)], 60_000);
    this.changed();
    return this.get(botId);
  }

  /** A deleted bot: its container and its home volume go with it. Nothing to do when Docker isn't there. */
  async remove(botId: string): Promise<void> {
    const name = containerName(botId);
    const removed = await this.docker(["rm", "-f", name], 60_000).catch(() => null);
    await this.docker(["volume", "rm", "-f", `${name}-home`], 60_000).catch(() => null);
    const wasRunning = this.running.delete(botId);
    // Docker names the container it removed; a bot that never had one changes nothing on screen.
    if (wasRunning || (removed?.code === 0 && removed.stdout.trim() !== "")) this.changed();
  }

  /** "Reset Bot's Computer": a fresh container (the home volume with its files is kept). */
  async reset(botId: string): Promise<BotComputer> {
    await this.docker(["rm", "-f", containerName(botId)], 60_000);
    this.changed();
    return this.start(botId);
  }

  /**
   * Runs a command in the bot's container. The time limit and Stop end it inside the container too: ending only the
   * docker client would leave it running there.
   */
  async exec(botId: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const name = containerName(botId);
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const tag = randomUUID();
    const onAbort = () =>
      void this.docker(["exec", name, "sh", "-c", killTagged(tag)], 15_000).catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    const started = Date.now();
    try {
      const result = await this.docker(
        ["exec", "-e", `MROG_RUN=${tag}`, name, "sh", "-c", WITH_TIME_LIMIT, String(seconds), command],
        // The client gets a little longer, so the container's own limit is what normally ends it.
        timeoutMs + 10_000,
        signal,
      );
      signal?.throwIfAborted();
      const output = `${result.stdout}${result.stderr}`.slice(-16_000);
      const timedOut = TIMED_OUT.has(result.code) && Date.now() - started >= timeoutMs - 500;
      const status = timedOut ? `Timed out after ${seconds}s and was stopped.` : `Exit code: ${result.code}`;
      return `${output.trimEnd() || "(no output)"}\n\n${status}`;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Bots get a command tool for their own computer once it's running. */
  tools(bot: Bot): ToolSpec[] {
    if (!this.running.has(bot.id)) return [];
    return [
      defineTool({
        name: "computer_run",
        description:
          "Run a shell command on your own Linux computer (a container with a desktop, separate from the user's machine). Start GUI apps with DISPLAY=:1.",
        args: z.object({
          command: z.string().min(1),
          timeout_seconds: z.number().int().min(1).max(600).default(120),
        }),
        risk: (args) => computerRisk(args.command),
        run: async (args, ctx) => {
          const state = await this.get(bot.id);
          if (state.state !== "running")
            return "Your computer isn't running. Ask the user to start it from the Computer panel.";
          return this.exec(bot.id, args.command, args.timeout_seconds * 1000, ctx.signal);
        },
      }),
    ];
  }
}

export function registerComputerRoutes(app: FastifyInstance, manager: ComputerManager, services: Services) {
  app.get("/api/computer", async () => manager.status());

  app.put("/api/computer/image", async (request, reply) => {
    const body = parse(
      z.object({
        image: z
          .string()
          .trim()
          .min(3)
          .max(300)
          .regex(/^[\w./:@-]+$/),
      }),
      request.body,
      reply,
    );
    if (!body) return reply;
    services.store.settings.set("computer.image", body.image);
    return manager.status();
  });

  const action =
    (name: "get" | "start" | "stop" | "reset") =>
    async (request: { params: { id: string } }, reply: Parameters<typeof fail>[0]) => {
      const id = BotId.safeParse(request.params.id);
      if (!id.success || !services.store.bots.get(id.data))
        return fail(reply, 404, "not_found", "No bot has this id.");
      return { computer: await manager[name](id.data) };
    };

  app.get<{ Params: { id: string } }>("/api/bots/:id/computer", action("get"));
  app.post<{ Params: { id: string } }>("/api/bots/:id/computer/start", action("start"));
  app.post<{ Params: { id: string } }>("/api/bots/:id/computer/stop", action("stop"));
  app.post<{ Params: { id: string } }>("/api/bots/:id/computer/reset", action("reset"));
}

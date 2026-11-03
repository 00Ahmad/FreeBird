import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { flattenSchema } from "@mrog/providers";

import { BUILTIN_TOOLS, createToolHost, htmlToText, isPrivateHost, type ApprovalRequest } from ".";

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "mrog-tools-"));
});
// Windows can hold a killed process's folder for a moment after it exits.
afterEach(() => rmSync(workspace, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }));

function host(decision: "allow" | "deny" = "allow") {
  const asked: ApprovalRequest[] = [];
  const tools = createToolHost(
    BUILTIN_TOOLS,
    {
      workspace,
      botId: "bot_x",
      botName: "Ada",
      threadId: "thr_x",
      ask: async () => "blue",
    },
    async (request) => {
      asked.push(request);
      return decision;
    },
  );
  const call = (name: string, args: Record<string, unknown>) =>
    tools.execute({ id: "c", name, arguments: args }, new AbortController().signal);
  return { tools, asked, call };
}

describe("built-in tools", () => {
  it("writes, reads, edits, lists and searches inside the bot folder without asking", async () => {
    const { call, asked } = host();
    expect(await call("write_file", { path: "notes/todo.md", content: "one\ntwo\nthree" })).toMatchObject({
      status: "done",
    });
    expect((await call("read_file", { path: "notes/todo.md", offset: 2, limit: 1 })).result).toBe(
      "2| two\n…(3 lines total; read more with offset)",
    );
    expect(await call("edit_file", { path: "notes/todo.md", find: "two", replace: "2" })).toMatchObject({
      status: "done",
    });
    expect((await call("list_files", {})).result).toBe("notes/\n  todo.md");
    expect((await call("search_files", { query: "THREE" })).result).toBe("notes/todo.md:3: three");
    expect(asked).toEqual([]);
  });

  it("asks before touching files outside the bot folder, and respects a denial", async () => {
    const { call, asked } = host("deny");
    const outside = join(workspace, "..", "elsewhere.txt");
    expect(await call("write_file", { path: outside, content: "x" })).toEqual({
      status: "denied",
      result: "The user denied this.",
    });
    expect(asked[0]?.risk).toMatchObject({
      level: "ask",
      badges: ["Outside the bot's folder", "This can't be undone"],
    });
  });

  it("asks before every command, flags destructive ones, and runs it once allowed", async () => {
    const { call, asked } = host();
    const result = await call("run_command", { command: "echo hello-from-shell" });
    expect(result.status).toBe("done");
    expect(result.result).toContain("hello-from-shell");
    expect(result.result).toContain("Exit code: 0");
    expect(asked[0]?.risk).toMatchObject({ kind: "terminal", badges: [] });

    await call("run_command", { command: "rm -rf build" }).catch(() => {});
    expect(asked[1]?.risk.badges).toContain("This can't be undone");
  });

  it("times out long commands", async () => {
    const { call } = host();
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5";
    const result = await call("run_command", { command, timeout_seconds: 1 });
    expect(result.result).toContain("Timed out after 1s");
  }, 15_000);

  it("rejects bad arguments and unknown tools with a message the model can act on", async () => {
    const { call } = host();
    expect((await call("read_file", {})).result).toMatch(/Invalid arguments for read_file: path/);
    expect((await call("nope", {})).result).toMatch(/no tool named "nope"/);
    // A dropped prefix is accepted when only one tool fits ("url" → fetch_url), never when several do.
    expect((await call("url", {})).result).toMatch(/Invalid arguments for fetch_url/);
    expect((await call("files", {})).result).toMatch(/no tool named "files"/);
  });

  it("answers ask_user through the context", async () => {
    const { call } = host();
    expect((await call("ask_user", { question: "Color?" })).result).toBe("The user answered: blue");
  });

  it("publishes schemas the model can use, with defaults optional", () => {
    const { tools } = host();
    const read = tools.definitions().find((tool) => tool.name === "read_file")!;
    expect(read.parameters).toMatchObject({ type: "object", required: ["path"] });
    expect(JSON.stringify(read.parameters)).not.toContain("$schema");
  });
});

describe("helpers", () => {
  it("detects private hosts", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.5")).toBe(true);
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });

  it("turns HTML into readable text", () => {
    const text = htmlToText(
      '<html><head><title>x</title></head><body><script>bad()</script><h1>Hi</h1><p>A <a href="https://x.y">link</a> &amp; more</p></body></html>',
    );
    expect(text).toBe("Hi\n A link (https://x.y) & more");
  });

  it("flattens $ref and nullable unions for Ollama", () => {
    const flat = flattenSchema({
      type: "object",
      $defs: { Point: { type: "object", properties: { x: { type: "number" } } } },
      properties: {
        at: { $ref: "#/$defs/Point" },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        kind: { type: ["string", "null"] },
      },
    });
    expect(flat).toEqual({
      type: "object",
      properties: {
        at: { type: "object", properties: { x: { type: "number" } } },
        note: { type: "string" },
        kind: { type: "string" },
      },
    });
  });
});

describe("argument normalization", () => {
  it("coerces numbers and booleans, clamps to the schema, and drops nulls", async () => {
    const { call } = host();
    await call("write_file", { path: "a.txt", content: "x" });
    expect((await call("list_files", { path: ".", depth: "0" })).status).toBe("done");
    expect((await call("read_file", { path: "a.txt", offset: null, limit: "9999" })).result).toBe("1| x");
    expect((await call("edit_file", { path: "a.txt", find: "x", replace: "y", all: "true" })).status).toBe(
      "done",
    );
    const wrapped = await call("write_file", {
      function: "write_file",
      parameters: { path: "b.txt", content: "z" },
    });
    expect(wrapped.status).toBe("done");
  });
});

describe("fetch errors", () => {
  it("explains why a fetch failed instead of saying 'fetch failed'", async () => {
    const { explainFetchError } = await import("./web");
    const dns = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND www.daraz.com.pk" },
    });
    expect(explainFetchError("https://www.daraz.com.pk/x", dns)).toBe(
      "www.daraz.com.pk doesn't exist (no such domain). Check the address.",
    );
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(explainFetchError("http://localhost:9/", refused)).toBe("localhost refused the connection.");
  });

  it("says when a page is only a JavaScript shell", async () => {
    const { fetchReadable, looksScriptRendered } = await import("./web");
    const shell = `<html><body><nav>Home Cart</nav><script>${"x=1;".repeat(10_000)}</script></body></html>`;
    const article = `<html><body>${"<p>Plenty of readable words here.</p>".repeat(800)}<script>a()</script></body></html>`;
    expect(looksScriptRendered(shell)).toBe(true);
    expect(looksScriptRendered(article)).toBe(false);
    const page = (html: string) => async () =>
      new Response(html, { headers: { "content-type": "text/html" } });
    const signal = new AbortController().signal;
    expect(await fetchReadable("https://shop.example/", signal, page(shell))).toContain(
      "builds its content with JavaScript",
    );
    expect(await fetchReadable("https://blog.example/", signal, page(article))).not.toContain("JavaScript");
  });
});

describe("addresses that don't exist", () => {
  it("tells the model not to guess after a 404", async () => {
    const { fetchReadable } = await import("./web");
    const missing = async () =>
      new Response("<html><body>Not found</body></html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    expect(await fetchReadable("https://x.example/guess", new AbortController().signal, missing)).toContain(
      "Don't guess addresses",
    );
  });
});

describe("forms in fetched pages", () => {
  it("shows a site's search form and its fields", async () => {
    const text = htmlToText(
      `<form action="/search"><input type="search" name="q" placeholder="Search products"><input type="hidden" name="t" value="x"><button>Go</button></form>`,
    );
    expect(text).toContain("[form: GET /search]");
    expect(text).toContain('[search field "Search products" name=q]');
    expect(text).not.toContain("hidden");
  });

  it("spots a small page that is all script", async () => {
    const { looksScriptRendered } = await import("./web");
    const shell = `<html><body><h1>Results</h1><div id="list">Loading</div><script>${"fetch('/api').then(r=>r.json()).then(show);".repeat(12)}</script></body></html>`;
    expect(looksScriptRendered(shell)).toBe(true);
    expect(looksScriptRendered("<p>Hi</p>")).toBe(false);
  });
});

describe("audit fixes", () => {
  it("recognises local addresses however they're written", () => {
    for (const address of [
      "[::ffff:127.0.0.1]",
      "::ffff:7f00:1",
      "[::]",
      "foo.localhost",
      "localhost.",
      "100.64.1.2",
      "fec0::1",
    ]) {
      expect(isPrivateHost(address), address).toBe(true);
    }
    expect(isPrivateHost("100.128.0.1")).toBe(false);
    expect(isPrivateHost("::ffff:8.8.8.8")).toBe(false);
  });

  it("won't follow a redirect from a public page to the local network", async () => {
    const { fetchReadable } = await import("./web");
    const seen: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://192.168.1.1/admin" } });
    }) as typeof fetch;
    const text = await fetchReadable("https://93.184.216.34/", new AbortController().signal, impl);
    expect(text).toContain("Refused");
    expect(seen).toEqual(["https://93.184.216.34/"]);
  });

  it("never hands a Vault secret back to the model in a tool result", async () => {
    const tools = createToolHost(
      [
        {
          ...BUILTIN_TOOLS.find((tool) => tool.name === "ask_user")!,
          name: "leak",
          run: async () => "password is hunter22!",
        },
      ],
      {
        workspace,
        botId: "b",
        botName: "B",
        threadId: "t",
        ask: async () => "",
        env: { SITE_PASSWORD: "hunter22!" },
      },
      async () => "allow",
    );
    const outcome = await tools.execute(
      { id: "c", name: "leak", arguments: { question: "q" } },
      new AbortController().signal,
    );
    expect(outcome.result).toBe("password is [hidden]");
  });

  it("replaces text exactly, even with $ patterns in the replacement", async () => {
    const { call } = host();
    await call("write_file", { path: "a.ps1", content: "Write-Output OLD" });
    await call("edit_file", { path: "a.ps1", find: "OLD", replace: "$&-$$-$`-$'-$1" });
    expect((await call("read_file", { path: "a.ps1" })).result).toBe("1| Write-Output $&-$$-$`-$'-$1");
  });

  it("doesn't search through a junction out of the bot's folder", async () => {
    const { symlinkSync, writeFileSync } = await import("node:fs");
    const elsewhere = mkdtempSync(join(tmpdir(), "mrog-outside-"));
    try {
      writeFileSync(join(elsewhere, "secret.txt"), "the password is swordfish");
      symlinkSync(elsewhere, join(workspace, "linked"), "junction");
      const { call, asked } = host();
      await call("write_file", { path: "own.txt", content: "my own password note" });
      expect((await call("search_files", { query: "password" })).result).toBe(
        "own.txt:1: my own password note",
      );
      expect(asked).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("badges commands that delete, overwrite or stop things, and not ones that only look alike", async () => {
    const { looksDestructive } = await import("./shell");
    for (const command of [
      "ri -r -fo build",
      "Set-Content notes.txt 'x'",
      "git checkout -- .",
      "Stop-Process -Name node",
      "mv a.txt b.txt",
      "git push origin main --force",
      "Remove-Item -Recurse dist",
      "rm -rf build",
    ]) {
      expect(looksDestructive(command), command).toBe(true);
    }
    for (const command of [
      "Get-ChildItem | Format-Table",
      "git push --force-with-lease",
      "docker ps --format '{{.Names}}'",
      "Get-Date -Format yyyy-MM-dd",
      "git status",
    ]) {
      expect(looksDestructive(command), command).toBe(false);
    }
  });

  it("stops at the time limit even when the command left a child running", async () => {
    const { call } = host();
    const command =
      process.platform === "win32"
        ? "Start-Process -NoNewWindow ping -ArgumentList '-n','30','127.0.0.1'"
        : "sleep 30 & echo started";
    const started = Date.now();
    const result = await call("run_command", { command, timeout_seconds: 1 });
    expect(result.result).toContain("Timed out after 1s");
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);

  it("keeps non-ASCII command output intact", async () => {
    const { call } = host();
    expect((await call("run_command", { command: "echo 'café ü 日本'" })).result).toContain("café ü 日本");
  }, 15_000);

  it("asks before fetching hosts on the local network by name", async () => {
    for (const name of ["nas", "router.lan", "printer.home.arpa", "NAS."]) {
      expect(isPrivateHost(name), name).toBe(true);
    }
    expect(isPrivateHost("example.com")).toBe(false);
    const { tools, asked } = host("deny");
    await tools.execute(
      { id: "c", name: "fetch_url", arguments: { url: "http://nas:5000/" } },
      new AbortController().signal,
    );
    expect(asked[0]?.risk).toMatchObject({ level: "ask", badges: ["Reaches your local network"] });
  });

  it("treats a junction out of the bot's folder as outside it", async () => {
    const { symlinkSync, mkdirSync } = await import("node:fs");
    const { resolvePath } = await import("./paths");
    const elsewhere = mkdtempSync(join(tmpdir(), "mrog-outside-"));
    try {
      mkdirSync(join(elsewhere, "secret"));
      symlinkSync(elsewhere, join(workspace, "docs"), "junction");
      expect(resolvePath(workspace, "docs/secret").inside).toBe(false);
      expect(resolvePath(workspace, "docs/new-file.txt").inside).toBe(false);
      expect(resolvePath(workspace, "notes/new.txt").inside).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

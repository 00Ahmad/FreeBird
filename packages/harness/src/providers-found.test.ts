import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_SECRET_LENGTH } from "@mrog/shared";

import { plausibleKey } from "./providers";
import { auth, fakeOllama, makeHarness, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
  h = undefined;
});

// Distinctive enough that any piece of it showing up anywhere is a leak, not a coincidence.
const GROQ_KEY = "gsk_Zq7Wm3Rt9Yp2Lk5Vn8Bx4Cd6Fh1Jg0Qs";
/** Pieces of the key: a response carrying even part of it is a leak. */
const pieces = (value: string) => [value, value.slice(0, 10), value.slice(12, 22), value.slice(-8)];

const groq = {
  "api.groq.com/openai/v1/models": () => Response.json({ data: [{ id: "llama-3.3-70b-versatile" }] }),
};

/** A harness whose environment holds exactly these variables. */
async function withEnv(env: Record<string, string>) {
  h = await makeHarness({
    handlers: { ...fakeOllama(), ...groq },
    setup: (services) => {
      services.providers.readEnv = (name) => env[name];
    },
  });
  return h;
}

const found = async (harness: TestHarness) =>
  (await harness.app.inject({ url: "/api/providers/found", headers: auth })).json().found;

describe("API keys found on this computer", () => {
  it("lists a provider whose variable is set, by name only", async () => {
    const harness = await withEnv({ GROQ_API_KEY: GROQ_KEY, ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijkl" });
    const res = await harness.app.inject({ url: "/api/providers/found", headers: auth });
    expect(res.statusCode).toBe(200);
    // Exactly these fields: a value (or anything else) added to the answer fails here.
    expect(res.json()).toEqual({
      found: [
        { preset: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
        { preset: "groq", label: "Groq", envVar: "GROQ_API_KEY" },
      ],
    });
    for (const piece of [...pieces(GROQ_KEY), "sk-ant-api03"]) expect(res.body).not.toContain(piece);
  });

  it("finds nothing when no variable is set", async () => {
    const harness = await withEnv({ UNRELATED: "value", AZURE_OPENAI_API_KEY: GROQ_KEY });
    expect(await found(harness)).toEqual([]);
  });

  it("takes Google's GEMINI_API_KEY first, then GOOGLE_API_KEY", async () => {
    const both = await withEnv({
      GEMINI_API_KEY: "AIzaGemini0123456789",
      GOOGLE_API_KEY: "AIzaGoogle0123456789",
    });
    expect(await found(both)).toEqual([
      { preset: "google", label: "Google Gemini", envVar: "GEMINI_API_KEY" },
    ]);
    await both.close();
    // A placeholder in the first doesn't hide a real key in the second.
    const second = await withEnv({ GEMINI_API_KEY: "your-key", GOOGLE_API_KEY: "AIzaGoogle0123456789" });
    expect(await found(second)).toEqual([
      { preset: "google", label: "Google Gemini", envVar: "GOOGLE_API_KEY" },
    ]);
  });

  it("doesn't offer a provider that is already added, even turned off or added by hand with another key", async () => {
    const harness = await withEnv({ GROQ_API_KEY: GROQ_KEY, OPENAI_API_KEY: "sk-proj-abcdefghijklmnop" });
    await harness.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "groq", apiKey: "gsk-pasted-by-hand" },
    });
    await harness.app.inject({
      method: "PATCH",
      url: "/api/providers/groq",
      headers: auth,
      payload: { enabled: false },
    });
    expect(await found(harness)).toEqual([{ preset: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY" }]);

    // Removed again, it is offered again.
    await harness.app.inject({ method: "DELETE", url: "/api/providers/groq", headers: auth });
    expect((await found(harness)).map((key: { preset: string }) => key.preset)).toEqual(["openai", "groq"]);
  });

  it("refuses values that can't be a working key", async () => {
    const harness = await withEnv({
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "   ",
      GROQ_API_KEY: "gsk_abc def",
      XAI_API_KEY: "x".repeat(MAX_SECRET_LENGTH + 1),
      MISTRAL_API_KEY: "your-key",
      DEEPSEEK_API_KEY: "sk-...",
      OPENROUTER_API_KEY: "<your OpenRouter key>",
      TOGETHER_API_KEY: "changeme",
      FIREWORKS_API_KEY: "xxx",
      CEREBRAS_API_KEY: "YOUR_API_KEY_HERE",
      OLLAMA_API_KEY: "$OLLAMA_KEY",
    });
    expect(await found(harness)).toEqual([]);
  });

  it("adds the provider exactly as a pasted key would, and the key works", async () => {
    const harness = await withEnv({ GROQ_API_KEY: `  ${GROQ_KEY}\n` });
    const events: unknown[] = [];
    harness.bus.subscribe((event) => events.push(event));
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => logged.push(args));

    const added = await harness.app.inject({
      method: "POST",
      url: "/api/providers/found/groq",
      headers: auth,
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({
      provider: {
        id: "groq",
        preset: "groq",
        label: "Groq",
        baseUrl: "",
        enabled: true,
        hasKey: true,
        local: false,
        kind: "openai",
      },
    });
    // Kept trimmed, under the same keychain entry a pasted key uses.
    expect(harness.services.vault.get("PROVIDER_GROQ_KEY")).toBe(GROQ_KEY);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "data.changed", keys: ["providers", "models"] }),
    );

    const test = await harness.app.inject({ method: "POST", url: "/api/providers/groq/test", headers: auth });
    expect(test.json()).toEqual({ models: 1 });
    const call = harness.calls.find((candidate) => candidate.url.includes("api.groq.com"));
    expect(call?.headers.get("authorization")).toBe(`Bearer ${GROQ_KEY}`);

    // It is no longer offered, and asking again is refused.
    expect(await found(harness)).toEqual([]);
    const again = await harness.app.inject({
      method: "POST",
      url: "/api/providers/found/groq",
      headers: auth,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "already_added", message: "Groq is already added." });

    // The key is in none of the answers, events or log lines, not even in part.
    const list = await harness.app.inject({ url: "/api/providers", headers: auth });
    const seen = [added.body, again.body, list.body, JSON.stringify(events), JSON.stringify(logged)];
    for (const text of seen) for (const piece of pieces(GROQ_KEY)) expect(text).not.toContain(piece);
  });

  it("says 404 for a provider with no usable key set or none to look for", async () => {
    const harness = await withEnv({ GROQ_API_KEY: "your-key", AZURE_OPENAI_API_KEY: GROQ_KEY });
    const placeholder = await harness.app.inject({
      method: "POST",
      url: "/api/providers/found/groq",
      headers: auth,
    });
    expect(placeholder.statusCode).toBe(404);
    expect(placeholder.json().message).toContain("No usable Groq key");
    expect(placeholder.body).not.toContain("your-key");
    const unset = await harness.app.inject({
      method: "POST",
      url: "/api/providers/found/openai",
      headers: auth,
    });
    expect(unset.statusCode).toBe(404);
    for (const preset of ["azure", "lmstudio", "openai-compatible", "nope"]) {
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/providers/found/${preset}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(GROQ_KEY);
    }
    expect(harness.services.vault.names()).toEqual([]);
    expect(harness.services.providers.configs()).toEqual([]);
  });

  it("doesn't add a key from the environment longer than a pasted one may be", async () => {
    const harness = await withEnv({ GROQ_API_KEY: "g".repeat(MAX_SECRET_LENGTH + 1) });
    const res = await harness.app.inject({ method: "POST", url: "/api/providers/found/groq", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("g".repeat(20));
    expect(harness.services.vault.has("PROVIDER_GROQ_KEY")).toBe(false);
  });

  it("leaves pasting a key exactly as it was, even with another key in the environment", async () => {
    const harness = await withEnv({ GROQ_API_KEY: GROQ_KEY });
    const added = await harness.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "groq", apiKey: "gsk-pasted" },
    });
    expect(added.statusCode).toBe(201);
    expect(harness.services.vault.get("PROVIDER_GROQ_KEY")).toBe("gsk-pasted");
    expect(added.body).not.toContain(GROQ_KEY);
    const tooLong = await harness.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "openai", apiKey: "k".repeat(MAX_SECRET_LENGTH + 1) },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toBe("secret_too_long");
    const noKey = await harness.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "openai" },
    });
    expect(noKey.json().message).toContain("needs an API key");
  });

  it("reads the real environment by default", async () => {
    h = await makeHarness();
    vi.stubEnv("CEREBRAS_API_KEY", "csk-real0123456789abcdef");
    try {
      expect(await found(h)).toContainEqual({
        preset: "cerebras",
        label: "Cerebras",
        envVar: "CEREBRAS_API_KEY",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("whether a variable's value could be a key", () => {
  it("keeps real-looking keys, trimmed", () => {
    for (const key of [
      "sk-ant-api03-Ab12Cd34Ef56",
      "sk-proj-Ab12Cd34Ef56",
      "AIzaSyAb12Cd34Ef56",
      "addb7f0e9c3a4d5e6f708192a3b4c5d6", // hex, starting with "add"
      "MyX8kQ2pL5nR7tV9wZ3bD6fH", // no prefix, starting with "my"
      "xai-Ab12Cd34Ef56",
      "a.b.c", // dotted tokens are fine
    ])
      expect(plausibleKey(key)).toBe(key);
    expect(plausibleKey("\t sk-abc123 \n")).toBe("sk-abc123");
    expect(plausibleKey("k".repeat(MAX_SECRET_LENGTH))).toBe("k".repeat(MAX_SECRET_LENGTH));
  });

  it("refuses empty, broken, too long and placeholder values", () => {
    for (const value of [
      undefined,
      "",
      "  ",
      "sk abc",
      "k".repeat(MAX_SECRET_LENGTH + 1),
      "your-key",
      "your_api_key_here",
      "YOUR_OPENAI_API_KEY",
      "paste-your-key-here",
      "<api key>",
      "xxx",
      "XXXXXXXX",
      "sk-...",
      "sk-xxxxxxxx",
      "sk-ant-xxxx",
      "***",
      "sk-abc...wxyz",
      "changeme",
      "placeholder",
      "${OPENAI_API_KEY}",
      "%OPENAI_API_KEY%",
    ])
      expect(plausibleKey(value), String(value)).toBeNull();
  });

  it("decides quickly even for the longest value allowed", () => {
    const started = performance.now();
    plausibleKey(`your${"a".repeat(MAX_SECRET_LENGTH - 5)}!`);
    plausibleKey(`${"sk-".repeat(400)}x`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

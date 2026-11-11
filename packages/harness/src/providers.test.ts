import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const sse = (events: unknown[]) =>
  new Response(
    new Blob([
      events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""),
    ]).stream(),
  );

const groq = {
  "api.groq.com/openai/v1/models": () =>
    Response.json({ data: [{ id: "llama-3.3-70b-versatile" }, { id: "whisper-large-v3" }] }),
  "api.groq.com/openai/v1/chat/completions": () =>
    sse([
      { choices: [{ delta: { content: "From the cloud" } }] },
      { choices: [], usage: { prompt_tokens: 30, completion_tokens: 3 } },
      "[DONE]",
    ]),
};

describe("providers", () => {
  it("adds a cloud provider with its key in the keychain, never returning the key", async () => {
    h = await makeHarness({ handlers: { ...fakeOllama(), ...groq } });
    const added = await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "groq", apiKey: "gsk-secret" },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().provider).toMatchObject({ id: "groq", label: "Groq", hasKey: true, local: false });
    expect(added.body).not.toContain("gsk-secret");
    expect(h.services.vault.get("PROVIDER_GROQ_KEY")).toBe("gsk-secret");

    const list = await h.app.inject({ url: "/api/providers", headers: auth });
    expect(list.body).not.toContain("gsk-secret");
    expect(list.json().presets.length).toBeGreaterThan(15);

    const test = await h.app.inject({ method: "POST", url: "/api/providers/groq/test", headers: auth });
    expect(test.json()).toEqual({ models: 1 });

    const models = (await h.app.inject({ url: "/api/models", headers: auth }))
      .json()
      .models.map((m: any) => m.ref);
    expect(models).toEqual(expect.arrayContaining(["ollama:test:1b", "groq:llama-3.3-70b-versatile"]));
    const chat = h.calls.find((call) => call.path.endsWith("/models") && call.url.includes("groq"));
    expect(chat?.headers.get("authorization")).toBe("Bearer gsk-secret");
  });

  it("refuses a provider that needs a key or URL it didn't get", async () => {
    h = await makeHarness();
    const noKey = await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "openai" },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().message).toContain("needs an API key");
    const noUrl = await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "azure", apiKey: "k" },
    });
    expect(noUrl.json().message).toContain("needs a base URL");
  });

  it("runs a bot on a cloud model and counts its tokens", async () => {
    h = await makeHarness({ handlers: { ...fakeOllama(), ...groq } });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "groq", apiKey: "k" },
    });
    const bot = (
      await h.app.inject({
        method: "POST",
        url: "/api/bots",
        headers: auth,
        payload: { name: "Cloudy", model: "groq:llama-3.3-70b-versatile" },
      })
    ).json().bot as Bot;

    const done = nextEvent<Message>(
      h.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && e.message,
    );
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "hi" },
    });
    const reply = await done;
    expect(reply).toMatchObject({
      model: "groq:llama-3.3-70b-versatile",
      parts: [{ type: "text", text: "From the cloud" }],
    });

    const usage = (await h.app.inject({ url: "/api/usage", headers: auth })).json();
    expect(usage.bots).toEqual([{ botId: bot.id, inputTokens: 30, outputTokens: 3, messages: 1 }]);
    expect(usage.localProviders).toEqual(["ollama"]);
  });

  it("answers on a cloud model without waiting for Ollama to start or for the shared-model slot", async () => {
    h = await makeHarness({ handlers: { ...fakeOllama(), ...groq } });
    await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "groq", apiKey: "k" },
    });
    // Ollama is still starting, and a local turn holds the only slot.
    h.services.turns.extensions.beforeModel = () => new Promise(() => {});
    let free!: () => void;
    const held = h.services.runtime.run("user", () => new Promise<void>((resolve) => (free = resolve)));
    const bot = (
      await h.app.inject({
        method: "POST",
        url: "/api/bots",
        headers: auth,
        payload: { name: "Cloudy", model: "groq:llama-3.3-70b-versatile" },
      })
    ).json().bot as Bot;
    const done = nextEvent<Message>(
      h.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && e.message,
    );
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "hi" },
    });
    expect((await done).parts).toEqual([{ type: "text", text: "From the cloud" }]);
    free();
    await held;
  });

  it("switches a bot's model mid-conversation and removes a provider with its key", async () => {
    h = await makeHarness({ handlers: { ...fakeOllama(), ...groq } });
    await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "groq", apiKey: "k" },
    });
    const bot = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "B" } })
    ).json().bot;
    const patched = await h.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers: auth,
      payload: { model: "groq:llama-3.3-70b-versatile" },
    });
    expect(patched.json().bot.model).toBe("groq:llama-3.3-70b-versatile");

    expect(
      (await h.app.inject({ method: "DELETE", url: "/api/providers/groq", headers: auth })).statusCode,
    ).toBe(204);
    expect(h.services.vault.has("PROVIDER_GROQ_KEY")).toBe(false);
    expect(h.services.registry.get("groq")).toBeUndefined();
  });

  it("keeps no key for a server on the user's network, and never sends one to it", async () => {
    h = await makeHarness({
      handlers: {
        ...fakeOllama(),
        "127.0.0.1:1234/v1/models": () => Response.json({ data: [{ id: "qwen" }] }),
      },
    });
    const added = await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "lmstudio", apiKey: "typed-by-mistake" },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().provider.hasKey).toBe(false);
    expect(h.services.vault.has("PROVIDER_LMSTUDIO_KEY")).toBe(false);

    const patched = await h.app.inject({
      method: "PATCH",
      url: "/api/providers/lmstudio",
      headers: auth,
      payload: { apiKey: "typed-again" },
    });
    expect(patched.statusCode).toBe(200);
    expect(h.services.vault.has("PROVIDER_LMSTUDIO_KEY")).toBe(false);

    // A key saved by an older version is not sent either.
    h.services.vault.set("PROVIDER_LMSTUDIO_KEY", "left-from-before");
    const view = await h.app.inject({ url: "/api/providers", headers: auth });
    expect(view.json().providers[0].hasKey).toBe(false);
    const test = await h.app.inject({ method: "POST", url: "/api/providers/lmstudio/test", headers: auth });
    expect(test.json()).toEqual({ models: 1 });
    const sent = h.calls.filter((call) => call.url.includes("127.0.0.1:1234"));
    expect(sent.length).toBeGreaterThan(0);
    for (const call of sent) expect(call.headers.get("authorization")).toBeNull();
  });

  it("still keeps the key for a custom OpenAI-compatible server", async () => {
    h = await makeHarness();
    const added = await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth,
      payload: { preset: "openai-compatible", baseUrl: "https://llm.example.com/v1", apiKey: "k-custom" },
    });
    expect(added.json().provider.hasKey).toBe(true);
    expect(h.services.vault.get("PROVIDER_OPENAI_COMPATIBLE_KEY")).toBe("k-custom");
  });
});

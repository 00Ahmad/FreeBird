# FreeBird — Plan

_Last updated: 2026-10-31_

## 1. Goal

A local-first desktop app with the **same UI/UX and features as Grok Bot** (xAI): a team of always-on AI bots you chat with like coworkers, each with its own computer, apps, memory and routines. Unlike Grok Bot, it must:

1. Run fully on **local models through Ollama**, with no cloud account and no vendor CLI login.
2. Work with **any local runtime**: Ollama, LM Studio, vLLM, llama.cpp server, and agent CLIs over ACP.
3. Connect to **every major API provider**, using the user's own keys.
4. Be **efficient**: one loaded model serves every bot (see §4.3).

**Decision (2026-10-31): we build from scratch and don't fork.** We want full control and none of another project's bugs. OpenMausBot is used only as a reference for ideas and pitfalls. **We copy no code from it.**

> Note: the original brief said "GROQ bot". It means **Grok Bot** (xAI's product, launched 2026-08-11). **Groq** (the inference company) is a different thing; it is listed below as one of the API providers.

---

## 2. Research summary

### 2.1 Grok Bot (xAI): the target

The full UI/UX breakdown is in **[UI-SPEC.md](UI-SPEC.md)**. Main features:

| Area             | What Grok Bot does                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bots as contacts | Messaging-style app. Threads sync between desktop and mobile. A searchable bot list with a Primary Bot, pinned bots and sections.                              |
| Teams of bots    | Bots run in parallel. A "Chief of Staff" bot manages specialist bots. Group chats hold 2–6 bots, and bots hand work to each other.                             |
| Own computer     | Each bot has a cloud desktop with a live preview. Take over / I'm done hands control back and forth. The bot can also use your local computer if you allow it. |
| Connect apps     | One-click app connections with multiple accounts and per-tool toggles. A Connect card appears in chat. Password managers are supported.                        |
| Routines         | Weekly calendar. Schedule, event and webhook triggers. "Teach a task" turns a recorded demonstration into a routine.                                           |
| Memory           | Bots remember conversations and preferences. Users can't view the memory in Grok Bot; we will fix that.                                                        |
| Approvals        | Allow once / Always allow / Deny cards. Auto-review with Custom Rules. Drafts must be approved before they're sent.                                            |
| Vault            | Logins, cards and contact info. Secure Forms and secret cards keep values hidden from the model.                                                               |
| Voice            | Dictation, voice memos, and voice calls with a bot.                                                                                                            |
| Sharing          | Share as template, a template gallery, Team Bots (Collaborator/Manager roles), Slack.                                                                          |

### 2.2 OpenMausBot: reference only

An open-source clone of Grok Bot (Apache-2.0, "early but real"). Worth learning from:

- **Split architecture works well.** The UI talks to a local **harness** server over HTTP plus one SSE event stream, and the harness owns every agent process.
- **A pluggable engine interface:** send turn, interrupt, steer (queue a message into a running turn), respond to approval, event stream, and capability flags. An engine that's misconfigured is marked "unavailable" instead of crashing the app.
- **Model efficiency** (checked in source, commit `8c663d2`). It doesn't load models itself; Ollama or LM Studio holds the model, so bots on the same model share one copy. OpenMausBot reads `/api/ps` to find loaded models and pins them as "Loaded now" in the picker. It also runs up to 6 sessions in one agent CLI process.
- **Mistakes to avoid:**
  - It requires a logged-in vendor CLI. Local models are second-class (PR #222 for "no CLI" is still open).
  - API keys are stored in plaintext.
  - No `keep_alive` and no request queue.
  - It's Mac-first, with weaker Windows support.
  - Releases ship daily with lots of churn.

### 2.3 Ollama (official docs)

- OpenAI-compatible API at `http://localhost:11434/v1/`:
  - Chat completions with streaming, **tools**, vision (base64), JSON mode and `reasoning_effort`
  - `/v1/responses`, `/v1/embeddings`, `/v1/models`
  - `/v1/audio/speech` and `/v1/audio/transcriptions`
- Native endpoints: `/api/tags` (installed models), `/api/show` (capabilities and context size), `/api/ps` (loaded models), `/api/pull` (download a model).
- Not supported: `tool_choice`, `logprobs`, `n`, image URLs.
- **Gotchas:**
  - Tool schemas with `$ref` or `anyOf` may be silently ignored.
  - The default `num_ctx` is small.
  - Models unload after 5 minutes idle.
  - **Requests with different `num_ctx` or options make the model reload.**

---

## 3. Tech stack (as built)

| Layer              | Choice                                                                     | Why                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language           | **TypeScript** (strict) everywhere                                         | One language for the UI, harness and tools                                                                                                                                                                     |
| Monorepo           | **pnpm workspaces** (no Turborepo)                                         | Clear package boundaries; `pnpm -r` is fast enough at this size                                                                                                                                                |
| Desktop shell      | **Electron**                                                               | Mature on Windows, macOS and Linux. Node runs inside it, so the harness can be embedded. _(Tauri is the alternative: smaller download, but the Node harness would have to run as a separate sidecar process.)_ |
| UI                 | **React 19 + Vite + Tailwind**, lucide icons, our own components (ui-kit)  | Fast to build and easy to theme with our own identity                                                                                                                                                          |
| UI state           | Zustand (UI state) + TanStack Query (server state)                         | Simple and predictable                                                                                                                                                                                         |
| Harness server     | Node 24 with **Fastify**, HTTP + **SSE**, on `127.0.0.1`                   | Typed routes and one event stream for the UI                                                                                                                                                                   |
| Contracts          | **Zod** schemas in `packages/shared`                                       | One source of truth for commands, events and config                                                                                                                                                            |
| Storage            | **SQLite** through Node's built-in `node:sqlite`, append-only migrations   | Local and durable, with no native addon to build. Holds threads, bots, memory and routines. (Vector search not added yet.)                                                                                     |
| Secrets            | OS keychain through `@napi-rs/keyring`                                     | Never plaintext                                                                                                                                                                                                |
| LLM providers      | **Our own adapters**: Ollama native, OpenAI-compatible, Anthropic Messages | Full control over streaming, tool calls, thinking and typed errors; three adapters cover every preset                                                                                                          |
| Tools              | Our own tool host + **MCP TypeScript SDK** (client) for connected apps     | A standard way to add tools and connect apps                                                                                                                                                                   |
| Browser / computer | playwright-core driving installed Edge/Chrome · Docker + noVNC desktop     | Fully local                                                                                                                                                                                                    |
| Scheduling         | Harness scheduler (a timer that checks due routines) + SQLite              | Routines run while the app is open; missed runs catch up on start                                                                                                                                              |
| Tests              | Vitest (unit) · our own agent-loop eval scripts (`packages/harness/evals`) | Playwright e2e not set up yet                                                                                                                                                                                  |
| Lint/format        | oxlint + Prettier                                                          |                                                                                                                                                                                                                |

---

## 4. Architecture

```
┌──────────── apps/desktop (Electron) ── loads ── apps/ui (React 19 + Vite + Tailwind) ─────────┐
│ Sidebar · Chat & group chats · Cards · Right panel (computer / details) · Settings · Library │
└───────────────────────────────┬────────── HTTP commands + SSE events ─────────────────────────┘
                                │
┌──────────────────────── packages/harness (local server, 127.0.0.1) ──────────────────────────┐
│ API (Fastify) ── Event bus ── Thread/Bot service ── Approval broker ── Scheduler (routines)  │
│        │                                                                                    │
│ packages/engine: agent loop (plan → tool calls → approval → observe → repeat)               │
│        │                          │                                                          │
│ packages/model-runtime            packages/tools (MCP host)                                  │
│  · shared-model manager           · built-in: shell, files, browser, computer, ask, agents   │
│  · request queue / priorities     · MCP servers (apps), per-tool toggles                    │
│ packages/providers                packages/memory (embeddings + sqlite-vec)                 │
│  · Ollama · LM Studio · vLLM · llama.cpp · OpenAI · Anthropic · Gemini · Groq · xAI ·       │
│    Mistral · DeepSeek · OpenRouter · Together · Fireworks · Cerebras · Azure · Bedrock ·    │
│    Vertex · any OpenAI-/Anthropic-compatible URL · ACP agent CLIs                           │
│ packages/store (node:sqlite)      · packages/vault (keychain) · packages/voice (TTS/STT)    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Repo layout

```
openmrogbog/
  apps/
    desktop/        Electron main + preload, embeds the harness, tray, auto-start
    ui/             React app (also runs in a browser against the harness for dev)
  packages/
    shared/         Zod schemas: commands, events, config, IDs
    harness/        Fastify server, event bus, services, approval broker, scheduler
    engine/         agent loop, prompt builder, context compaction
    model-runtime/  shared-model manager, queue, Ollama lifecycle
    providers/      provider registry + adapters, model discovery
    tools/          MCP host, built-in tools, schema flattener
    memory/         per-bot memory, embeddings, retrieval
    store/          SQLite schema + migrations (node:sqlite)
    vault/          secrets in the OS keychain, secure forms
    voice/          TTS/STT adapters (local first)
    ui-kit/         design tokens, shadcn components, icons, avatar shapes
  docs/  evals/  scripts/
```

### 4.2 Engine (our own agent loop)

- **Interface:** `startTurn(thread, input)`, `interrupt`, `steer` (queue a message into a running turn), `respond(requestId, allow/deny/answer)`, and an event stream.
  - Events: `text.delta`, `tool.start` / `tool.end`, `approval.request`, `question`, `draft`, `turn.end`, `error`.
  - Capability flags per model: `tools`, `vision`, `reasoning` and `contextWindow`.
- **Turn flow:**
  1. Build the prompt from the system prompt, bot profile, memory and transcript.
  2. Stream the model's reply.
  3. Send each tool call through the **approval broker** (rules → auto-review → ask the user).
  4. Run the tool, add the result, and loop. Stop at the final answer or the step limit.
- **Models without native tool support:** fall back to a ReAct-style text protocol (tool calls written as text and parsed from the reply), or disable tools.
- **Tool-schema flattener** removes `$ref` and `anyOf` for Ollama.
- **Context compaction:** summarize older turns when nearing the window limit.
- **Typed errors:** `provider_down`, `model_missing`, `invalid_key`, `quota`, `oom`, `timeout`.

### 4.3 Shared model runtime (efficiency)

- One model in memory serves every bot. **"Shared local model"** is the default for all bots. A bot can override it, and the UI warns that this loads a second model.
- **Warm up** the model at startup and send `keep_alive` (e.g. `30m`, or `-1` while the app is open) on every request.
- Send the **same `num_ctx` and options on every request** so Ollama never reloads the model.
- **Request queue and scheduler:** run up to `OLLAMA_NUM_PARALLEL` turns in parallel and queue the rest by priority: user chat > routines > background jobs (titles, summaries, memory). The chat shows "Waiting for model".
- Background jobs **reuse the loaded model**.
- Settings shows loaded models, RAM/VRAM use (`/api/ps`), parallel slots, and an Unload button. When we start Ollama ourselves, we also set `OLLAMA_NUM_PARALLEL` and `OLLAMA_MAX_LOADED_MODELS`.
- The model picker pins loaded models with a **"Loaded now"** label.

### 4.4 Providers ("connects to all API providers")

- **Registry entry:** `{ id, kind, baseURL, apiKeyRef, defaultModel, capabilities }`.
- **Model discovery:** `/v1/models`, Ollama `/api/tags` + `/api/show`, or a static catalog. Each model is tagged with tools / vision / reasoning / context size.
- **Local presets:** Ollama (auto-detected at `:11434`, remote host, Ollama Cloud), LM Studio (`:1234`), vLLM, llama.cpp `llama-server`, Jan, LocalAI.
- **Cloud:** OpenAI, Anthropic, Google Gemini, Groq, xAI, Mistral, DeepSeek, OpenRouter, Together, Fireworks, Cerebras, Azure OpenAI, AWS Bedrock, Vertex AI.
- **Custom:** any OpenAI-compatible or Anthropic-compatible URL. ACP agent CLIs (e.g. Claude Code, Codex) can be added as optional engines.
- In Settings: add a key, **test the connection**, list models, set the default. You can switch models mid-conversation.

### 4.5 Local-first defaults

| Feature                          | Local default                                                       | Optional cloud           |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------ |
| Bot computer                     | Docker desktop container + noVNC; host computer if the user opts in | Remote VM provider       |
| Memory / embeddings              | Ollama `/v1/embeddings` + sqlite-vec                                | Any embeddings provider  |
| Routing (who answers in a group) | Same shared local model                                             | Any provider             |
| TTS / STT                        | Ollama `/v1/audio/*`, whisper.cpp, Chatterbox, OS voices            | ElevenLabs, OpenAI, etc. |
| Connect apps                     | Local MCP servers + our own OAuth                                   | Composio or similar      |
| Keys / vault                     | OS keychain                                                         | —                        |

### 4.6 UI/UX

**Same UI/UX as Grok Bot**, specified in **[UI-SPEC.md](UI-SPEC.md)**: layout, flows, cards, settings and keyboard shortcuts. The visual identity is our own: name, logo, colors, typeface and avatar art.

### 4.7 Improvements over Grok Bot

- **Memory you can view and edit** for each bot.
- **Offline mode:** everything core works with Wi-Fi off.
- **Usage meter** with tokens and cost per bot (local models at $0).
- **Bring your own model** for each bot, with no subscription.

---

## 5. Phases

| Phase                           | Outcome                                                                                                                | Exit criteria                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **0. Foundations**              | Monorepo, Electron shell, harness skeleton, event protocol, SQLite, CI, design tokens                                  | `pnpm dev` opens the desktop app. The UI receives a heartbeat event from the harness over SSE. CI green on Windows.         |
| **1. Chat MVP on Ollama**       | Sidebar + chat + composer. Create/rename/delete bots. Streamed replies. Shared model runtime.                          | Fresh install → detect Ollama → pick or pull a model → chat with 3 bots that all use one loaded model. No account required. |
| **2. Agent loop + approvals**   | Engine with tools (shell, files, browser), approval cards, interrupt/steer                                             | A bot finishes a multi-step file task behind approval cards on 3 tool-capable Ollama models.                                |
| **3. All providers**            | Provider registry and settings UI                                                                                      | ≥15 providers configurable and tested. Switch model mid-chat. Keys in the keychain.                                         |
| **4. Grok Bot UI parity**       | Everything in UI-SPEC §1–7, 11, 15: details pane, bot settings, group chats, every card type, shortcuts, memory viewer | A side-by-side review against UI-SPEC passes, section by section.                                                           |
| **5. Computer, apps, routines** | Local computer panel + takeover, Connect apps (MCP), routines calendar + triggers, Teach a task, vault, voice          | Each feature in §2.1 works with an Ollama-only setup.                                                                       |
| **6. Sharing, polish, ship**    | Templates, export/import, eval suite, docs, installers                                                                 | Signed Windows installer, macOS dmg, Linux deb/AppImage. Agent-loop evals pass.                                             |
| **Later**                       | Mobile companion, Team Bots, Slack                                                                                     | —                                                                                                                           |

## 6. Risks

- **Scope:** Grok Bot is a large product. Mitigation: build in phases, ship the Chat MVP first, and cut anything in a phase that doesn't meet its exit criteria.
- **Small local models do worse at multi-step tool use.** Mitigations: recommend specific models, keep tool sets small (per-tool toggles), use the ReAct fallback, and let a bot use a cloud model for hard tasks.
- **Computer use on Windows** (Docker Desktop and WSL2 requirements, host control). Mitigation: Docker desktop first, host control later and opt-in.
- **Branding and legal:** match the UX but not xAI's brand assets (see UI-SPEC §0). Write all code ourselves; reading OpenMausBot for ideas is fine.

## 7. Open questions for the user

1. ~~Fork or greenfield?~~ **Greenfield (decided 2026-10-31).**
2. Final product name. Is "FreeBird" the name?
3. Electron (recommended) or Tauri?
4. Desktop only first, with mobile later?
5. Must everything work offline, or are optional cloud extras (remote VM, Composio) acceptable?
6. Can you share screenshots or a recording of Grok Bot for the visual details?

## Sources

- https://x.ai/news/introducing-grok-bot · https://x.ai/bot · https://docs.x.ai/grok-bot/* (bots, chat-and-collaboration, computer-and-apps, approvals-security-and-privacy, vault, shared-bots)
- https://www.wrightmode.com/blog/grok-bot-setup-guide · https://flaviocopes.com/grok-bot/
- https://github.com/milind-soni/OpenMausBot (reference only: README, `docs/custom-engines.md`, `server/contracts.ts`, `server/drivers/local-inject.ts`, `server/drivers/acp/core.ts`)
- https://docs.ollama.com/api/openai-compatibility

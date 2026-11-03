# Architecture

FreeBird is a TypeScript monorepo with three running pieces: an **Electron shell**, a **React interface**, and a local server called the **harness** that owns everything else.

```
┌──────────── apps/desktop (Electron) ── loads ── apps/ui (React 19 + Vite + Tailwind) ─────────┐
│ Sidebar · chats & group chats · cards · right panel (details / computer / browser) · settings │
└───────────────────────────────┬──────── HTTP commands + one SSE event stream ─────────────────┘
                                │   127.0.0.1 only · per-launch bearer token
┌─────────────────────── packages/harness (Fastify server) ─────────────────────────────────────┐
│ routes ─ event bus ─ TurnManager ─ approval & question brokers ─ routines ─ connectors (MCP)  │
│ team & delegation ─ races ─ clusters ─ browser (playwright-core) ─ computer (Docker) ─ vault  │
│        │                                                                                      │
│ packages/engine: the agent loop          packages/tools: built-in tools + tool host           │
│ packages/model-runtime: shared model     packages/providers: Ollama · OpenAI-compat · Anthropic│
│ packages/store: SQLite (node:sqlite)     packages/vault: OS keychain                          │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

## The pieces

| Package                  | Role                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop`           | Electron main process: single instance, starts the harness in a utility process, generates the token, sandboxed preload bridge, navigation lockdown, permission handler. |
| `apps/ui`                | The interface. Zustand for UI state, TanStack Query for server state, one SSE connection for live events. Also runs in a normal browser for development.                 |
| `packages/shared`        | Zod schemas for bots, messages, events and API shapes: the contract between UI and harness.                                                                              |
| `packages/harness`       | The only process that touches data, models and secrets. HTTP routes, the event bus, turns, approvals, routines, connectors, browser, computer, team features.            |
| `packages/engine`        | The agent loop: streams the model, runs tool calls, steering, step limits, self-check, history fitting and compaction, the text tool-call fallback.                      |
| `packages/model-runtime` | The shared local model: warm-up, `keep_alive`, identical options, a priority queue with a configurable number of slots.                                                  |
| `packages/providers`     | Provider adapters (Ollama native, OpenAI-compatible, Anthropic Messages), model discovery, tool-schema flattening, typed errors.                                         |
| `packages/tools`         | Built-in tools (files, commands, web pages, questions) and the tool host: argument repair, validation, risk, approval, secret masking.                                   |
| `packages/store`         | SQLite through Node's built-in `node:sqlite`, with append-only migrations.                                                                                               |
| `packages/vault`         | Secrets in the OS keychain; only names are ever stored or returned.                                                                                                      |
| `packages/ui-kit`        | Design tokens (light and dark), avatar shapes, buttons.                                                                                                                  |

## How a message becomes a reply

1. The UI posts the message; the harness saves it and publishes `message.created` on the event bus.
2. `TurnManager` starts a turn for each bot that should answer: one per bot per thread. A message that arrives mid-turn is **steered** into the running turn between steps instead of starting a new one.
3. The turn builds the system prompt (bot profile, instructions, memory, tool guidance), loads the history, and compacts old history into a cached summary if it no longer fits the context window.
4. For coordinators, a short planning question decides whether the job splits into parts for helpers.
5. `runTurn` (engine) streams the model's reply. Each tool call goes to the tool host, which repairs and validates arguments, judges the risk, and asks the **approval broker** when needed: the local-execution policy first, then saved rules, then an approval card in the chat.
6. Results go back to the model, and the loop repeats until a final answer or the step limit.
7. Progress streams to the UI as `message.delta` and `message.updated` events and is saved to SQLite every 750 ms.

## The shared model runtime

Local models are expensive to load, so one model serves every bot. `ModelRuntime` keeps it loaded with the same `num_ctx` and `keep_alive` on every request, warms it at start, and hands out a limited number of slots (**Bots at once**) through a priority queue: user chats, then routines, then background jobs. A turn holds a slot only while the model is generating, never while it waits for you or for helpers, so an unanswered approval card can't block other bots.

## Events and resume

The UI keeps one Server-Sent Events stream open. Durable events carry ids and the bus keeps the last 1,000 in memory, so a reconnecting client sends `Last-Event-ID` and catches up; if it has been away too long, the server tells it to resync and the UI refetches. Text deltas are ephemeral, and the UI never lets a refetched copy overwrite a reply that is still streaming.

## Security boundaries

The harness binds to 127.0.0.1, rejects non-loopback `Host` headers (DNS rebinding), checks a per-launch bearer token on every `/api` route it matched (so encoded paths can't skip it), and serves the packaged UI with a strict CSP. Secrets live in the OS keychain and are masked out of tool results. See [Privacy & security](privacy-and-security.md).

## Design documents

- [Plan](design/PLAN.md): goals, research, tech choices and phases.
- [UI spec](design/UI-SPEC.md): the interface, flow by flow.
- [Code audit (November 2026)](design/audit-2026-11.md): what was found and fixed.

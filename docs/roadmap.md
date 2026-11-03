# FreeBird — Roadmap

Built from scratch, no fork. See the [plan](design/PLAN.md) and the [UI spec](design/UI-SPEC.md). `[ ]` = open, `[x]` = done.

## Research & decisions

- [x] Research Grok Bot (xAI): features and interface
- [x] Research OpenMausBot (reference only) and check how it shares models in memory
- [x] Research the Ollama API
- [x] Write PLAN.md, TODO.md, UI-SPEC.md
- [x] Decide fork vs greenfield → **greenfield**
- [ ] Answer the open questions in PLAN §7: name, Electron vs Tauri, mobile, offline scope
- [ ] Get Grok Bot screenshots or a recording for visual details
- [x] Benchmark tool-capable Ollama models with `pnpm --filter @mrog/harness eval`: qwen3.5:9b and nemotron-3-nano:4b pass 3/3 file tasks; llama3.2:1b is unreliable (recommend ≥ 4B)
- [ ] Run the eval's shell task (`--allow-commands`) yourself; it was not run here because it lets a model run commands unattended

## Phase 0 — Foundations

- [x] Monorepo (pnpm workspaces) with `apps/desktop`, `apps/ui`, `packages/*`
- [x] TypeScript 7 strict, oxlint, Prettier, Vitest
- [ ] Playwright e2e suite (ad-hoc Electron scenario scripts verified each phase instead)
- [x] `shared`, `harness`, `store` (node:sqlite, migrations 1–4), `vault` (OS keychain), `ui-kit`
- [x] Electron 44 shell: single instance, harness in a utility process, sandboxed preload, navigation lockdown, permission handler (mic/notifications for our UI only)
- [ ] Tray + start at login (routines only run while the app is open; missed runs catch up on start)
- [ ] Pick a typeface (system font stack for now)
- [x] CI workflow (not yet run: no remote)

## Phase 1 — Chat MVP on Ollama ✅

- [x] Ollama detection + custom address, install help when it's missing
- [x] List models with capabilities, download with live progress
- [x] Onboarding: pick the shared model, create the first bot (becomes Primary)
- [x] Streamed Markdown replies, thinking blocks, stop, image attachments (paste/drag/pick)
- [x] Shared model runtime: warm-up, `keep_alive`, identical `num_ctx`, priority queue with "Waiting for the model…", loaded models + VRAM + unload, "Loaded now" dots
- [x] Persist threads/messages; interrupted replies marked stopped on restart
- [ ] Find in chat (Ctrl+F)

## Phase 2 — Agent loop + approvals ✅

- [x] Our own agent loop: native tool calls, text-protocol fallback, steering, step limit, context compaction (cached summaries)
- [x] Built-in tools: list/read/write/edit/search files (free inside the bot's folder), run_command (PowerShell/sh, timeouts, tree kill), fetch_url, ask_user
- [x] Approval broker: local execution policy → Custom Rules → approval cards (general / terminal, warning badges, Always allow); no approvals in group chats
- [x] Robustness for small models: argument normalization/unwrapping, retry + plain-text fallback when the runtime can't parse a tool call
- [x] Real-model eval script
- [x] Browser tool via Playwright (see "Bots on the web" below)

## Phase 3 — All API providers ✅

- [x] Own adapters: Ollama native, OpenAI-compatible, Anthropic Messages
- [x] Presets: OpenAI, Anthropic, Gemini, Groq, xAI, Mistral, DeepSeek, OpenRouter, Together, Fireworks, Cerebras, Azure OpenAI, Ollama Cloud, LM Studio, vLLM, llama.cpp, Jan, LocalAI, Ollama on another computer, custom OpenAI-/Anthropic-compatible
- [x] Settings → Models & Providers (keys in the keychain, test, on/off, replace key, remove); model menu in the chat header; switch mid-conversation; Usage page
- [ ] AWS Bedrock and Google Vertex (need SigV4 / OAuth signing)
- [ ] ACP agent CLIs (Claude Code, Codex) as engines
- [ ] Cloud prices in the usage page (shows tokens; local = $0)
- [ ] Verify against real cloud keys (verified against Ollama's real OpenAI-compatible API; cloud adapters are unit-tested only)

## Phase 4 — Grok Bot UI parity ✅ (mostly)

- [x] Sidebar: + menu, sections, group chats, Hidden Bots, compact mode (Ctrl+B), full right-click menus, Duplicate, notifications toggle
- [x] Group chats (2–6 bots, "To:" field, @mentions, @everyone, routing by the shared model, one-after-another replies), rename/members/delete
- [x] Bot-to-bot messages (`message_bot`) in readable "A ↔ B" threads
- [x] Details pane: avatar editor (shapes/colors/upload), name/label, About, Memory (view/edit/add/import), Skills (/name), Files, Share as template; group details
- [x] Composer: @ and / suggestions, reply-to with quotes; message actions: reply, reactions, copy, read aloud
- [x] Command palette (Ctrl+K), shortcuts sheet (Ctrl+/), desktop notifications
- [ ] Avatar "Generate" tab (needs an image model)
- [x] Library: save bot replies (copies that outlive the chat), rename, open source chat, download .md
- [ ] Draft cards ("Needs approval": Send/Discard) for email/Slack connectors
- [ ] Groups: small models sometimes copy the "[Name]:" prefix into their reply

## Phase 5 — Computer, apps, routines, vault, voice ✅ (mostly)

- [x] Routines: weekly / interval / once / webhook / manual, weekly calendar, Pause/Resume/Test/Edit/Delete, reports in the bot's chat, catch-up after restart
- [x] Teach a task (written steps saved as a run-on-demand routine)
- [x] Connect apps: any MCP server (stdio or HTTP), per-tool toggles, "Ask first", vault:NAME secrets, status
- [x] Vault: logins / cards / contact info in the keychain, CSV import, secure secret card (`request_secret`), `use_login` → env vars for commands
- [x] Computer: Docker desktop per bot (bound to 127.0.0.1), live view panel, start/stop/reset, `computer_run` tool
- [x] Voice: dictation through any OpenAI-compatible transcription endpoint (Ctrl+D), read aloud with OS voices
- [ ] Computer verified live (Docker wasn't running here; tested against a fake Docker runner)
- [ ] Teach a task by screen recording (written steps only for now)
- [ ] Voice chat (calls), local speech-to-text without a provider
- [ ] OAuth sign-in flows for apps (MCP servers that need OAuth must be configured with tokens for now)
- [x] Secure sign-in to web pages with Vault logins (`browser_sign_in`)

## Phase 6 — Sharing, polish, ship

- [ ] Team/department export-import beyond single-bot templates
- [ ] Docs: quickstart, providers guide, troubleshooting
- [ ] Installers (Windows signed, macOS notarized, Linux), auto-update
- [ ] Performance pass

## Later

- [ ] Mobile companion app
- [ ] Team Bots (Collaborator/Manager roles) + Slack bridge

## Coordinators & helper bots ✅

- [x] Coordinator role (primary bot always; any bot by toggle; helpers never)
- [x] `spawn_bot` (asks first only for a helper on a different model), `delegate` (up to 5 tasks in parallel), `dismiss_bot`; `message_bot` for every bot
- [x] Coordinators use helpers on their own when a job has several independent parts (products, options, sources, sites): one short planning question to the model before the turn, a prompt rule, and a reminder after 3 own lookups; quick questions, file work and step-by-step jobs they do themselves
- [ ] Helpers on one local model take turns at the default "bots at once" = 1, so a 3-helper web job can take over 5 minutes; consider a higher default when VRAM allows
- [x] One level only: bots on a handed-over task get no hand-off tools (no chains or loops)
- [x] Stopping a coordinator stops its helpers
- [x] Helpers' approvals, questions and secret requests show in the coordinator's chat
- [x] Temporary helpers hide after the coordinator's turn, are deleted when dismissed or with their coordinator
- [x] Engine: one nudge when a model goes silent after using tools
- [x] Real-model eval (`evals/delegation.eval.ts`): qwen3.5:9b passes; nemotron-3-nano:4b completes but is sloppy with helper names
- [ ] Parallel helpers on the same local model run concurrently in Ollama (bypassing the app's "bots at once" limit)

## Bots on the web ✅

- [x] Real browser for bots (`playwright-core` driving installed Edge/Chrome, persistent bot-only profile, one tab per bot, window shown by default so you can watch and take over)
- [x] Tools: web_search, browser_open/read/click/type/scroll/back/screenshot/handoff; pages come back as text in parts plus numbered elements
- [x] Human checks, sign-ins and payments go to the user (browser_handoff); never typed: passwords, card numbers; "Buy/Send/Delete…" clicks ask first; the automated browser is never disguised
- [x] web_search: in the browser (Bing → DuckDuckGo, unrelated results rejected), Brave Search API, or SearXNG (Settings → Browser & search)
- [x] fetch_url says when a page is a JavaScript shell (points to browser_open) or a 404 (don't guess addresses)
- [x] Screenshots reach vision models; tool results carry images
- [x] Live view in the chat's Browser panel (about one frame a second; click, type and scroll into the bot's tab, also when the window is hidden; tabs for helpers)
- [x] `browser_sign_in`: the app types a Vault login into a sign-in form (asks first); the password never reaches the model or page snapshots; only on the login's own site (or subdomains) and over https

## How bots work ✅

- [x] Default context 32k (64k fits a 12 GB GPU fully); Local model page warns when the model spills onto the CPU
- [x] Old tool results are shortened mid-turn instead of letting the runtime drop the system prompt
- [x] Plan checklist (`update_plan`), shown live as one card per reply
- [x] Self-check once before the final answer of a tool-heavy task ("After checking:" only when something changed)
- [x] Step budget setting (default 25); out of steps → one last summary of what was found
- [x] Delegation pipelines: `include_results_from` attaches earlier helpers' answers
- [x] Prompt: environment facts, cite sources, save lasting lessons with remember; PowerShell 5.1 named in run_command
- [x] Cut-off written tool calls are asked for again instead of shown; dropped tool prefixes accepted ("click" → browser_click)
- [ ] Hybrid models: a cloud model for coordinating, local for helpers, made the easy default

## Results you can look at ✅

- [x] Tables in replies: sort by column (numbers sort as numbers), copy or download CSV
- [x] Download a reply as Markdown
- [x] Library page in the sidebar

## Evals ✅

- [x] `evals/suite.eval.ts`: offline fixture-shop tasks (search box, no guessing, plan, coordinator pipeline) + `--live` real-web task; Markdown reports in `evals/results/`

## Visual Bot ✅

- [x] "+ → New Visual Bot": a bot that uses the web only by looking (screenshot → decide → act → screenshot)
- [x] Screen tools: screen_look (numbered boxes drawn on what can be clicked/typed into), screen_click (box), screen_click_at (pixels), screen_type, screen_press, screen_scroll, screen_back, screen_go_to (home pages only); every action answers with a fresh screenshot and the address bar
- [x] No text tools for Visual Bots (no fetch_url, web_search, page text, link lists, commands); "Buy/Send…" clicks ask first; never types passwords (browser_sign_in / handoff instead)
- [x] A red dot shows where it's about to click (window and Browser panel); a new Visual Bot opens with its Browser panel
- [x] Coordinators can spawn Visual helpers (`spawn_bot` with visual)
- [x] Only the latest 2 screenshots stay in the conversation (user-attached pictures are kept)
- [x] Evals: visual-shop (offline), visual-google and visual-youtube (live)
- [x] Faster moves: thinking off between moves, one short sentence before each action (MiMo reads a screenshot in about 1 s; long narration was the slow part)
- [x] `screen_watch`: a short clip (2–6 frames over a few seconds) to follow videos and pages that change
- [x] Live video in the Browser panel (Chrome screencast, up to ~15 fps while the page changes; falls back to stills when idle)
- [ ] True realtime vision: not possible with local models today (Ollama takes still images, ~1.5 s per look on an RTX 4070)

## Discussions (clusters) ✅

- [x] "+ → New cluster": 3–5 bots discuss a topic toward a goal (explore, decide, research); the app proposes the team and roles, or you pick them
- [x] A moderator on the shared model picks who speaks next; pause, step, stop and steer from the control panel
- [x] Rules for every turn: back each claim with a source opened in this discussion or checkable reasoning; research-only tools, at most a few lookups per turn
- [x] Summary at the end in a fixed shape per goal; links the bots never opened or wrote are marked "no address given"

## Races ✅

- [x] "+ → New race": 3–5 racers (each on the shared model or its own) do the same task alone, in their own threads
- [x] A judge scores them on criteria it picks, names a winner and compiles the final result from the best parts; Judge now / Stop

## Fixes from the code audit

- [x] Fix what the code audit found ([audit](design/audit-2026-11.md)); three items are only partly done

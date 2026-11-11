# FreeBird — Roadmap

Built from scratch, no fork. `[ ]` = open, `[x]` = done.

## Research & decisions

- [x] Research Grok Bot (xAI): features and interface
- [x] Research the Ollama API
- [x] Decide fork vs greenfield → **greenfield**
- [ ] Decide Electron vs Tauri for the long term, mobile, and how much must work offline
- [ ] Get Grok Bot screenshots or a recording for visual details
- [x] Benchmark tool-capable Ollama models with `pnpm --filter @mrog/harness eval`: qwen3.5:9b and nemotron-3-nano:4b pass 3/3 file tasks; llama3.2:1b is unreliable (recommend ≥ 4B)
- [ ] Run the eval's shell task (`--allow-commands`) on a spare machine: it lets a model run commands unattended, so it isn't part of the regular runs

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
- [ ] Computer verified against a live Docker (so far tested against a fake Docker runner)
- [ ] Teach a task by screen recording (written steps only for now)
- [ ] Voice chat (calls), local speech-to-text without a provider
- [x] OAuth sign-in flows for apps (OAuth with PKCE through the user's browser; see "Apps, secrets and the browser" below)
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
- [x] `delegate` makes a helper for a name nobody has (on the model already in use, so no approval; at most 6 helpers; never in a group chat), because models that skip `spawn_bot` otherwise retry "No teammate is called X" until they give up; a name that differs only in case, spacing or punctuation means the existing bot
- [x] A coordinator's conversation with a helper or teammate is a **Bot conversation** in the sidebar, not a group chat, and the helper's prompt no longer says it is in a group chat with the user
- [x] The planning question before a coordinator's turn always switches thinking off for Ollama models (MiMo and Ornith don't report that they think)
- [ ] The `delegate` auto-create path is covered by tests but not yet seen in a live run of a model that skips `spawn_bot` (MiMo v2.6 created helpers with `spawn_bot` in the one run made)
- [ ] No shared team group chat for a coordinator and three or more helpers: each helper sees only its own task (its own conversation), and a shared thread would need per-helper filtered histories
- [x] One level only: bots on a handed-over task get no hand-off tools (no chains or loops)
- [x] Stopping a coordinator stops its helpers
- [x] Helpers' approvals, questions and secret requests show in the coordinator's chat
- [x] Temporary helpers hide after the coordinator's turn, are deleted when dismissed or with their coordinator
- [x] Engine: one nudge when a model goes silent after using tools
- [x] Real-model eval (`evals/delegation.eval.ts`): qwen3.5:9b passes; nemotron-3-nano:4b completes but is sloppy with helper names
- [ ] Parallel helpers on the same local model run concurrently in Ollama (bypassing the app's "bots at once" limit)

## Parallel Bots ✅

- [x] One request, one reply: the model picks three roles for the question and answers as each in three sections; the app adds the instruction to that one request only, offers no tools, and skips planning and history summaries so nothing else is asked
- [x] The mode follows the user's newest unanswered message (so Try again, a queued turn and Switch model keep it); nothing is steered into a Parallel Bots reply and no Parallel Bots message is steered into a running one
- [x] A tolerant section reader (`##`, `###`, bold, "Agent 1:", streaming prefixes, code blocks), three cards that fill as the reply streams, and the plain reply when it didn't come out in sections
- [x] `evals/parallel.eval.ts`: six questions per model, scored on three sections, three different roles and an answer in each
- [ ] Checked on 9B models only so far; try 12–30B with the eval and tune the instruction if needed
- [ ] No automatic second request for a missing section (strictly one request); a reply with fewer than three sections is shown as written, with a note to send the question again (a finished reply has no Try again)
- [ ] Roles are always invented for the question; picking three of the user's own bots (with their instructions and memory) isn't built
- [ ] No tools in this mode; "use tools first, then write the three sections" would need a second kind of turn
- [ ] A long chat is trimmed to what fits, not summarised, in this mode (a summary would be a second request)
- [ ] Not offered in group chats, clusters or races

## Bots on the web ✅

- [x] Real browser for bots (`playwright-core` driving installed Edge/Chrome, persistent bot-only profiles, one tab per bot, window shown by default so you can watch and take over)
- [x] Tools: web_search, browser_open/read/click/type/scroll/back/screenshot/handoff; pages come back as text in parts plus numbered elements
- [x] Human checks, sign-ins and payments go to the user (browser_handoff); never typed: passwords, card numbers; "Buy/Send/Delete…" clicks ask first; human checks are never solved by the app
- [x] "Look like an ordinary browser" (default on): no `--enable-automation` (so no `navigator.webdriver`, no automation bar) and no "Headless" in a hidden window's user agent; no CAPTCHA solving, fingerprint faking or proxies
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
- [x] Evals: visual-shop, visual-explore and visual-missing (offline), visual-google and visual-youtube (live)
- [x] Faster moves: thinking off between moves, one short sentence before each action (MiMo reads a screenshot in about 1 s; long narration was the slow part)
- [x] `screen_watch`: a short clip (2–6 frames over a few seconds) to follow videos and pages that change
- [x] Live video in the Browser panel (Chrome screencast, up to ~15 fps while the page changes; falls back to stills when idle)
- [ ] True realtime vision: not possible with local models today (Ollama takes still images, ~1.5 s per look on an RTX 4070)
- [x] Audit fixes: a click that would land on a control that asks (under a pop-up or banner) is refused; checkboxes named by their label, not "on"; invisible reCAPTCHAs and articles about "security checks" no longer count as human checks; a Visual Bot on an Ollama model without vision says so; exact tool names; password-marked fields refused
- [ ] `screen_go_to` says "home pages only" but doesn't enforce it: in evals MiMo and Qwen opened guessed deep addresses (a Google search URL, made-up GSMArena pages), which brought CAPTCHAs and 404s
- [ ] Controls inside frames and shadow DOM get no box (clicks there can't be judged, so they ask), and typing into a field inside a frame is refused
- [ ] `screen_watch` keeps the tab for up to 30 s after Stop; Enter and Space are judged by what had focus when the card was made, not when the key is pressed
- [ ] Evals: Google answers repeated automated searches with a CAPTCHA, so `visual-google` measures Google's block after a few runs; it needs another first step

## Discussions (clusters) ✅

- [x] "+ → New cluster": 3–5 bots discuss a topic toward a goal (explore, decide, research); the app proposes the team and roles, or you pick them
- [x] A moderator on the shared model picks who speaks next; pause, step, stop and steer from the control panel
- [x] Rules for every turn: back each claim with a source opened in this discussion or checkable reasoning; research-only tools, at most a few lookups per turn
- [x] Summary at the end in a fixed shape per goal; links the bots never opened or wrote are marked "no address given"

## Races ✅

- [x] "+ → New race": 3–5 racers (each on the shared model or its own) do the same task alone, in their own threads
- [x] A judge scores them on criteria it picks, names a winner and compiles the final result from the best parts; Judge now / Stop

## Trust & robustness

- [x] Approvals expire (15 min) as `timeout`, told to the bot as "nobody answered" (not "the user denied"); each decision records who made it (user, rule, policy, group chat, timeout, stopped); answer, Stop and the clock can't settle a card twice
- [x] Stream-idle watchdog: a cloud model silent for 5 min before its first chunk, or 3 min between chunks, ends as `stalled` (not as a user Stop) and frees the shared model; a local model gets 20 and 10 min (cold loads, long prompts and long tool calls are quiet for minutes); the clock starts after the model slot is acquired
- [x] No-progress guard: the same call with the same result 3 times in a row (pictures included) ends the turn with a summary
- [x] Restart recovery: cards nobody can answer are closed; a chat mid-way through an outward action (marked on the message _before_ the call runs, and on the coordinator's hand-off when a helper acts) ends as an error that says so, not as "stopped"
- [x] NDJSON event log per chat, redacted, rotated, bounded, removed with the chat (`MROG_EVENT_LOG=off` turns it off)
- [x] Bot computers get a process limit, a memory limit and no raw sockets or device nodes
- [x] CI: actions pinned to commits, one `CI` job to require
- [ ] Verify the computer limits against a live Docker (so far only the arguments are tested; the image's init runs as root and bots use `sudo`, which is why `--cap-drop ALL` and `no-new-privileges` are not applied)
- [ ] Tune the watchdog limits on real hardware (the local 20 / 10 min and cloud 5 / 3 min are estimates); make them settings
- [ ] A Settings switch for the event log (today only `MROG_EVENT_LOG=off`), and consider default-off; scrub deleted bots' instructions from `_app.ndjson`
- [ ] Show who decided an approval (the `decidedBy` mark is saved on the message but not yet shown)
- [ ] Questions (`ask_user`) can't time out; a long-unanswered one still holds its turn
- [ ] Persisted record of each turn (state per transition) and a way to read the event log in the app
- [ ] Publish a `SHA256SUMS` and a packaged-app smoke test in CI

## Chat and bots

- [x] Per-bot tool lists (`allow` / `exclude`, exclude wins, `name*` for a family): Details → Tools, filtered before the model sees them, with a prompt note and with the coordinator and browser guidance dropped when their tools are off
- [x] Questions with choices (`ask_user` `options`, `multiple`): one tap, ticks, or typed; several picks kept one per line
- [x] Errors in plain words with actions; `POST /api/threads/:id/retry` (answers again without a new user message; refuses a reply that may already have acted, one that is not the latest, a non-member bot)
- [x] Slow-first-reply rescue (UI only, timed from the reply's own creation, longer for local models, nothing while queued); Switch model restarts the reply
- [x] Unread badge, title count and "New messages" line (per viewer, counted while the app is open)
- [x] Tail window over long chats (grows only; includes the first unread message)
- [x] Aging in the model queue (one rank per minute waited, never beyond a user's chat)
- [x] Focus trap in dialogs (only the top layer; menus and nested dialogs keep their own keyboard)
- [ ] Unread counts are cleared when the app restarts, and replies that arrived while it was closed are never counted: the packaged app's address changes each launch, so browser storage doesn't carry over (the compact-sidebar choice has the same limit). Keeping "what the user last saw" on the server would fix both
- [ ] Bot templates don't carry tool lists yet
- [ ] Long chats are windowed, not virtualized; `content-visibility` was left out because it fights the scroll anchoring
- [ ] The slow-reply limits (20 s, and 90 s for a local model) are estimates; make them settings
- [ ] An allow list can be set through the API but not in the Details panel
- [ ] A question can't time out; a long-unanswered one still holds its turn
- [ ] Verified in Edge against a scripted fake Ollama; not yet checked in the Electron shell or on macOS and Linux

## Apps, secrets and the browser

- [x] MCP OAuth with PKCE: SDK auth provider, dynamic client registration, loopback callback (`/oauth/callback`, single-use 10-minute state, escaped page with a strict CSP), tokens in the keychain bound to the server address, refresh, forgotten on address change or removal; "Needs you to sign in" + **Sign in** in Settings
- [x] Per-bot app grants (`tools.apps`: full / read / off) from `readOnlyHint` / `destructiveHint`, checked against a verb heuristic (stricter wins; unclear counts as a change); destructive tools always ask; helpers capped by their maker's list and grants
- [x] Big app results kept per bot and chat (LRU, 100 entries / 8 MB) with a shape summary and `query_result` (paths, filters, search, lines); dropped with the chat or bot
- [x] Secret scrubber over tool output, app results, errors and the event log (raw, percent, JSON, base64, Basic, card forms; 8 characters minimum), refreshed when secrets change
- [x] `run_command` `secrets`: name the secrets one command gets; the card always asks
- [x] Per-bot browser profiles (`browser-profiles/<bot>`, helpers share their maker's, a race or cluster shares one; at most 3 at once, LRU closed only after 2 minutes unused, busy, waiting or watched never; deleted with the bot or race, orphans swept at start; existing installs stay shared); open a bot's browser from the Browser panel, which has an address field now
- [x] `MCP_OAUTH_` and `VAULT_ITEM_` entries are never given to commands or requested by bots; apps with a pasted `Authorization` header never go through OAuth
- [ ] Sign-in for stdio apps that use OAuth (only HTTP apps go through the flow)
- [ ] A grant setting per tool (today per app), and showing in the UI which hint or name decided a tool's kind
- [ ] Moving sign-ins from the shared profile into a bot's own (today the user signs in again)
- [ ] Per-bot profiles checked with several real Edge windows at once (the profile manager is tested against a stand-in browser; real Edge is tested shared)

## Fixes from the code audit

- [x] Fix what a November 2026 code audit found; three items are only partly done

## Second code audit (0.0.5)

- [x] Approvals: typed line breaks ask like Enter; Visual Bots type only into text boxes; "Always allow" matches the exact action; a connected app's card shows the whole call (no "Always allow" when cut off or irreversible); the `run_command` card shows its folder
- [x] Leaks: card, security-code and password fields are masked in screenshots and absent from the screen map; chat images load on request; no key is stored or sent for a server that takes none; racers can't wait on cards nobody sees
- [x] Robustness: `fetch_url` is linear and capped; bots in one browser profile get separate tabs; queued turns re-read the bot and obey Stop; a routine started before the app closed doesn't run again; secrets granted mid-turn reach `run_command`
- [x] Secrets limited to 1,280 characters everywhere; big OAuth sign-ins stored in pieces
- [x] Connected apps: distinct names for colliding tools, a dead connection shows as an error, paginated tool lists read in full, stricter verb classification
- [x] Discussions: deleting an expert doesn't end it; known links survive backticks, bold and quotes; the user's own links count as known
- [x] UI: no lost streamed text, a Reload fallback instead of a blank window, AltGr keys aren't shortcuts, group chats work with per-bot models, a question card doesn't steal focus
- [x] The webhook address keeps its port between launches
- [ ] About 50 lower-severity findings (input-method Enter in CJK text, event-log leak of passwords with a quote, recursive MCP schemas, `edit_file` on multi-line text in CRLF files, commands waiting on stdin, silent errors in some settings controls, the race word count for CJK)
- [ ] Connected apps reconnect by themselves; the OAuth callback hides error text unless the sign-in state is valid; a history that starts with an orphan `tool_result` for Anthropic; deleting old keychain entries for providers that take no key
- [ ] Tests for the desktop shell's saved port and for the chunked sign-in storage against the real Windows keychain

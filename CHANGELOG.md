# Changelog

All notable changes to FreeBird. The format follows [Keep a Changelog](https://keepachangelog.com), and the project uses [semantic versioning](https://semver.org).

## Unreleased

### Added

- **Choose which tools each bot has.** **Details → Tools** lists a bot's tools by area with a switch for each. Everything is on until you switch it off; fewer tools means a shorter prompt, which helps small local models pick the right one. A tool that is off isn't just hidden: the bot is told it can't use it, and a call to it by name finds nothing to run. Bots made before this keep every tool.
- **One-tap questions.** A bot can offer choices when it asks you something: tap one to answer, or tick several (**multiple choice**) and send. You can always type your own answer instead. A question that arrives while you are typing doesn't take the keyboard from you.
- **Errors in plain words, with a way out.** "I couldn't reach the model" instead of `ECONNREFUSED 127.0.0.1:11434`, with **Try again**, **Switch model** or **Open settings** where they help, and the original text behind **Details**. **Try again** answers your message afresh without sending it twice, and is never offered on an old reply, or on one that may already have done something (the server refuses it too).
- **A slow first reply gets a way out.** After 20 seconds without a word the chat says so. A cloud model then offers **Try again / Switch model / Keep waiting**; a model on your computer, which can legitimately take a minute to load, gets a note first and the buttons after a minute and a half. Nothing is offered while the reply is just waiting for another bot to finish with the model. **Switch model** picks a model and starts the reply over with it.
- **Unread dots.** A chat shows how many replies arrived while you were elsewhere (a badge, a bolder name, a dot in the compact sidebar, and a `(3)` in the window title), and the chat opens with a **New messages** line above the first one. Counted while the app is open, and cleared when it restarts (the packaged app uses a new local address each launch, so the browser storage it is kept in doesn't carry over; running from source with `pnpm dev` keeps it).
- **Long chats stay fast.** Only the newest 120 messages are drawn, with earlier ones drawn as you scroll up; a new reply never makes the page jump while you are reading older messages.
- **Dialogs keep the keyboard.** Tab and Shift+Tab go round inside an open dialog instead of out to the page behind it, and Escape returns you to where you were.
- **Sign in to connected apps.** An app (an HTTP MCP server) that asks for a sign-in shows **Needs you to sign in** in **Settings → Connect apps**, with a **Sign in** button. You sign in in your own browser and come back to FreeBird; nothing opens on its own. It uses OAuth with PKCE. The sign-in is kept in your keychain as `MCP_OAUTH_<APP>`, refreshed when it runs out, tied to the app's address (change the address and the old sign-in is never sent to the new one), and deleted when you remove the app. Apps you gave a token in an `Authorization` header work as before, and a refused token now says so in plain words.
- **Read-only access to an app, per bot.** **Details → Tools** gives each connected app a choice: **Can make changes**, **Read only** or **No access**. What counts as reading comes from what the app says about each tool (MCP `readOnlyHint` and `destructiveHint`), checked against the tool's name: when the two disagree, the stricter one wins, and a tool that says nothing and has an unclear name counts as making changes. A tool that can't be undone asks you every time, even from an app set not to ask. A helper never gets more than the bot that made it.
- **Big app results don't flood the chat.** A result longer than about 4,000 characters is kept aside and the bot gets its shape and a preview, plus `query_result` to pick out what it needs (a path such as `messages[0:5].subject`, a search, or a range of lines). Kept results go when the chat is cleared or deleted.
- **Secrets stay out of what bots see and what is logged.** The values of your saved secrets, logins, cards and app sign-ins are replaced with `[hidden]` in command output, app results, error text and the event log, including encoded forms (percent- and JSON-escaped, base64, and `user:password` sign-ins). Values shorter than 8 characters aren't matched, since they would hide ordinary words.
- **Secrets given to one command.** A bot names the secrets a single `run_command` needs, and the approval card says so ("with your secrets: GITHUB_TOKEN"). Only those reach that command, and only if the bot was given them. This card always asks, even when commands are set to run without asking.
- **Each bot has its own browser.** By default, sites you sign in to for one bot aren't open to the others: each bot's tab opens in its own browser profile, and its helpers use the same one. Sign in for a bot from its chat: **Browser panel → Open Ada's browser**, then type the address into the panel (it has an address field now) or use the window. The bots of one race or cluster share one. At most three browsers run at once; one nobody has used for two minutes closes to make room (the one used longest ago), and a browser in use, waiting for you or being watched is never closed. Deleting a bot (or a race) deletes its profile. Installs that already used the browser keep one shared profile until you switch in **Settings → Browser & search → Sign-ins**. Switching closes the browser, and sign-ins aren't moved between profiles.
- **The bots' browser looks like an ordinary browser to websites** (Settings → Browser & search, on by default). It no longer sends what only automated browsers send: the automation switch behind `navigator.webdriver` and the "controlled by automated software" bar, and "Headless" in a hidden window's name. Fewer sites stop bots with checks. Checks that still come are handed to you, as before; nothing solves them or fakes who is browsing. Switch it off to have the browser say it is automated.
- **Solve a check and the bot carries on by itself.** When a bot hands you a CAPTCHA or "verify you're human" check, the window comes to the front, and once you've solved it the bot notices the check is gone and goes on. No need to reply "done" (you still can). Sign-ins and payments still wait for your reply, since only you know when they're done.
- **A notification when a bot needs you.** With **Notify me** on for a bot, you get a desktop notification when it starts waiting for you (a check, a question, an approval) while you're in another chat or app.
- **Visual Bots search on Bing first.** Google stops automated browsers with checks far more often, so Visual Bots start at bing.com and use Google only when you ask.
- **Waiting turns don't starve.** A routine or background job that has waited for the shared model is treated as more urgent each minute, so a busy conversation can no longer keep it out for as long as the conversation lasts.

- **A bot that goes round in circles stops.** The same tool call with the same result three times in a row ends the turn with a summary of what was found and a note, instead of using up every step. Calls that repeat on purpose (scrolling, looking at a changing page) are not affected, because what they return differs.
- **A model that goes silent is cut off.** A cloud model that sends nothing for 5 minutes at the start, or 3 minutes in the middle of a reply, ends with a "stalled" error instead of waiting for ever. A model on your computer gets much longer (20 minutes, and 10 in the middle), because loading and reading a long prompt, or writing out a long tool call, is legitimately quiet for minutes. A stalled request frees the shared model. Pressing Stop is unchanged and still shows as stopped.
- **An approval card that nobody answers expires** after 15 minutes. The bot is told that nobody answered (not that you said no), so it doesn't treat silence as a refusal. Each decision records who made it: you, a saved rule, the command policy, the group-chat rule, the clock or Stop.
- **A restart no longer hides what was happening.** Cards that could no longer be answered are closed, and a chat that was in the middle of something that changes things outside the chat (a command, a connected app, a click that acts) ends as an error that says so, so it isn't repeated by accident. Everything else still ends as stopped.
- **An event log** for working out what went wrong: `<data folder>/logs/<chat>.ndjson`, one line per event. Keys and tokens are redacted and pictures left out. It is a copy of the chat, so Clear chat and deleting a chat or bot delete it too. It is on by default and can be turned off with `MROG_EVENT_LOG=off`. See [Privacy & security](docs/privacy-and-security.md#the-event-log).
- **CI**: actions are pinned to commits, and a single `CI` job to require in branch protection.

### Changed

- A bot's computer (Docker) is created with a process limit, a memory limit and without raw-socket and device-node privileges. Existing computers get these when you press **Reset**.

### Fixed

- **A Visual Bot's click can no longer land on something that should have asked.** It clicks by position, so a pop-up, cookie banner or see-through layer over the box it chose would take the click, and the approval had been judged by the box underneath. Now a click that would land on something that asks first (Subscribe, Accept all) is refused, and the bot is told what covers the box.
- **Checkboxes are named by their label.** The screen map and page readings named most checkboxes "on" (their value), so ticking "I agree to the terms" didn't ask first. It does now.
- **Ordinary pages aren't taken for human checks.** Many sign-in, shop and contact pages carry an invisible reCAPTCHA or a hidden captcha field, and an article could mention a "security check"; either one stopped bots clicking anything on the page. Only a check you can see, or a short challenge page, counts now.
- **A Visual Bot on a model that can't see says so.** It used to try with no pictures and no text tools to fall back on. Now the reply says the model can't see pictures and offers **Switch model** (for Ollama models, whose abilities are known for sure).
- **A field marked as a password is treated as one** even when the site shows it as plain text ("show password"): bots don't type into it.
- A Visual Bot whose browser is switched off in Settings is told so, instead of not knowing it is a Visual Bot.
- A Visual Bot's tools are matched by exact name, so a connected app named "screen" or "browser" can't add tools to it.
- An error that merely contained the letters "oom" ("boom", "room", "bloom") was reported as the model running out of memory. Only memory trouble, or the word "OOM" on its own, is now.

## 0.0.2 - 2026-11-03

### Changed

- **Races run one racer at a time on a local model again.** Each racer keeps the model until it has finished, then the next one starts, instead of the racers trading the model after every step. That avoids re-reading each racer's conversation, and switching models in the middle of a racer's work when racers use different local models. Raise **Bots at once** to run several racers at the same time.

### Fixed

- Deleting a bot no longer announces a change to its computer when it never had one.

## 0.0.1 - 2026-11-03

The first public version.

### Added

- **Bots you chat with like coworkers**: a messaging-style app with a Primary Bot, sections, pinning, hidden bots, avatars, instructions and a per-bot model.
- **Local models first**: one shared Ollama model serves every bot, with warm-up, `keep_alive`, identical options and a priority queue. LM Studio, vLLM, llama.cpp, Jan and LocalAI presets.
- **Any API provider** with your own key: OpenAI, Anthropic, Google Gemini, Groq, xAI, Mistral, DeepSeek, OpenRouter, Together AI, Fireworks AI, Cerebras, Azure OpenAI, Ollama Cloud, and any OpenAI- or Anthropic-compatible server. Keys in the OS keychain.
- **Races**: 3–5 bots do one task independently; a judge scores them and compiles the best result.
- **Clusters**: moderated debates between 3–5 expert bots with source-checked claims and a goal-shaped summary.
- **Coordinators and helpers**: the Primary Bot creates helper bots on its own when a job splits into parts, delegates in parallel and combines the answers.
- **Agent tools with approval cards**: files, terminal commands, web pages, questions, plan checklists, memory.
- **A real browser** (Edge/Chrome) with live view and takeover, web search, secure sign-in with vault logins; **Visual Bots** that browse by looking.
- **A Docker computer** per bot with live view.
- **Group chats** with @mentions and bot-to-bot threads.
- **Routines**: weekly, interval, once, webhook and manual triggers, a weekly calendar, Teach a task.
- **Connect apps** through MCP servers with per-tool toggles.
- **Vault** for logins, cards and contact info, CSV import, secure secret cards.
- **Memory you can view and edit**, skills, bot templates, Library, sortable tables with CSV export, voice dictation and read-aloud, command palette and keyboard shortcuts, usage meter.

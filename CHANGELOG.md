# Changelog

All notable changes to FreeBird. The format follows [Keep a Changelog](https://keepachangelog.com), and the project uses [semantic versioning](https://semver.org).

## 0.0.16 - 2026-11-16

### Added

- **Visual QA for the Coding Bot.** A new switch (off by default, in the new Coding Bot dialog and in the panel next to **Auto-approve**). With it on, once every card has passed and the whole-project check finds nothing, QA starts the app, opens it in its own browser tab and uses it like a person, taking screenshots, clicking, typing, and checking the console and the controls. It adds to QA's other checks and replaces none of them.
  - **How the app starts:** web pages are served by FreeBird itself. Apps with a server (Flask, Django, FastAPI, Streamlit, Gradio, Node, Express, Vite, Next.js) are started with their own command, which asks first like any command. Desktop apps (Tkinter, PyQt, Electron and others) are checked for starting and staying open.
  - **The automatic checks (no model needed):** a crash or traceback on start, browser console errors, files that fail to load, buttons that do nothing when clicked, and buttons covered by something else.
  - **What gets sent back:** everything the automatic checks find, plus what QA saw going wrong. Each problem goes back to the card it belongs to.
  - **QA's model:** it needs vision for screenshots. Without vision, QA tests from the screen map and console, and the panel says so.

### Changed

- **New logo**, with a transparent background: the app icon, the installer and the logo inside the app.

## 0.0.15 - 2026-11-16

### Changed

- **One local model in memory at a time.** When bots use different local models (a Coding Bot's Planner, Developer and QA, say), each is loaded for its own turn and the others are unloaded first; bots on the same model share it. On by default in **Settings → Local model → One model at a time**; turn it off if your GPU fits several models. It never unloads a model another bot is still replying with.

### Fixed

- **Changing a Coding Bot role's model frees the old one.** Unloading only happened for the shared model and a bot's model menu; now any model change (a team's roles, a deleted bot) unloads a model nothing is set to use any more.

- **Gemini 3 models work with tools.** Gemini 3 gives each tool call a "thought signature" that must come back with the call on the next request; FreeBird dropped it, so any bot using tools on Gemini 3 failed on its second step ("Function call is missing a thought_signature"). The signature is now kept with the call, saved with it in the chat, and sent back.

## 0.0.14 - 2026-11-16

### Added

- **Bots use skills by themselves.** With **Can use skills** on (the default, in **Details → Skills**), a bot looks up the skill that fits a task (`find_skills`) and follows it (`use_skill`); each use shows in the chat. A Coding Bot's switch covers its Planner, Developer and QA, which each use the skills their work needs. Skills now have a "when to use" line, and typing `/name` still runs one.
- **40 built-in skills**, shared by every bot: writing, coding, research, business, planning and data. Each is written to one standard: an expert role, rules with reasons, the steps, an exact output format and a final checklist. You can edit or delete them; a deleted one doesn't come back, and an unedited one gets the newer text when a later version improves it.

### Changed

- **Models no longer hold your memory after you're done.** Changing the shared model unloads the old one before loading the new one, and a bot switched to another model unloads its old one, unless the shared setting or another bot still uses it (a reply being written on it finishes first). Closing FreeBird unloads every model it loaded and stops Ollama if FreeBird started it. Both are switches in **Settings → Local model → When FreeBird closes**, on by default. An Ollama you started yourself is never stopped.

## 0.0.13 - 2026-11-15

### Added

- **Client Bot.** **+ → New Client Bot** makes a bot that interviews you about what you sell and who your ideal client is, then finds businesses that may need it, only when you ask. It never searches for your service by name, which finds competitors; it looks for signs that a business needs you instead (hiring for your kind of work, opening a new site, raising money, asking for a provider). Leads come in three kinds: **asking now** (UK public tenders and "seeking a provider" posts), **with signs**, and **quiet fits** (good fits that never posted anything, from UK Companies House with your free API key and the UK food hygiene register). Quiet fits must be confirmed by an official record and their own website, and are re-checked for new signs each time you scan. Ready-made playbooks cover payroll, accounting, marketing, software development, IT support and recruitment, with a general one for anything else. Every fact and sign is quoted from its page or record. Contact routes are found by the app and are company-level only, never guessed. Your clients, competitors and do-not-contact list are never shown. Lookalikes of your best clients, a board from New to Won, CSV export, and suggestions from your reactions. Nothing is ever sent for you. See [the Client Bot guide](docs/client-bot.md).

### Changed

- **A new logo** for the app, its installer and the sidebar.

## 0.0.12 - 2026-11-14

### Added

- **Job Bot.** **+ → New Job Bot** makes a bot that interviews you about the job you want, then finds and checks jobs that fit you, only when you ask. Each scan asks how many new jobs to find and counts only jobs that match you (weaker ones still go on the board) and that you haven't been shown before. Every fact on a job card must be quoted from the posting it was read from ("Not stated" otherwise), and the match score is worked out line by line from your requirements, with warning signs such as old postings, no salary or scam wording. Pages are read the cheapest way that works (a job system's public list, the page as text, the bot's browser, then a Visual helper as the fallback), and a CAPTCHA or sign-in is handed to you. Reactions with a reason suggest profile changes you can accept. See [the Job Bot guide](docs/job-bot.md).

## 0.0.11 - 2026-11-14

### Added

- **API keys already on your computer are found for you.** Settings → Models & Providers lists keys set as environment variables for your account (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and the others) under **Found on this computer**, with one-click **Add**. The screen never sees the key; Add copies it into the keychain exactly as a pasted key would. Pasting a key works as before.

### Changed

- **Parallel Bots on a cloud model asks the three roles separately, at the same time.** Without Allow tools, a cloud model (ChatGPT, Claude, Gemini and the others) now gets one short request to pick the roles and then one request per role, all at once, so the answers fill in side by side and a role can't echo another; it uses about three times the input tokens. A local model still sends one request with three sections, and Allow tools is unchanged. Switch it off in **Settings → Local model → Parallel Bots on cloud models: ask each role separately** to use one request on cloud models too.

## 0.0.10 - 2026-11-14

### Security

- **Commands bots run no longer get FreeBird's access token.** Every command inherited the app's environment, including the token that unlocks its local API, so code run by an approved command (an install script, or code a bot wrote) could have switched approvals off. Commands now get a clean environment, and the app drops the token from its own environment after reading it.
- **Typed command rules can't be chained.** A Custom Rule for a terminal command only covers the command itself, so a rule for `npm` no longer lets `npm i; Remove-Item …` or a command with `|`, `&`, `$(`, brackets, redirects or `iex` through. This is stricter than before: commands such as `npm i -E`, `xcopy /e`, `node -e …` or `echo (Get-Date)` now show a card even if a rule used to allow them, and a `run_command` rule with no text only covers plain commands.
- **A Coding Bot's team only writes the files of its plan.** Writes to other files, to `.git`, `node_modules` or editor settings that run commands (`.vscode/tasks.json` and similar) are refused; plans can't list them either. Its roles can't read `.env` files or private keys. Its commands always ask, even with commands set to always allow.
- **Output folders can't be network paths** (`\\server\share`, `\\localhost\C$…`), names ending in a dot or space, or device names; such folders got past the folder rules, and one ending in a dot made commands run in the home folder.
- **A hostile plan file can no longer freeze the app** (the plan reader is linear and refuses more than 1 MB).

### Added

- **Parallel Bots can use tools.** With **Allow tools**, the three roles each run as their own conversation at the same time, each with its own web searches and pages, which the others never see; each card shows its own searches, steps, sources and answer. Two settings: roles writing at once (default 3) and steps per role (default 6). **Bots at once** and Races are unaffected.
- **A finished Coding Bot project can be changed**: type what you want changed, the Planner updates the plan, and only what changed is built again. A plan can also be imported after a project is done, stopped or failed, and a failed plan can be given a new brief.

### Fixed

- **The Coding Bot's Developer no longer gets stuck reading.** It was told to read files a later card writes, read up to 21 files per try and wrote nothing; now it only reads written files (at most 6 per try), is told when 3 rounds are left, retries are told what went wrong, a written file counts even without "finished", and model errors are retried instead of ending the project.
- **Stopping, clearing or deleting a Coding Bot's team conversation no longer leaves the project stuck** "working"; deleting, duplicating or renaming the team on its own is refused.
- **The whole-project check no longer fails normal TypeScript projects** (`import type`, `export interface`, `.js` imports of `.ts` files, commented `tsconfig.json`, missing images), and it catches more made-up keys (`OPENWEATHER_API_KEY`, `sk-proj-…`, `appid=` in a URL, `.env` lines).
- **QA's instructions no longer contradict themselves** about placeholders.
- **Bots in a bot-to-bot conversation** (a helper's or a Coding Bot role's) are no longer told to ask a short question when something is unclear, since nobody is there to answer: they make a sensible choice and say what they assumed.
- **The Coding Bot screen:** no desktop notification or unread count for each team reply; "Finished" and "Error" clear once seen; passes are no longer counted as failures; the panel no longer squeezes the chat away (it becomes a drawer in narrow windows); the message box's Stop stops the team; resetting the board on import has its own confirmation; big diagrams no longer draw lines behind boxes; plus focus, screen reader and export fixes.

## 0.0.9 - 2026-11-13

### Fixed

- **A Coding Bot could finish a project that didn't work.** In a real run, a weather app was "done" although its page loaded a file that uses `import` with a plain `<script>`, and its config held an invented API key. Four gaps are closed:
  - **Stale passes are re-checked.** After every Developer turn, any finished card that touches a changed file goes back to QA (the file's card and every connection linking it), not only when a file card is sent back.
  - **A whole-project check runs before "done".** Automatic checks look for plain scripts loading `import`/`export` files, missing files and imports, ids no page has, JSON that doesn't parse and key-like literals, and send the right card back with a comment. If they find nothing, QA gets one last turn to look across the files.
  - **QA remembers.** Its message includes what was said about the files around the card, and it is told which shell its commands run in (PowerShell on Windows, so no `&&`), and to check things for real.
  - **Nobody invents secrets.** The Developer and QA use a clearly marked placeholder such as `YOUR_API_KEY_HERE`; QA accepts it and fails a made-up key.
- **The closing message lists what you must do** ("Before you run it": add your own API key, open it through a local web server).

## 0.0.8 - 2026-11-12

### Changed

- **The Coding Bot's Developer is much faster and more focused.** A real run on a reasoning model took about 30 minutes and 1.5 million input tokens per card, because the Developer wrote other cards' files too, made helper and check scripts and re-read the whole project. Now each Developer turn is told to write only its own card's file and read only the files the card connects to, a write to another card's file is refused, it takes at most 15 steps, thinking is off for it on Ollama models, and it can't run commands (QA runs and tests the code, each command still asks you first).
- **A file the team already wrote in this project is not written again.** After a restart or Resume its card goes straight to QA, unless QA has already sent it back or the file is older than the project.

### Added

- **Time and tokens on every card**, with a live timer, a total in the panel header, and an amber **Slow** warning (with a log line and a note) when a card takes more than 10 minutes.

## 0.0.7 - 2026-11-12

### Added

- **Coding Bot.** **+ → New Coding Bot** makes a team of three roles, each on its own model, that builds a project in an output folder you choose: the **Planner** draws the files and how they connect, you approve the plan (or switch on auto-approve), the **Developer** writes it one card at a time, and **QA** checks every file and every connection, sending anything wrong back to Todo with a comment. It repeats until everything passes or the QA round limit (5 by default, changeable up to 20) is reached, then it stops and asks you.
- **A diagram, a board and a checklist** beside the chat: files as boxes with what their code should do, connections of any size as junctions, four board columns with QA's comments on the cards, and a checklist of every file and connection.
- **You can see what is happening:** who is working now, coloured and ringed boxes, a progress bar, a status banner with the next step, a sidebar badge and a desktop notification when it needs you, and an activity list.
- **Export and import the plan** (JSON, Markdown, Mermaid, SVG, project snapshot). Import a plan written by another model, with a preview and a warning for files that already exist. It still waits for your approval. **Copy planning prompt** gives you text to paste into a flagship model. See [Coding Bot](docs/coding-bot.md).
- **Choose a folder** in the desktop app with a Browse button.

## 0.0.6 - 2026-11-12

### Fixed

- **Clicking a helper bot opened a blank chat.** A helper's own chat with you has nothing in it, because its work comes from the coordinator, and the conversation was only in **Bot conversations** or inside the coordinator's chat, so it looked as if helpers never had a thread. Clicking a helper in the sidebar (or in the coordinator's **Details**) now opens its thread with the coordinator: the task it was given and its answer.

## 0.0.5 - 2026-11-11

### Security

- **Typing can no longer press a button.** A Visual Bot's text with a line break in it now asks for approval exactly like Enter does (it used to submit a form with no card), and `screen_type` refuses unless a real text box has focus, so a space can't click a focused "Pay now" button or tick a box.
- **Card numbers typed during a handoff no longer reach the model.** Card number, security code and password fields (also a "show password" box and `billing cc-number`-style autocomplete values) are blacked out in every screenshot and left out of the list of page elements.
- **"Always allow" means that exact action.** It used to match anything that began the same way, so allowing `Fetch http://192.168.1.1` also allowed `http://192.168.1.10/admin`. Rules you type in Custom Rules still match a start; saved rules from before keep working.
- **A connected app's approval card shows the whole call.** It cut the arguments at 200 characters, so a long message could hide a `bcc` after the cut, and "Always allow" saved the cut text. The card now shows up to 2,000 characters, says how much is hidden past that and then doesn't offer "Always allow", which is also no longer offered for an irreversible call.
- **The `run_command` card shows the folder** it runs in, with the "Outside the bot's folder" badge when it is elsewhere.
- **Connected-app tools with similar names can't be mixed up.** `list.items` and `list_items` used to get one name, so a read-only bot could pass a check on one and run the other. Colliding names now get a short suffix.
- **A web page can no longer freeze the app.** `fetch_url` converted pages with patterns that took minutes on a hostile page of about 1 MB; it is now linear and capped at 400,000 characters.
- **Bots sharing a browser profile no longer end up in one tab**, where one bot's numbered boxes could be clicked by another.
- **A key typed for a provider that takes none is no longer stored or sent.** Switching the preset in Add provider also clears the key and name fields, and the server ignores a key for a server that needs none.
- **Chat images load on request.** An image a reply links to on the web isn't fetched until you press **Load image**.
- **Racers can't wait for approval cards** nobody can see; a call that needs one is refused at once, and the model slot stays free for the others.

### Fixed

- **Secrets granted during a turn now reach `run_command` in that turn** (and are hidden in its output). The bot used to be told "You haven't been given NAME" and asked again until it ran out of steps.
- **Secrets longer than the Windows limit** (1,280 characters) get a clear message instead of "keychain could not be used" or a stuck card. Connected apps that issue large tokens (Microsoft, Atlassian) can now sign in and refresh: their sign-in is stored in pieces.
- **Queued messages behave.** A message waiting behind a running reply uses the bot's current tools and instructions, Stop and Clear chat cancel it, and several messages sent during a Parallel Bots reply get one answer instead of one each. A routine or helper hand-off is never answered in Parallel Bots mode.
- **A routine that was running when the app closed doesn't run again** at the next start.
- **The "prepare the turn" step no longer times out while waiting for the model** that other bots are using.
- **`delegate` no longer makes a helper when the coordinator's `spawn_bot` switch is off.**
- **Deleting an expert mid-discussion doesn't end it:** the others carry on to the summary, and the deleted expert's lines and links stay (labelled "A former expert").
- **Summaries and judge reports keep real links** wrapped in backticks, bold, quotes or ending with `…` or `。`, accept `HTTPS://` in capitals and addresses you gave yourself. Three unrelated failed replies spread over a long discussion no longer end it, and a failure while writing the summary no longer leaves the thread on "working".
- **Streamed text is no longer lost** when you open a chat whose bot is mid-reply, a reply can't stay on "streaming" forever, and a missing part no longer blanks the window (there is a Reload fallback).
- **AltGr keys** (`[`, `]`, `{`) are no longer swallowed by shortcuts on German, Nordic and Portuguese keyboards.
- **Group chats work when each bot has its own model** and no shared model is set.
- **A question without choices doesn't take focus** while you are typing in the message box.
- **A connected app whose program quits is shown as an error** instead of staying "connected", paginated tool lists are read in full, and `resolve_…`, `check_…`, `trash_…`, `rm_…`, `discard_…` and similar names are classed correctly (changes, not reads).
- **The routine webhook address keeps its port** between launches (another port is used only if it is taken).
- **Short answers from Ollama thinking models** (history summaries, group-chat routing) are no longer empty, and Anthropic bots no longer fail with a 400 when a conversation starts with the bot's own message.
- **A helper the coordinator created but never gave work had no thread to look at.** The conversation between a coordinator and a helper was only created when the first task was handed over, so a coordinator that made helpers and then did the work itself left nothing in **Bot conversations**. Now every helper gets its thread with the coordinator the moment it is created (empty until it has work), and `spawn_bot`'s reply tells the model plainly that the helper does nothing until `delegate` gives it a task.

## 0.0.4 - 2026-11-11

### Added

- **Parallel Bots: one question, three answers, one request.** A columns button next to the message box (in a chat with one bot) sends your message to the model once, with a short instruction. The model picks three roles that fit that question and answers as each of them in a single reply, which is shown as three cards that fill in as it is written. It is one request, so it takes one place in the queue instead of three, no second model loads and memory stays at one slot; it isn't faster to write than three answers would be, but it avoids reading the chat and the bot's instructions three times. No tools or helpers in this mode, no summarising of a long chat first, and Try again after a failed reply keeps the mode. Your message gets a **Parallel Bots** mark, and a reply that didn't come out in sections is shown as written, with a note to send the question again. `evals/parallel.eval.ts` runs real models through it so a 9B can be compared with a 14B or a 30B later. See [Parallel Bots](docs/features.md#parallel-bots).
- **The documentation is tested** (`scripts/docs.test.ts`, run by `pnpm test` and CI): every link and heading anchor resolves, every package has the app's version and the changelog has an entry for it, the providers, built-in tools and settings pages the docs list are the ones the app has, and no personal path or address is in a markdown file.
- **A troubleshooting entry for Ollama running but listing no models** (usually `OLLAMA_MODELS` pointing at the wrong folder).
- **`pnpm test:ui`** opens the test suite in a browser dashboard (Vitest UI): run the tests, search and filter them, and see why one failed.
- **An eval for the reports that end races and clusters** (`evals/reports.eval.ts`): real models run a cluster and a race, and every section of the summary and the judge's report must be there and filled in, with a winner named.
- **Evals for exploring a site:** a shop whose search finds nothing, where the phone is only on page 2 of its menu, and one where the phone isn't there at all (the bot must say so, not make up a price). For Visual and text bots: `explore`, `missing`, `visual-explore`, `visual-missing`.

### Fixed

- **A message lost its moderator mark while it was being written.** The update that saves a streaming reply read only some of the message's columns, so every update of a cluster moderator's summary reported it as an ordinary message from no bot. All marks now survive those updates.
- **A coordinator that skips `spawn_bot` is no longer left with nobody.** Some models (small ones, and ones without native tool calls) hand a task to a helper's name with `delegate` without making the helper first, and got "No teammate is called X. Teammates: none." again and again until they gave up and did everything themselves. `delegate` now makes a helper for a name nobody has, on the model already in use (no approval card, as with `spawn_bot`), within the limit of 6 helpers and never in a group chat; a name that differs from a teammate's only in case, spacing or punctuation ("research_bot") now means that teammate.
- **Helpers working for a coordinator were told they were in a group chat with you.** The conversation between a coordinator and a helper is stored like a group, so the helper's instructions said it was in a group chat with you and should keep it short. They now don't.
- **Bot-to-bot conversations aren't listed as group chats.** A coordinator's conversation with a helper or teammate ("Boss ↔ Helper") has its own **Bot conversations** section in the sidebar, and **Group chats** are only the ones you made.
- **The planning question before a coordinator's turn always turns thinking off for Ollama models**, as the race and cluster reports already did. Models whose Ollama listing doesn't say they think (Ornith 1.5, MiMo v2.6) could spend the planner's few tokens thinking and return no plan.
- **Typing no longer runs into what a box already holds.** A Visual Bot typing into a search box that still held the last search (as search engines' do), or trying the same text twice, got the two run together ("vivo y19spixel phone"). Now what was in the box is replaced, the bot is told what the box holds afterwards (and warned if it isn't what it typed), and the screen map shows what each text box holds.
- **Races and clusters end with a whole report.** A summary or judge's report that left a section out, left it empty or was cut off in the middle gets that section asked for once more and put in its place, and a race whose judge named no winner takes the top score in its table. A cluster whose experts' replies start failing still gets a summary of what was said, instead of ending with none. On a small context, the moderator and the judge get every turn and every racer's answer cut to an even share, instead of losing the opening turns or the last racers off the end.
- **Cluster summaries on Ornith and MiMo came out empty or cut off.** Ollama's model list doesn't say that some models think (Ornith 1.5 and MiMo v2.6 among them), so the moderator couldn't switch their thinking off, and with room for a 3,000-token summary Ornith spent all of it thinking. The moderator's calls and the filling-in of a report now always switch thinking off on Ollama. Ordinary chats are unchanged: these models still think before replying, which in evals they need to do well.
- **Rich-text boxes** (as in mail and chat composers) get a numbered box, so Visual Bots can type into them.
- **Box numbers sit level with their own box.** Drawn above it, in a tight list the number landed on the row before and covered its first letter, and models clicked the item below the one they meant.
- **No approval card for something that can't happen.** Typing with nothing selected, or clicking a number that isn't on the page, asked first and then failed anyway; an unwatched bot waited on the card. Now they're refused at once with what to do instead.
- **A guessed address that doesn't exist says so in plain words**, instead of the browser's own error with its call log, and the next page the bot opens is no longer cut short by the browser's error page.

## 0.0.3 - 2026-11-06

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

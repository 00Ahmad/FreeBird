# Feature guide

Everything FreeBird can do, by area. New here? Start with [Getting started](getting-started.md).

- [Bots and chats](#bots-and-chats)
- [Group chats](#group-chats)
- [Coordinators and helpers](#coordinators-and-helpers)
- [Races and Clusters](#races-and-clusters)
- [Tools and approvals](#tools-and-approvals)
- [The bots' web browser](#the-bots-web-browser)
- [Visual Bots](#visual-bots)
- [A computer for each bot](#a-computer-for-each-bot)
- [Routines](#routines)
- [Connect apps (MCP)](#connect-apps-mcp)
- [Vault](#vault)
- [Memory, skills and templates](#memory-skills-and-templates)
- [Voice](#voice)
- [Library, tables and exports](#library-tables-and-exports)
- [Settings at a glance](#settings-at-a-glance)

---

## Bots and chats

FreeBird looks like a messaging app. Each bot is a contact in the sidebar with its own:

- **name, label and avatar** (shapes, colours or your own picture),
- **instructions**: how it should work, in your words,
- **model**: the shared local model by default, or any model from any provider,
- **folder** for its files, and **memory**.

Your first bot is the **Primary Bot**. Pin bots, sort them into sections, hide the ones you rarely use (**Hidden Bots**), duplicate a bot, or turn its notifications off from the right-click menu. **Ctrl+B** switches to a compact sidebar.

In a chat you can:

- **Stream replies** with Markdown, code and tables, and see the model's thinking when it thinks.
- **Stop** a reply, or just **send another message while the bot is working**: it reads it between steps and adjusts course (steering).
- **Attach pictures** by pasting, dragging or picking; models that can see will look at them.
- **Reply to** a message with a quote, react with an emoji, copy, or have it read aloud.
- **Switch models mid-conversation** from the model menu in the chat header.
- **Answer a bot's question with a tap** when it offers choices, or tick several; you can always type your own answer.
- **See what's new.** A chat with replies you haven't seen shows a badge (and a count in the window title), and opens with a **New messages** line. It counts what arrives while the app is open, and starts again when the app restarts.
- **Recover from a problem** without retyping: an error says in plain words what happened, with **Try again**, **Switch model** or **Open settings**, and the technical text behind **Details**. A reply that hasn't started after 20 seconds offers the same ways out (a model on your computer gets a minute and a half first, since loading takes a while). **Try again** is never offered where it could repeat something the bot already did.

Long chats draw only the newest messages and add earlier ones as you scroll up, so they stay quick.

## Group chats

Make a group with 2–6 bots from **+ → New group chat**. Address bots with `@Name`, or everyone with `@everyone`. If you don't mention anyone, the shared model picks who should answer. Bots reply one after another so each sees what the previous one said.

Bots can also message each other with `message_bot`. Those conversations appear as readable **"A ↔ B" threads** you can open any time.

Group chats can't show approval cards, so actions that need your approval aren't available there: bots say so instead of trying.

## Coordinators and helpers

Your Primary Bot, and any bot you mark as a coordinator, can build a team on the fly:

| Tool          | Does                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `spawn_bot`   | Creates a helper with its own instructions (and optionally its own model or as a Visual Bot).                           |
| `delegate`    | Gives up to 5 helpers or teammates a task each; they work at the same time, and the coordinator gets every answer back. |
| `dismiss_bot` | Removes a helper that's no longer needed.                                                                               |

**Coordinators decide on their own when to use helpers.** Before starting a real job, FreeBird asks the model one short question: does this split into independent parts (one per product, option, source or site)? If it does, the coordinator creates a helper for each part, hands out the tasks in one go and combines the answers. Quick questions, step-by-step work and work on its own files it does itself. You can also just ask: _"use three helpers for this"_.

- Creating a helper on the model already in use needs no approval. A helper on a **different** model asks first, since that may be a paid API.
- Helpers' own risky actions still ask first, and their approval cards, questions and secret requests appear **in the coordinator's chat**, where you are.
- **Stop** on the coordinator stops all its helpers.
- Helpers can't make helpers of their own: one level only, so there are no chains or loops.
- For a step that builds on earlier answers (checking, auditing, a report), the coordinator passes earlier helpers' results along with `include_results_from`.
- Temporary helpers hide when the coordinator's turn ends and are deleted when dismissed or with their coordinator.

## Races and Clusters

Two multi-bot modes that FreeBird adds:

- **Race**: 3–5 bots do the same task alone; a judge scores them and compiles the best result.
- **Cluster**: 3–5 bots discuss a topic under a moderator, backing every claim with sources.

They have their own page: [Races & Clusters](races-and-clusters.md).

## Tools and approvals

Every bot has built-in tools:

| Tool                                                                 | Does                                                      | Asks first?                              |
| -------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| `list_files`, `read_file`, `write_file`, `edit_file`, `search_files` | Work with files                                           | Only outside the bot's own folder        |
| `run_command`                                                        | Runs a PowerShell (Windows) or sh command, with a timeout | Always (unless you change the policy)    |
| `fetch_url`                                                          | Reads a web page as text                                  | Only for addresses on your local network |
| `ask_user`                                                           | Asks you a question in the chat and waits                 | No                                       |
| `update_plan`                                                        | Shows a live checklist for a multi-step task              | No                                       |
| `remember`                                                           | Saves a lasting note to the bot's memory                  | No                                       |

Plus browser, computer, vault and connected-app tools, described below.

**Choose each bot's tools** in **Details → Tools**: every tool is on until you switch it off. A tool that is off is not offered to the model, and the bot is told it can't use it. Fewer tools means a shorter prompt, which small local models need to choose well, and a bot that only reads files can't be talked into running a command. (A bot's list can also hold an allow list, set through the API: then only those tools exist for it. `name*` stands for a whole family, such as one connected app's tools.)

`ask_user` can offer choices (`options`, and `multiple` to tick several) so you can answer with a tap.

**Approval cards** show exactly what the bot wants to do, with warning badges such as _"This can't be undone"_, _"This may buy, send or change something on the site"_ or _"Outside the bot's folder"_. Choose:

- **Allow once**,
- **Always allow**: saves a rule for that exact action. Not offered for terminal commands, purchases, sending, or anything touching sign-ins,
- **Deny**: the bot is told not to retry.

In **Settings → General** you can set **Execution on this computer** (ask / always allow / never allow commands), manage **Custom Rules**, and tune **How bots work**: steps per reply (default 25), a plan checklist for multi-step tasks, and a self-check before the final answer of tool-heavy tasks.

Small local models get extra help: arguments they get slightly wrong are repaired, a tool call that can't be read is retried, a model that goes quiet after using tools is nudged once, and when the steps run out the bot still summarizes what it found.

## The bots' web browser

Bots get a real browser: FreeBird drives your installed **Edge or Chrome** with profiles only for bots, one tab per bot. The window is shown by default so you can watch. The chat's **Browser** panel shows a live view where you can click, type and scroll in the bot's tab, or type an address into it.

**Each bot has its own sign-ins.** By default each bot's browser has its own profile (cookies, sign-ins), and its helpers use the same one, so a site you sign in to for one bot isn't open to the others. To sign in for a bot, open the **Browser** panel in its chat, press **Open Ada's browser**, and sign in there. The bots of one race or cluster share one browser between them. At most three browsers run at once. When another is needed, the one used longest ago closes if nobody has used it for two minutes; one that is working, waiting for you or being watched is never closed, and the bot that needs a browser is told to try again later instead. Deleting a bot deletes its profile. To have all bots share one profile, pick **All bots share one** in **Settings → Browser & search → Sign-ins**. Installs that used the browser before this keep sharing until you switch. Switching closes the browser, and sign-ins aren't moved, so you sign in again where bots need it.

| Tool                                                             | Does                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `web_search`                                                     | Searches through the browser (Bing, then DuckDuckGo), the Brave Search API, or your SearXNG                        |
| `browser_open`, `browser_read`, `browser_scroll`, `browser_back` | Open and read pages as text with numbered elements                                                                 |
| `browser_click`, `browser_type`                                  | Act on the page                                                                                                    |
| `browser_screenshot`                                             | A picture of the page for models that can see                                                                      |
| `browser_handoff`                                                | Hands control to you for human checks, sign-ins and payments; after a check, carries on by itself once it's solved |
| `browser_sign_in`                                                | Types a saved Vault login into a sign-in form                                                                      |

Safety rules:

- Clicks like **Buy, Pay, Send, Delete, Subscribe** ask first, in many languages, and so do buttons with no name.
- Bots never type passwords or card numbers. `browser_sign_in` fills a login from the Vault without the password ever reaching the model or page snapshots, only on that login's own site and only over HTTPS.
- **Look like an ordinary browser** (Settings → Browser & search, on by default): the browser leaves out what only automated browsers send (`navigator.webdriver`, the "controlled by automated software" bar, "Headless" in a hidden window's name), so fewer sites stop bots with checks. It doesn't solve checks, fake a fingerprint or change your address; checks still come to you. Switch it off to have the browser say it is automated.
- Pages on your local network (your router, NAS, other devices) ask first.

Choose the search engine in **Settings → Browser & search**.

**Fewer checks, less effort.** Bots search on Bing first; Google stops automated browsers with checks much more often. When a check does appear, the bot brings its window to the front and hands it to you. Solve it, and the bot carries on by itself as soon as the check is gone. Turn on **Notify me** in a bot's Details to get a desktop notification whenever it needs you. A check you've solved once is remembered in that bot's browser profile, so the same site rarely asks again.

## Visual Bots

**+ → New Visual Bot** makes a bot that uses the web **only by looking**: screenshot, decide, act, screenshot. It sees numbered boxes on everything it can click or type into, and works with `screen_look`, `screen_click`, `screen_click_at`, `screen_type`, `screen_press`, `screen_scroll`, `screen_back`, `screen_go_to` and `screen_watch` (a short clip to follow videos and pages that change).

A red dot shows where it's about to click. The same safety rules apply: consequential clicks and Enter in forms ask first, and it never types passwords. A click that would land on something covering the box it chose (a pop-up, a cookie banner) is refused when that something would ask first. Use a model that can see, such as `qwen3.5:9b`; with an Ollama model that can't, the reply says so and offers **Switch model**.

## A computer for each bot

With **Docker Desktop** running, each bot can have its own Linux desktop (`linuxserver/webtop`, Ubuntu XFCE), reachable only from your computer. Open the **Computer** panel to watch it live, take over, or start, stop and reset it. The bot runs commands there with `computer_run`, separate from your own machine. Commands that reach your local network or host ask first.

Configure it in **Settings → Computer**.

## Routines

Routines make bots work on their own, and report in their chat:

| Trigger      | Runs                                                |
| ------------ | --------------------------------------------------- |
| **Weekly**   | On chosen days at chosen times                      |
| **Interval** | Every N minutes                                     |
| **Once**     | At a date and time                                  |
| **Webhook**  | When something calls its secret URL (`/hooks/<id>`) |
| **Manual**   | Only when you press Run                             |

See all routines on a weekly calendar in **Settings → Routines**, and pause, resume, test, edit or delete them. Runs missed while the app was closed catch up on the next start. **Teach a task** turns written steps into a routine you can run on demand.

## Connect apps (MCP)

Connect any [Model Context Protocol](https://modelcontextprotocol.io) server, local (a command) or remote (an HTTP URL), in **Settings → Connect apps** (Ctrl+Shift+M). Turn individual tools on or off, mark tools **Ask first**, and pass secrets as `vault:NAME` so they never sit in plain text.

**Apps that need a sign-in.** A remote app that asks you to sign in shows **Needs you to sign in** with a **Sign in** button. It opens the app's sign-in page in your own browser, and after you sign in you're sent back to FreeBird (OAuth with PKCE). The sign-in is kept in your keychain as `MCP_OAUTH_<APP>` and refreshed by itself. Changing the app's address or removing the app deletes it. An app you gave an `Authorization` header (a token you pasted in) keeps using that token and is never offered a sign-in.

**What each bot may do with an app.** In **Details → Tools**, each connected app has **Can make changes**, **Read only** or **No access**. With **Read only**, the bot gets only the tools that just read. FreeBird tells them apart by what the app says about each tool (`readOnlyHint`, `destructiveHint`) and by the tool's name. When the two disagree, the stricter wins, and a tool it can't place counts as one that makes changes. A tool that can't be undone asks you every time, even from an app set not to ask. A helper never gets more than the bot that made it.

**Big results.** When an app sends back more than about 4,000 characters, the bot gets the result's shape and a preview. It then picks out what it needs with `query_result`: a path such as `messages[0:5].subject` or `items[?status==open]`, a search, or a range of lines.

## Vault

Store **logins, cards and contact info** in your operating system's keychain (**Settings → Vault**), or import logins from a password manager's CSV export. A login matches its exact site; tick **Also use on subdomains** to use it on `accounts.example.com` too.

- `request_secret` shows a **secure secret card**: you type the value, and the bot only ever sees the name.
- `use_login` gives a bot's commands a login as environment variables, and the values are hidden from anything the command prints.
- `browser_sign_in` fills web sign-in forms without the password reaching the model.

## Memory, skills and templates

- **Memory you can see.** Bots save lasting notes with `remember`. In the bot's **Details → Memory** you can read, edit, add, delete and import notes. Long conversations are summarized automatically so they fit the model.
- **Skills.** Save a prompt as a skill and run it with `/name` in the message box.
- **Templates.** **Details → Share as template** exports a bot (instructions, avatar, skills) as a file; **+ → Import bot template…** brings one in.

## Voice

- **Dictation** (Ctrl+D) through any OpenAI-compatible transcription endpoint you set in **Settings → Voice**.
- **Read aloud** any reply with your operating system's voices.

## Library, tables and exports

- **Library**: save replies worth keeping. Saved copies outlive the chat; rename them, jump to the source chat, or download them as Markdown.
- **Tables** in replies can be sorted by any column (numbers sort as numbers), copied, or downloaded as CSV.
- **Download any reply** as a Markdown file.
- **Usage** (Settings → Usage) shows tokens per bot. Local models cost $0.

## Settings at a glance

| Page                   | What's there                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **General**            | Commands policy, Custom Rules, steps per reply, plan checklist, self-check                                                      |
| **Local model**        | Shared model, loaded models and memory use, context size, keep loaded, bots at once, thinking, download a model, Ollama address |
| **Models & Providers** | Add, test, enable and remove providers; keys go to your keychain                                                                |
| **Computer**           | Docker desktops for bots                                                                                                        |
| **Browser & search**   | The bots' browser and the search engine                                                                                         |
| **Routines**           | Weekly calendar of every routine                                                                                                |
| **Connect apps**       | MCP servers and their tools                                                                                                     |
| **Vault**              | Logins, cards, contact info, CSV import                                                                                         |
| **Voice**              | Dictation endpoint                                                                                                              |
| **Usage**              | Tokens per bot                                                                                                                  |

# Privacy & security

FreeBird gives AI models real tools on your computer, so it's built to keep you in control. This page explains what stays local, what can leave your machine, and the guard rails around bots.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What stays on your computer

| Data                                        | Where it lives                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Bots, chats, memory, routines, settings     | A local SQLite database in the app's data folder                                                       |
| Each bot's files                            | Its own folder under the data folder                                                                   |
| Earlier versions of files a bot changed     | `file-history/` in the data folder, for **Undo**: at most 100 per bot, deleted with the bot            |
| API keys, vault logins, cards, contact info | Your operating system's keychain (Windows Credential Manager, macOS Keychain, Secret Service on Linux) |
| The bots' browser profiles                  | Inside the data folder, apart from your own: one per bot in `browser-profiles/`, or one shared         |
| Sign-ins to connected apps (OAuth)          | Your operating system's keychain, as `MCP_OAUTH_<APP>`                                                 |

- **No account, no telemetry, no analytics.** FreeBird doesn't phone home.
- **With a local model, nothing leaves your computer** except what a bot fetches from the web for you.
- **With a cloud model**, that bot's conversation goes to the provider you chose, under that provider's terms. Other bots aren't affected.
- Secrets are never stored in the database or in files: only their **names** are, and the app never shows or returns values. (The [event log](#the-event-log) is a record of chats and redacts anything that looks like a key or token.)
- Running from source, the dev data folder `.data/` is git-ignored, so your chats can't end up in a commit.

## The local server

The interface talks to a local server (the "harness") that holds all data, models and secrets.

- It listens on **127.0.0.1 only**, never on your network.
- It rejects requests addressed to any host name other than loopback, which stops malicious web pages from reaching it through DNS rebinding.
- Every API call needs a **random token created at each launch**, which only the app's own window can read. Commands that bots run never get it (nor any of FreeBird's own settings from its environment), so code a command runs can't call the app. Only `/api/health` is public.
- The desktop window can't navigate away from the app; links open in your normal browser.
- The packaged app serves its interface with a strict Content Security Policy.

## Approvals: bots ask before acting

Risky actions stop at an **approval card** that shows exactly what will happen, with warning badges like _"This can't be undone"_ or _"This may buy, send or change something on the site"_.

| Action                                                                             | Default                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| Reading and writing files in the bot's own folder                                  | Allowed                                        |
| Files outside the bot's folder                                                     | Asks                                           |
| Terminal commands on your computer (the card shows the folder they run in)         | Asks every time ("Always allow" isn't offered) |
| Web pages on the internet                                                          | Allowed                                        |
| Pages and devices on your local network (router, NAS, other computers)             | Asks                                           |
| Buy / pay / send / delete / subscribe clicks, buttons with no name, Enter in forms | Asks ("Always allow" isn't offered)            |
| Using a saved login                                                                | Asks ("Always allow" isn't offered)            |
| Creating a helper on the shared model                                              | Allowed                                        |
| Creating a helper on a different model (may cost money)                            | Asks                                           |

You decide globally in **Settings → General → Execution on this computer** (ask, always allow, or never allow commands), and with **Custom Rules**. "Always allow" on a card saves a rule for that exact action only (the identical call, so allowing `Fetch http://192.168.1.1` doesn't allow `http://192.168.1.10`), never for the whole tool. Rules you type yourself in Custom Rules still match everything that starts with the text you give, except for terminal commands: there a rule only covers the command itself, so a rule for `npm` doesn't let `npm i; Remove-Item …` or a command with `|`, `&`, `;`, `$(`, redirects or `iex` through. Racers and the race judge work on their own, so a call of theirs that needs approval is refused at once instead of waiting for a card nobody can see. Group chats can't show cards, so actions that need approval simply aren't available there.

## Secrets never reach the model

- **Secure secret cards** (`request_secret`): you type a value into the card; the bot only learns its name.
- **Logins for commands** (`use_login`): passed to the command as environment variables, and the values are blanked out of anything the command prints.
- **Secrets for one command**: a bot names the secrets a single `run_command` needs, and the card says so. Only those reach that command, and only if the bot was given them. That card always asks, whatever the command policy (except **never**, which refuses).
- **Saved values are hidden everywhere.** Every saved secret, login password, card number and app sign-in token is replaced with `[hidden]` in command output, connected-app results, error text and the event log, also when it is percent-encoded, JSON-escaped, base64-encoded or part of a `user:password` sign-in. Values shorter than 8 characters aren't matched, because they would hide ordinary words, so keep secrets longer than that.
- **App sign-ins** (OAuth with PKCE): you sign in on the app's own page in your browser; FreeBird never sees your password there. Each sign-in link works once and for 10 minutes. The tokens are tied to the app's address and are never sent to another server, even if you change the address. Sign-ins and Vault entries (`MCP_OAUTH_…`, `VAULT_ITEM_…`) are never handed to a command, and a bot can't ask you to type into one.
- **Web sign-ins** (`browser_sign_in`): the app types a vault login into the page itself, only on the login's own site and only over HTTPS. The password never appears in what the model sees, including page snapshots.
- **Pictures are covered too.** Card number, security code and password fields (including a "show password" box that has turned into plain text) are blacked out in every screenshot a bot receives and never appear in the list of page elements, so a card you type during a handoff isn't visible to the model afterwards.
- **Keys found on your computer** (environment variables such as `OPENAI_API_KEY`) are offered in Settings → Models & Providers by name only; the screen never receives the key, and it is copied into the keychain only when you press **Add**.
- **A secret can be at most 1,280 characters** (the Windows keychain's limit, applied everywhere so it behaves the same on every system). A longer value gets a clear error; connected-app sign-ins, which can be longer, are stored in pieces.
- **Images in chat load on request.** A picture a bot's reply points to on the web isn't fetched until you press **Load image**, because the address itself could carry your text to someone else's server.
- Keys typed for a server that takes none (LM Studio, another computer on your network) are ignored, never stored and never sent.
- **A Coding Bot writes only the files of its plan, inside its output folder**, without asking. Anything else (helper scripts, `.git`, `node_modules`, editor settings that run commands) is refused, and its roles can't read `.env` files or private keys. The folder can't be a drive root, your home folder, FreeBird's data folder, another bot's folder or a network path. Its commands **always ask**, whatever the global command setting (unless that is set to never allow). Deleting a Coding Bot never deletes the output folder. An imported plan is checked like the Planner's own (relative paths only, no `..`, no protected files), and you approve it before anything is written unless auto-approve is on.
- **A Job Bot keeps your job profile, its board and your reactions on this computer.** It searches only when you start a scan. Its roles have one tool each and no access to files, commands or your sign-ins; the pages it reads are treated as data, and every fact it shows must be quoted from the page it read. It never applies, sends or signs in for you: a CAPTCHA or sign-in is handed to you, and its Visual helper never types or submits anything.
- **A Client Bot keeps your client profile, your lists (clients, competitors, do-not-contact), its leads and your notes on this computer.** It searches only when you start a scan. Contact routes are found by the app on the pages it reads and are company-level only (a contact page, a shared business inbox, the main phone line): it never guesses or looks up a person's email, and leaves out personal-looking addresses and mobile numbers. It never sends anything. **Forget** on a lead deletes its card and quotes, and what was read about it in the team's role threads; once a page is checked, only its start is kept there. A Companies House API key is kept in the system keychain and never reaches a model. It doesn't read LinkedIn, Facebook or marketplaces.
- Bots never type passwords or card numbers themselves: sign-ins, human checks and payments are handed to you (`browser_handoff`).
- Saved logins match their exact site by default; subdomains only when you allow it.

## Each bot has its own space

- **Files**: each bot works in its own folder, free inside it and asking outside it. Links that point out of the folder count as outside.
- **Browser**: one tab per bot, and by default a profile per bot (helpers use their maker's), so one bot's sign-ins aren't open to another. The bots of one race or cluster share one. A deleted bot's (or race's) profile is deleted, and any left behind are removed the next time the app starts. By default the browser leaves out the signals only automated browsers send (**Look like an ordinary browser** in Settings → Browser & search), so sites can't tell it apart by those; it never solves human checks or fakes who is browsing. Some sites' terms forbid automated use whether or not it shows: switch the setting off, or keep bots away from those sites, if that matters to you.
- **Connected apps**: per bot, **Can make changes**, **Read only** or **No access**. Read-only is decided by the app's own hints checked against tool names, the stricter of the two winning; an app that misdescribes a tool as read-only can still mislead it, so **Ask first** remains the safety net for apps you don't trust.
- **Computer**: an optional Docker desktop per bot, bound to 127.0.0.1, separate from your machine.

## The event log

To help work out what went wrong after a crash or a bad turn, FreeBird keeps a record of what happened: every event the app published, one line each, in `logs/<chat>.ndjson` in the data folder (events that belong to no chat go in `logs/_app.ndjson`).

- **It is a second copy of your chats**, in readable text, next to the database that already holds them. It never leaves your computer.
- **Secrets are redacted** (API keys, tokens, bearer headers, private keys, `password`/`token`-style fields, the app's own launch token) and **pictures are left out**. Redaction looks for patterns, so a secret in an unusual shape can slip through; this is why the log is not shared or uploaded by anything.
- **It goes when the chat goes.** Clear chat deletes the chat's log, and so does deleting the chat or its bot. Logs of chats that no longer exist are removed when the app starts.
- **Not everything is per chat.** Events about the app as a whole go in `_app.ndjson`, including the creation and edits of bots with their instructions. That file is **not** cleaned when a bot is deleted; its contents go when the file rotates.
- **It stays small.** A file that reaches 8 MB is renamed to `.1` (replacing the previous `.1`) and a new one starts, so a chat keeps at most about 16 MB of log. If the disk can't keep up, newer events are dropped (with a note in the log) rather than slowing the app.
- **It is on by default.** Turn it off with the environment variable `MROG_EVENT_LOG=off` (there is no Settings switch yet), and delete the `logs` folder at any time.

## When approvals go unanswered

An approval card that nobody answers expires after 15 minutes and the action is **not run**. The bot is told that nobody answered, which is different from you saying no. To have a bot (and its helpers) wait for your answer instead, turn on **Wait for my answer to approvals** in its **Details → Notifications**; **Stop** still ends the wait. Questions to you (`ask_user`) never expire while the turn is running. After the app restarts, cards from an interrupted turn are closed rather than left looking answerable, and a turn that was in the middle of something that changes things outside the chat is shown as an error that says so, so you can check before asking again.

## Known limits

We'd rather you know these than discover them:

- A bot's Docker computer has normal network access. Commands that name local-network addresses ask first, but there's no firewall-level egress filtering yet. Computers are created with a process limit, a memory limit and without raw-socket and device-node privileges; the image needs root for its start-up and the bot uses `sudo`, so broader hardening (dropping all capabilities, `no-new-privileges`) isn't applied. New limits only apply to a computer when it is created: press **Reset** on an existing one.
- The browser's local-network guard checks page loads and the page's own requests, but not images, scripts, or a popup's very first request.
- Visual Bots judge a click by the control at that spot on the page. Inside an embedded frame from another site (a video, a payment form) nothing can be read, so such clicks always ask first.
- Models can be tricked by text on web pages ("prompt injection"). Approval cards are your safety net: read them before you allow.

# Privacy & security

FreeBird gives AI models real tools on your computer, so it's built to keep you in control. This page explains what stays local, what can leave your machine, and the guard rails around bots.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What stays on your computer

| Data                                        | Where it lives                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Bots, chats, memory, routines, settings     | A local SQLite database in the app's data folder                                                       |
| Each bot's files                            | Its own folder under the data folder                                                                   |
| API keys, vault logins, cards, contact info | Your operating system's keychain (Windows Credential Manager, macOS Keychain, Secret Service on Linux) |
| The bots' browser profile                   | A separate browser profile inside the data folder, apart from your own                                 |

- **No account, no telemetry, no analytics.** FreeBird doesn't phone home.
- **With a local model, nothing leaves your computer** except what a bot fetches from the web for you.
- **With a cloud model**, that bot's conversation goes to the provider you chose, under that provider's terms. Other bots aren't affected.
- Secrets are never stored in the database or in files: only their **names** are, and the app never shows or returns values.
- Running from source, the dev data folder `.data/` is git-ignored, so your chats can't end up in a commit.

## The local server

The interface talks to a local server (the "harness") that holds all data, models and secrets.

- It listens on **127.0.0.1 only**, never on your network.
- It rejects requests addressed to any host name other than loopback, which stops malicious web pages from reaching it through DNS rebinding.
- Every API call needs a **random token created at each launch**, which only the app's own window can read. Only `/api/health` is public.
- The desktop window can't navigate away from the app; links open in your normal browser.
- The packaged app serves its interface with a strict Content Security Policy.

## Approvals: bots ask before acting

Risky actions stop at an **approval card** that shows exactly what will happen, with warning badges like _"This can't be undone"_ or _"This may buy, send or change something on the site"_.

| Action                                                                             | Default                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| Reading and writing files in the bot's own folder                                  | Allowed                                        |
| Files outside the bot's folder                                                     | Asks                                           |
| Terminal commands on your computer                                                 | Asks every time ("Always allow" isn't offered) |
| Web pages on the internet                                                          | Allowed                                        |
| Pages and devices on your local network (router, NAS, other computers)             | Asks                                           |
| Buy / pay / send / delete / subscribe clicks, buttons with no name, Enter in forms | Asks ("Always allow" isn't offered)            |
| Using a saved login                                                                | Asks ("Always allow" isn't offered)            |
| Creating a helper on the shared model                                              | Allowed                                        |
| Creating a helper on a different model (may cost money)                            | Asks                                           |

You decide globally in **Settings → General → Execution on this computer** (ask, always allow, or never allow commands), and with **Custom Rules**. "Always allow" on a card saves a rule for that exact action only, never for the whole tool. Group chats can't show cards, so actions that need approval simply aren't available there.

## Secrets never reach the model

- **Secure secret cards** (`request_secret`): you type a value into the card; the bot only learns its name.
- **Logins for commands** (`use_login`): passed to the command as environment variables, and the values are blanked out of anything the command prints.
- **Web sign-ins** (`browser_sign_in`): the app types a vault login into the page itself, only on the login's own site and only over HTTPS. The password never appears in what the model sees, including page snapshots.
- Bots never type passwords or card numbers themselves: sign-ins, human checks and payments are handed to you (`browser_handoff`).
- Saved logins match their exact site by default; subdomains only when you allow it.

## Each bot has its own space

- **Files**: each bot works in its own folder, free inside it and asking outside it. Links that point out of the folder count as outside.
- **Browser**: one tab per bot in a bot-only profile. The automated browser is never disguised.
- **Computer**: an optional Docker desktop per bot, bound to 127.0.0.1, separate from your machine.

## Known limits

We'd rather you know these than discover them:

- A bot's Docker computer has normal network access. Commands that name local-network addresses ask first, but there's no firewall-level egress filtering yet.
- The browser's local-network guard checks page loads and the page's own requests, but not images, scripts, or a popup's very first request.
- Models can be tricked by text on web pages ("prompt injection"). Approval cards are your safety net: read them before you allow.

See the [roadmap](roadmap.md) for planned improvements.

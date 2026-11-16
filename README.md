<div align="center">

<img src="apps/desktop/build/icon.png" alt="FreeBird logo" width="128" height="128" />

# FreeBird

**A local-first workspace for teams of AI bots.**

Run bots on Ollama or any local runtime, or connect any API provider with your own key · no account, no subscription

[![CI](https://github.com/00Ahmad/FreeBird/actions/workflows/ci.yml/badge.svg)](https://github.com/00Ahmad/FreeBird/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/00Ahmad/FreeBird?style=social)](https://github.com/00Ahmad/FreeBird/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/00Ahmad/FreeBird?style=social)](https://github.com/00Ahmad/FreeBird/network/members)

[Getting started](docs/getting-started.md) · [Features](docs/features.md) · [Races & Clusters](docs/races-and-clusters.md) · [Models & providers](docs/models-and-providers.md) · [Docs](docs/README.md)

</div>

---

FreeBird is a free, open-source desktop application for working with a team of AI bots. Every bot is a contact with its own tools, files, browser, computer, memory and routines. Bots work in parallel, hand work to one another, and ask for your approval before doing anything risky.

FreeBird runs on your machine. Connect it to [Ollama](https://ollama.com) and every bot can share one local model, with nothing leaving your computer. Or give any bot a model from OpenAI, Anthropic, Google, Groq, xAI, Mistral, DeepSeek, OpenRouter and more, using your own API key.

Beyond chat, FreeBird has several ways to put bots to work on one problem: **Races** (bots compete on the same task and a judge compiles the best answer), **Clusters** (a moderated, source-checked debate), **Parallel Bots** (one question, three answers, one request, or three roles searching in parallel) a **Coding Bot** (a planner, a developer and QA that build a project in a folder you choose) a **Job Bot** (finds and checks jobs that fit you, when you ask) and a **Client Bot** (finds businesses that may need what you sell, with the evidence, when you ask).

> ⭐ **If FreeBird is useful to you, please star the repo.** It helps other people find it. Forks, issues and pull requests are very welcome: see [Contributing](CONTRIBUTING.md).

## Why FreeBird

- **Local-first.** Runs on Ollama, LM Studio, vLLM, llama.cpp, Jan and LocalAI, so nothing has to leave your machine.
- **Any provider, any model per bot.** Use your own API keys, and give each bot its own model.
- **No account and no subscription.** It works offline with a local model.
- **A team, not a single chat.** Group chats, bots that delegate to each other, approval cards before risky actions, a vault for logins, routines, connected apps and a computer per bot.
- **Multi-bot workflows.** Races, Clusters, Parallel Bots, the Coding Bot, the Job Bot and the Client Bot.
- **Memory you control.** Read, edit and import what every bot remembers.
- **Open source** under the MIT license.

## What you can do with it

### 🏁 Races: let bots compete

Give one task to 3–5 bots. Each picks its own strategy and works alone, on the shared model or each on a different model. Then a judge bot picks the criteria that matter for the task, scores every racer in a table, names a winner and compiles a **final result from the best parts of each**, marking which racer each part came from. Great for writing, research, plans and comparing models head to head. [Read more](docs/races-and-clusters.md#races)

### 🕸️ Clusters: a debate that checks its sources

Describe a topic and a goal (**explore ideas**, **reach a decision** or **research a question**). FreeBird proposes a team of 3–5 bots with different roles, or you pick them. A moderator chooses who speaks next; every claim must be backed by a page the bot actually opened, or by reasoning someone could check, and links the bots never opened are flagged. You can pause, step, steer or stop at any time, and you get a structured summary at the end. [Read more](docs/races-and-clusters.md#clusters)

### 🧑‍💻 Coding Bot: a planner, a developer and QA

Create a **Coding Bot**, choose an output folder and a model for each role, and describe what you want. The **Planner** draws the files and how they connect, you approve the plan, the **Developer** writes it one card at a time, and **QA** checks every file and every connection and sends anything wrong back with a comment. It repeats until everything passes or the round limit (5 by default) is reached. You watch it on a diagram, a progress board and a checklist, and you can export the plan or import one written by a stronger model. Switch on **Visual QA**, and QA also opens the finished app and uses it like a person, with screenshots, clicks and the browser console, then sends back what doesn't work. [Read more](docs/coding-bot.md)

### 💼 Job Bot: jobs that fit you, checked against the posting

Create a **Job Bot** and tell it what job you want; it fills in a profile you approve. When you ask, it searches, asks how many new jobs to find, reads each one and puts it on a board with a match score explained requirement by requirement and any warning signs. Every fact must be quoted from the posting, so nothing is guessed, and your profile stays on your computer. [Read more](docs/job-bot.md)

### 🤝 Client Bot: businesses that may need what you sell

Create a **Client Bot** and tell it what you sell and who your ideal client is. When you ask, it looks for tenders and "seeking a provider" posts, businesses showing signs they may need you (hiring for your kind of work, opening a new site), and good fits from official registers that have never posted anything. Each lead says why now, why you and how to reach the business, and every fact is quoted from its source. Your lists stay on your computer and it never sends anything. [Read more](docs/client-bot.md)

### 🧩 Parallel Bots: one question, three answers

Switch on **Parallel Bots** and the model picks three roles that fit your question and answers as each of them, shown as three cards. On a local model it is one request with three sections: one place in the queue, no second model to load, so it suits a modest GPU. On a cloud model (ChatGPT, Claude…) the three roles are asked separately and at the same time. No fixed personas to set up. Switch on **Allow tools** and the three roles each search the web on their own, at the same time, without seeing each other's searches. [Read more](docs/features.md#parallel-bots)

### 🤝 A Chief of Staff that builds its own team

Your primary bot is a coordinator. When a job splits into independent parts (comparing products, checking several sites), it **creates helper bots on its own**, gives each a task, runs them at the same time and combines their answers. Helpers' approvals and questions show up in your chat. [Read more](docs/features.md#coordinators-and-helpers)

### And everything else you'd expect

- **Real tools with approvals:** files in each bot's own folder, terminal commands, web pages, a real browser (Edge/Chrome) you can watch and take over, web search, and its own Docker desktop computer.
- **Visual Bots** that browse by looking at screenshots and clicking, like a person. Each bot keeps its own browser sign-ins, and after you solve a site's check it carries on by itself.
- **Group chats** of 2–6 bots with @mentions; what a coordinator and its helpers say to each other is kept apart, in **Bot conversations** you can read any time.
- **Routines:** weekly schedules, intervals, one-time runs, webhooks, and "Teach a task".
- **Connect apps** through any MCP server, with per-tool toggles, one-click sign-in (OAuth) and read-only access per bot.
- **Vault** for logins, cards and contact info in your OS keychain; passwords never reach the model, and saved secrets are hidden from tool output and logs.
- **Choose each bot's tools**, and answer its questions with one tap.
- **Problems in plain words**: errors say what happened and offer **Try again** or **Switch model**; a stalled model is cut off, an unanswered approval expires, unread chats get a badge, and an event log per chat helps when something went wrong.
- **Memory, skills and templates:** see and edit what each bot remembers, save `/skills`, share a bot as a template.
- **Voice:** dictation and read-aloud. **Library:** keep the replies worth keeping.
- **Command palette** (Ctrl+K), keyboard shortcuts, light and dark themes.

See the full [feature guide](docs/features.md).

## Quick start

You need **[Node.js 24+](https://nodejs.org)**, **[pnpm 10](https://pnpm.io/installation)** and, for local models, **[Ollama](https://ollama.com/download)**.

```sh
git clone https://github.com/00Ahmad/FreeBird.git
cd FreeBird
pnpm install
pnpm dev
```

The app opens, finds Ollama (and starts it if needed), lets you pick or download a model, and creates your first bot. Pick a **tool-capable model of 4B or more**: `qwen3.5:9b` and `nemotron-3-nano:4b` are tested. 1B models are unreliable with tools. Visual Bots need a model that can see pictures, such as `qwen3.5:9b`.

Prefer a cloud model? Open **Settings → Models & Providers**, add a key and pick a model. Full walkthrough: [Getting started](docs/getting-started.md).

**Windows installer:** `pnpm package` builds `apps/desktop/release/FreeBird-Setup-<version>.exe`. On macOS and Linux, run from source for now.

## Documentation

| Guide                                              | What's in it                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)         | Install, first run, choosing a model, your first bot                                            |
| [Feature guide](docs/features.md)                  | Every feature: chats, tools, approvals, browser, computer, routines, apps, vault, memory, voice |
| [Races & Clusters](docs/races-and-clusters.md)     | The two multi-bot modes FreeBird adds                                                           |
| [Models & providers](docs/models-and-providers.md) | Local runtimes, cloud providers, the shared model, performance tuning                           |
| [Privacy & security](docs/privacy-and-security.md) | What stays local, how approvals and secrets work                                                |
| [Architecture](docs/architecture.md)               | How the desktop shell, UI, harness and engine fit together                                      |
| [Development](docs/development.md)                 | Building, testing, evals, packaging, project layout                                             |
| [Troubleshooting & FAQ](docs/troubleshooting.md)   | Common problems and answers                                                                     |

## How it works, in one picture

```
Electron shell ── loads ── React UI
      │                       │  HTTP commands + one SSE event stream (token-protected, 127.0.0.1 only)
      └── starts ──────► Harness (local server) ── engine (agent loop) ── tools · approvals · routines
                               │
                               ├── shared local model runtime ── Ollama / LM Studio / vLLM / llama.cpp
                               ├── cloud providers ── OpenAI · Anthropic · Gemini · Groq · xAI · …
                               └── SQLite store · OS keychain vault · browser · Docker computer
```

One local model serves every bot: it stays loaded, every request uses the same options so it never reloads, and a priority queue shares it fairly (your chats first, then routines, then background work). Details in [Architecture](docs/architecture.md).

## Privacy

Everything lives on your computer: chats, bots, memory and files in a local SQLite database and folders, secrets in your OS keychain. With a local model, nothing leaves your machine. FreeBird has no telemetry and no account. When you choose a cloud model, only that bot's conversation goes to the provider you picked. See [Privacy & security](docs/privacy-and-security.md).

## Contributing

FreeBird is young and there's lots to do: new providers, macOS and Linux installers, Playwright end-to-end tests, translations, docs and more. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

- 🐛 Found a bug? [Open an issue](https://github.com/00Ahmad/FreeBird/issues/new/choose).
- 💡 Have an idea? [Suggest a feature](https://github.com/00Ahmad/FreeBird/issues/new/choose).
- 🍴 Want to build on it? Fork it: it's MIT licensed.
- ⭐ Like it? Star it so others can find it.

## License

[MIT](LICENSE). FreeBird is an independent project and is not affiliated with any AI company. The providers it can connect to are used with your own API keys.

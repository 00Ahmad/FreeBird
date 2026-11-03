# Getting started

This guide takes you from nothing to chatting with your first bot, on a local model or a cloud one.

## 1. Install the requirements

| You need                 | Why                                 | Get it                                             |
| ------------------------ | ----------------------------------- | -------------------------------------------------- |
| **Node.js 24 or newer**  | Runs the app and its local server   | [nodejs.org](https://nodejs.org)                   |
| **pnpm 10**              | Installs the project's packages     | `npm install -g pnpm`                              |
| **Ollama** (recommended) | Runs AI models on your own computer | [ollama.com/download](https://ollama.com/download) |
| Git                      | To download the source              | [git-scm.com](https://git-scm.com)                 |

Optional extras, only for the features that use them:

- **Microsoft Edge or Google Chrome**: the bots' web browser. FreeBird drives the browser you already have installed, with a separate profile just for bots.
- **Docker Desktop**: gives each bot its own Linux desktop computer.
- **API keys** for cloud providers (OpenAI, Anthropic, Gemini, Groq, xAI and others).
- An **OpenAI-compatible transcription endpoint** for voice dictation.

## 2. Download and start FreeBird

```sh
git clone https://github.com/00Ahmad/FreeBird.git
cd FreeBird
pnpm install
pnpm dev
```

`pnpm dev` starts the local server, the interface and the desktop window. To use FreeBird in your own browser instead of the desktop window, run `pnpm dev:web` and open <http://127.0.0.1:5173>.

On Windows you can also build an installer with `pnpm package`; it lands in `apps/desktop/release/`.

## 3. Choose a model

On first start FreeBird looks for Ollama at `http://127.0.0.1:11434` and starts it if it's installed but not running. The **Set up your local model** screen then lets you:

- **Choose the shared model** from the models you already have, or
- **Download one** with a live progress bar.

Pick a model that can use tools, **4B parameters or larger**. Tested and recommended:

| Model                | Size | Notes                                                                                                 |
| -------------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| `qwen3.5:9b`         | 9.7B | Best all-rounder in our tests: tools, vision, thinking. Fits an 8 GB GPU at the default context size. |
| `nemotron-3-nano:4b` | 4B   | Faster and smaller; good for simple tasks and helpers.                                                |

Models of 1B are too unreliable with tools. See [Models & providers](models-and-providers.md) for tuning and for other local runtimes like LM Studio, vLLM and llama.cpp.

**No GPU, or prefer the cloud?** Skip local setup: open **Settings → Models & Providers**, choose a provider, paste your API key, press **Test**, and pick a model. Keys are stored in your operating system's keychain.

## 4. Meet your first bot

FreeBird creates your first bot and makes it your **Primary Bot**. It's a coordinator: it can create helper bots and hand them work when a job has several independent parts.

Try a few things:

- _"What can you do?"_
- _"Make a file called ideas.md in your folder with five blog post ideas about home gardening."_ The bot works in its own folder without asking.
- _"Compare the latest prices of three e-readers on their makers' sites and give me a table with sources."_ Watch it plan the job, create helpers and combine their answers.
- _"Run `git --version`."_ Commands always show an approval card first: **Allow once**, **Always allow** (for safe kinds of actions) or **Deny**.

## 5. Grow your team

From the **+** button in the sidebar:

| Item                     | What it makes                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Create a Bot**         | A new bot with its own name, avatar, instructions, model, folder and memory.                                            |
| **New Visual Bot**       | A bot that uses the web only by looking at the screen, like a person.                                                   |
| **New group chat**       | A chat with 2–6 bots. Use `@Name` or `@everyone` to choose who answers.                                                 |
| **New cluster**          | A moderated debate between 3–5 bots on a topic. See [Races & Clusters](races-and-clusters.md#clusters).                 |
| **New race**             | 3–5 bots compete on one task and a judge compiles the best result. See [Races & Clusters](races-and-clusters.md#races). |
| **Import bot template…** | A bot someone shared with **Share as template**.                                                                        |

Open a bot's **Details** panel (Ctrl+Alt+B, or Cmd+Shift+I on a Mac) to change its avatar, instructions and model, read and edit its memory, add skills and browse its files.

## 6. Learn the shortcuts

Press **Ctrl+/** (Cmd+/ on a Mac) for the full list. The most useful:

| Shortcut              | Does                                    |
| --------------------- | --------------------------------------- |
| Ctrl+K                | Search bots, chats and actions          |
| Ctrl+N / Ctrl+Shift+N | New bot / new group chat                |
| Ctrl+1…9              | Jump to a bot in the sidebar            |
| Ctrl+Tab              | Cycle through bots                      |
| Ctrl+[ / Ctrl+]       | Back / forward                          |
| Ctrl+I                | Focus the message box                   |
| Ctrl+L                | Quote the selected text in your message |
| Ctrl+D                | Dictate                                 |
| Ctrl+B                | Compact sidebar                         |
| Ctrl+,                | Settings                                |

## Where your data lives

|                               | Installed app                       | Running from source                 |
| ----------------------------- | ----------------------------------- | ----------------------------------- |
| Chats, bots, memory, settings | `%APPDATA%\FreeBird\data` (Windows) | `.data/` in the project folder      |
| Each bot's files              | `…\data\workspaces\<bot id>`        | `.data/workspaces/<bot id>`         |
| API keys, vault logins        | OS keychain, service "FreeBird"     | OS keychain, service "FreeBird Dev" |

`.data/` is listed in `.gitignore`, so your chats can never end up in a commit.

## Next steps

- [Feature guide](features.md): everything FreeBird can do.
- [Races & Clusters](races-and-clusters.md): the multi-bot modes FreeBird adds.
- [Troubleshooting](troubleshooting.md) if something doesn't work.

# Troubleshooting & FAQ

## Common problems

### "Ollama is not reachable"

- Install Ollama from [ollama.com/download](https://ollama.com/download). FreeBird starts it for you when it's installed but not running.
- If Ollama runs on another computer or port, set the address in **Settings → Local model → Ollama address**.
- Check it yourself: open <http://127.0.0.1:11434> in a browser; it should say "Ollama is running".

### Ollama is running but lists no models

Ollama may be looking in the wrong folder, so FreeBird shows no models even though they are still on disk. Check the **`OLLAMA_MODELS`** environment variable and **Model location** in Ollama's own settings: it must be your models folder (by default `%USERPROFILE%\.ollama\models` on Windows, `~/.ollama/models` elsewhere), not its parent. After fixing it, restart Ollama. `ollama list` in a terminal shows what Ollama sees; if it's empty there too, the problem is in Ollama's setup, not in FreeBird.

### "unable to load model"

Ollama found the model but couldn't load it. The usual reason is an Ollama that is older than the model: run `ollama --version` and update Ollama from https://ollama.com/download (or from the Ollama app's menu). It can also mean the model file is damaged; pull it again with `ollama pull <model>`. A Coding Bot retries a model that fails to load twice and then stops with this error; change the role's model under **Models** and press **Resume**, or send the brief again.

### A command rule no longer allows a command

Custom Rules for terminal commands only cover the command itself. If anything after the rule's text could chain or inject another command (`;`, `&`, `|`, a backtick, brackets, `<` or `>`, `$(`, a new line, `iex`, or a flag like `-e`), the command asks first, even though the rule matches its start. Approve it once, or write the rule for the exact command.

### Parallel Bots with tools answers without searching

Each role decides for itself whether it needs to search, and a small model often answers from what it remembers, which can be out of date. Ask for current facts plainly ("look up the latest version"), or use a larger model.

### "No model is selected"

Pick a shared model in **Settings → Local model**, or give the bot its own model in its **Details** panel.

### Replies are slow

- The first message after a start loads the model; later ones are faster. **Keep loaded** keeps it in memory (default 30 minutes).
- Check **Settings → Local model → Loaded now**. If part of the model sits in RAM instead of GPU memory, lower the **context size** or use a smaller model.
- **Thinking** makes thinking models slower. Leave it off unless a task needs careful reasoning.
- Helpers and racers on the same local model take turns when **Bots at once** is 1. Raise it if your GPU has room.

### The bot says it will do something, then stops / tool calls fail

Small models are less reliable with tools. Use a tool-capable model of **4B or more** (`qwen3.5:9b` works best in our tests), or give that bot a cloud model. 1B models are not recommended.

### "Waiting for the model…"

Another bot, routine or background job is using the shared model. Your chats always go first. Raise **Bots at once** to run more at the same time.

### The browser doesn't open

FreeBird needs **Microsoft Edge or Google Chrome** installed. Settings are in **Settings → Browser & search**. If a site shows a sign-in, the bot hands it to you: sign in in the bot's browser window or the chat's Browser panel, then tell the bot you're done.

### Sites keep showing CAPTCHAs or "verify you're human"

- **Solve it once and the bot carries on by itself.** The bot's window comes to the front; once the check is gone, the bot goes on without you replying. The site remembers it in that bot's browser profile, so it rarely asks again.
- **Turn on Notify me** in the bot's Details, so you get a desktop notification when it needs you instead of watching it.
- **Google is the strictest.** Bots search on Bing first; ask for Google only when you need it. Many searches in a short time from one connection make Google flag it for a few hours.
- **For text bots, a search API** (Brave Search or your own SearXNG, in **Settings → Browser & search**) gives search results with no checks at all.
- Keep **Look like an ordinary browser** on (the default) and the window shown: hidden windows are challenged more.

### The bot's computer won't start

Install and start **Docker Desktop**. The first start downloads the desktop image, which takes a while.

### Dictation doesn't work

Dictation needs an OpenAI-compatible transcription endpoint. Set it up in **Settings → Voice**, and allow microphone access in your system settings.

### An approval card or question shows "No longer waiting"

The turn that asked was stopped. Send your message again.

### "A secret can be at most 1,280 characters long"

The Windows keychain can't hold more, so FreeBird applies the same limit everywhere. API keys and passwords are far shorter; if you are pasting a very long token, check that you copied only the token. Sign-ins to connected apps may be longer and are handled for you.

### A routine's webhook address stopped working

FreeBird tries to reuse the same local port at every start. If another program was using it, FreeBird picked a different one; copy the address again from the routine.

### `pnpm install` fails

Use **Node.js 24 or newer** and **pnpm 10** (`node --version`, `pnpm --version`). On Windows, enable long paths if you see "Filename too long" errors from git.

## FAQ

**Is it free?** Yes. FreeBird is MIT licensed. Local models cost nothing; cloud providers bill you directly for what you use with your own key.

**Does it work offline?** Yes, with a local model: chats, files, memory and routines all work without internet. Web search and browsing need a connection, of course.

**Is it affiliated with an AI company?** No. FreeBird is an independent open-source project with its own code, name and design.

**Can I use xAI's Grok models?** Yes: add the **xAI** provider with your API key.

**Can every bot use a different model?** Yes, including a mix of local and cloud models, even within one race or cluster.

**Where is my data?** On your computer only. See [Privacy & security](privacy-and-security.md).

**Does it run on macOS and Linux?** From source, yes (CI tests all three systems). Installers exist for Windows only so far.

**How do I make bots run in parallel?** Raise **Bots at once** in **Settings → Local model**, or give some bots cloud models.

**My question isn't here.** Ask in [GitHub Issues](https://github.com/00Ahmad/FreeBird/issues).

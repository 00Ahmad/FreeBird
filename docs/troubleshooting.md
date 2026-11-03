# Troubleshooting & FAQ

## Common problems

### "Ollama is not reachable"

- Install Ollama from [ollama.com/download](https://ollama.com/download). FreeBird starts it for you when it's installed but not running.
- If Ollama runs on another computer or port, set the address in **Settings → Local model → Ollama address**.
- Check it yourself: open <http://127.0.0.1:11434> in a browser; it should say "Ollama is running".

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

FreeBird needs **Microsoft Edge or Google Chrome** installed. Settings are in **Settings → Browser & search**. If a site shows a human check or a sign-in, the bot hands it to you: solve it in the bot's browser window or the chat's Browser panel, then tell the bot you're done.

### The bot's computer won't start

Install and start **Docker Desktop**. The first start downloads the desktop image, which takes a while.

### Dictation doesn't work

Dictation needs an OpenAI-compatible transcription endpoint. Set it up in **Settings → Voice**, and allow microphone access in your system settings.

### An approval card or question shows "No longer waiting"

The turn that asked was stopped. Send your message again.

### `pnpm install` fails

Use **Node.js 24 or newer** and **pnpm 10** (`node --version`, `pnpm --version`). On Windows, enable long paths if you see "Filename too long" errors from git.

## FAQ

**Is it free?** Yes. FreeBird is MIT licensed. Local models cost nothing; cloud providers bill you directly for what you use with your own key.

**Does it work offline?** Yes, with a local model: chats, files, memory and routines all work without internet. Web search and browsing need a connection, of course.

**Is it affiliated with xAI or Grok Bot?** No. FreeBird is an independent open-source project modelled on how Grok Bot works, with its own code, name and design.

**Can I use xAI's Grok models?** Yes: add the **xAI** provider with your API key.

**Can every bot use a different model?** Yes, including a mix of local and cloud models, even within one race or cluster.

**Where is my data?** On your computer only. See [Privacy & security](privacy-and-security.md).

**Does it run on macOS and Linux?** From source, yes (CI tests all three systems). Installers exist for Windows only so far.

**How do I make bots run in parallel?** Raise **Bots at once** in **Settings → Local model**, or give some bots cloud models.

**My question isn't here.** Ask in [GitHub Issues](https://github.com/00Ahmad/FreeBird/issues).

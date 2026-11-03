# Changelog

All notable changes to FreeBird. The format follows [Keep a Changelog](https://keepachangelog.com), and the project uses [semantic versioning](https://semver.org).

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

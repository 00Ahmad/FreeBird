# Models & providers

FreeBird works with local models, cloud models, or both. Every bot can use a different one.

## The shared local model

By default every bot uses **one shared local model**, so a team of ten bots needs the memory of one model, not ten. FreeBird keeps it efficient:

- **Warm-up**: the model loads when the app starts, so your first message is fast.
- **Keep loaded**: every request carries a `keep_alive` (default 30 minutes), so the model doesn't unload while you work.
- **Same options every time**: every request uses the same context size and options, so Ollama never reloads the model between bots.
- **A fair queue**: at most **Bots at once** requests use the model at the same time. Others wait in a priority queue: your chats first, then routines, then background work such as summaries and group-chat routing. The chat shows _"Waiting for the model…"_ while a bot waits.
- **Only while generating**: a bot holds its place only while the model is actually writing. Waiting for your approval or your answer never blocks other bots.

All of this is in **Settings → Local model**:

| Setting        | Default                  | What it does                                                                                                                                                                                                   |
| -------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared model   | (chosen at first start)  | The model every bot uses unless it has its own                                                                                                                                                                 |
| Context size   | 32,768 tokens            | How much conversation the model sees. 32k suits tool-heavy work and fits a 9B model on an 8 GB GPU; 64k fits a 12 GB GPU. Loaded models show how much sits in GPU memory and how much spilled into slower RAM. |
| Keep loaded    | 30m                      | How long the model stays in memory after the last request (`-1` = forever)                                                                                                                                     |
| Bots at once   | 1                        | How many requests run on the model at the same time. Raise it if your GPU has room, so helpers and racers run in parallel.                                                                                     |
| Thinking       | Off                      | Lets thinking models (like `qwen3.5`) reason before answering: better on hard tasks, slower                                                                                                                    |
| Ollama address | `http://127.0.0.1:11434` | Point to Ollama on another computer if you like                                                                                                                                                                |

The same page lists **loaded models** with their memory use (with an **Unload** button) and can **download models** with live progress. The model picker marks models that are **Loaded now**.

### Choosing a local model

Bots use tools, so pick a model that supports them, **4B parameters or more**:

| Model                | Tested result                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `qwen3.5:9b`         | Passes the file-task and coordinator evals; sees images; can think. Our default recommendation.       |
| `nemotron-3-nano:4b` | Passes the file tasks; completes coordinator tasks but is sloppier with helper names. Good for speed. |
| `llama3.2:1b`        | Unreliable with tools. Not recommended.                                                               |

Visual Bots need a model that can see images; with an Ollama model that can't, the reply says so. In the Visual Bot evals (a JavaScript shop, YouTube and Google, run several times each), `ornith-1.5:9b` was the most consistent, `maternion/mimo-v2.6:9b` close behind, and `qwen3.5:9b` sometimes answered before opening the page it was asked to open. Run the evals yourself to compare models on your hardware: see [Development](development.md#evals).

Models without native tool calling still work: FreeBird falls back to a text protocol where the model writes tool calls in its reply, though results are better with native tools.

## Other local runtimes

Add these in **Settings → Models & Providers**. They're marked as local, so they cost $0 in the usage meter:

| Preset                    | Default address            |
| ------------------------- | -------------------------- |
| LM Studio                 | `http://127.0.0.1:1234/v1` |
| vLLM                      | `http://127.0.0.1:8000/v1` |
| llama.cpp server          | `http://127.0.0.1:8080/v1` |
| Jan                       | `http://127.0.0.1:1337/v1` |
| LocalAI                   | `http://127.0.0.1:8080/v1` |
| Ollama (another computer) | the address you give       |

## Cloud providers

Bring your own API key. Keys are stored in your operating system's keychain, never in a file, and the app only ever shows their names.

| Provider                 | Notes                                       |
| ------------------------ | ------------------------------------------- |
| OpenAI                   |                                             |
| Anthropic                | Native Messages API, including thinking     |
| Google Gemini            | Through Google's OpenAI-compatible endpoint |
| Groq                     |                                             |
| xAI                      | Grok models                                 |
| Mistral                  |                                             |
| DeepSeek                 |                                             |
| OpenRouter               | Hundreds of models behind one key           |
| Together AI              |                                             |
| Fireworks AI             |                                             |
| Cerebras                 |                                             |
| Azure OpenAI             | Needs your resource's address               |
| Ollama Cloud             |                                             |
| **OpenAI-compatible**    | Any server that speaks the OpenAI API       |
| **Anthropic-compatible** | Any server that speaks the Anthropic API    |

For each provider you can **test the connection**, list its models, turn it on or off, replace the key or remove it. Then:

- set a bot's model in its **Details** panel,
- switch models **mid-conversation** from the chat header's model menu,
- give racers, cluster experts or helpers their own models.

Cloud adapters are unit-tested against each provider's documented API. If something doesn't work with your provider, please [open an issue](https://github.com/00Ahmad/FreeBird/issues/new/choose).

## Mixing local and cloud

Some setups that work well:

- **Everything local.** Private and free. Use `qwen3.5:9b` as the shared model.
- **Local team, cloud coordinator.** Give the Primary Bot a strong cloud model for planning and combining, and let its helpers run on the local model.
- **Model shoot-out.** Start a race with each racer on a different model, local or cloud.

## Usage

**Settings → Usage** shows input and output tokens per bot. Local models always cost $0.

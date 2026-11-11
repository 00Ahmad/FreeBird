# Development

Everything you need to build, test and change FreeBird. See [Architecture](architecture.md) for how the pieces fit together, and [CONTRIBUTING.md](../CONTRIBUTING.md) for how to send a change.

## Setup

Requirements: **Node.js 24+**, **pnpm 10**, and **Ollama** with a tool-capable model if you want to chat locally.

```sh
git clone https://github.com/00Ahmad/FreeBird.git
cd FreeBird
pnpm install
```

| Command                             | Does                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| `pnpm dev`                          | Harness + UI + Electron window, with a fresh token                    |
| `pnpm dev:web`                      | Harness + UI only; open <http://127.0.0.1:5173> in a browser          |
| `pnpm test`                         | All unit and integration tests (Vitest)                               |
| `pnpm test:watch`                   | Tests in watch mode                                                   |
| `pnpm test:ui`                      | Tests in a browser dashboard: run, search, filter, see why one failed |
| `pnpm typecheck`                    | `tsc` in every package                                                |
| `pnpm lint`                         | oxlint                                                                |
| `pnpm format` / `pnpm format:check` | Prettier                                                              |
| `pnpm build`                        | UI bundle, Electron main/preload, and the bundled harness             |
| `pnpm package`                      | Windows installer in `apps/desktop/release/`                          |
| `npx knip`                          | Unused files, exports and dependencies                                |

Development data lives in `.data/` (git-ignored) and secrets go to the OS keychain under the service name "FreeBird Dev", apart from an installed copy.

To run the built app the way it ships, with Electron starting its own harness: `pnpm build`, then `pnpm --filter @mrog/desktop start`.

## Project layout

```
apps/
  desktop/        Electron shell, packaging (build.mjs, package.mjs), app icons
  ui/             React app: components/, hooks/ (TanStack Query), lib/ (pure helpers + tests), state.ts
packages/
  shared/         Zod schemas: the UI ↔ harness contract
  harness/        Fastify server and every feature service; evals/ for real-model evals
  engine/         Agent loop
  model-runtime/  Shared local model and queue
  providers/      Provider adapters
  tools/          Built-in tools and the tool host
  store/          SQLite repos and migrations
  vault/          OS keychain
  ui-kit/         Design tokens and base components
scripts/dev.mjs   Starts everything for development
docs/             User and developer documentation
```

Packages are TypeScript source consumed directly by the workspace (no per-package build step); esbuild bundles the harness and the Electron entry points, and Vite bundles the UI.

## Conventions

- **TypeScript strict everywhere.** The UI ↔ harness contract is Zod schemas in `packages/shared`; change the schema first.
- **Migrations are append-only.** Never edit an existing migration in `packages/store/src/migrations.ts`; add a new one.
- **Comments explain why**, in short plain English, like the code around them.
- **Errors from providers are typed** (`provider_down`, `model_missing`, `invalid_key`, `quota`, `oom`, `timeout`, `bad_output`…). Map new failure modes onto them.
- **Risky tools must say so.** A tool's `risk()` decides between running and an approval card; when in doubt, ask.
- **Tests come with fixes.** Every behaviour fix gets a regression test next to the code it changes.

## Tests

`pnpm test` runs over 500 tests across all packages in about a minute. A few of them guard the documentation itself (`scripts/docs.test.ts`): every link and heading anchor in the markdown resolves, every package has the app's version and the changelog has an entry for it, the providers, built-in tools and settings pages the docs list are the ones the app has, and no personal path or address is in a markdown file. When one fails after you edit a doc or bump the version, it names what to fix. `pnpm test:ui` opens the same tests in a dashboard in your browser (Vitest UI): every file and test with its time, a search box, filters for failed, passed, skipped and slow tests, and for a failure the error, the diff and the test's code. It reruns tests as you save files. Tests that drive a real Edge are skipped when Edge isn't installed. Harness tests start a real Fastify server with an in-memory store and a fake Ollama (`packages/harness/src/testing.ts`), so they need no model. Browser tests use a local fixture shop.

## Evals

Evals run real local models on real tasks and print a pass or fail, so changes to prompts or the agent loop can be measured instead of guessed. They need Ollama with the models pulled.

```sh
# File tasks; add --allow-commands to include a shell task that runs model-written commands without approval
pnpm --filter @mrog/harness eval -- qwen3.5:9b nemotron-3-nano:4b

# The suite: offline fixture-shop tasks (search box, no guessing, plan, coordinator pipeline, visual shop, exploring a shop whose search fails, a product that isn't there);
# --live adds real-web tasks; --only=name,name picks tasks. Reports go to evals/results/ (git-ignored)
pnpm --filter @mrog/harness exec tsx evals/suite.eval.ts qwen3.5:9b

# Coordinator and helpers. Set EVAL_PROMPT to a job that never mentions helpers to test
# that the coordinator decides to use them by itself; EVAL_OLLAMA_URL runs it against an Ollama on another address
pnpm --filter @mrog/harness exec tsx evals/delegation.eval.ts qwen3.5:9b

# Parallel Bots: six questions, each sent as one request that must come back as three sections from three different
# roles. Name several models to compare them (a 9B against a 14B or a 30B); every reply is written to evals/results/
pnpm --filter @mrog/harness exec tsx evals/parallel.eval.ts qwen3.5:9b

# End-of-run reports: each model named moderates a cluster and judges a race (experts and racers spread over
# all of them); every section of the summary and the judge's report must be there. EVAL_ONLY=cluster|race
pnpm --filter @mrog/harness exec tsx evals/reports.eval.ts qwen3.5:9b ornith-1.5:9b
```

Only run `--allow-commands` on a machine where a model running commands unattended is acceptable.

## Packaging

`pnpm package` builds a per-user NSIS installer for Windows x64: `apps/desktop/release/FreeBird-Setup-<version>.exe`. macOS and Linux builds aren't set up yet; contributions welcome.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, on Windows, macOS and Ubuntu: install, lint, format check, typecheck, tests and build. Please make sure `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` passes before opening a pull request.

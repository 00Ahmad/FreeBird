# Contributing to FreeBird

Thanks for helping! FreeBird is a young project and every bug report, idea, doc fix and pull request makes a difference. If you like the project, a ⭐ on GitHub also helps others find it.

## Ways to help

- **Report a bug**: [open an issue](https://github.com/00Ahmad/FreeBird/issues/new/choose) with steps to reproduce, your OS, and the model and provider you used.
- **Suggest a feature**: open a feature request and describe the problem it solves.
- **Test a model**: run the [evals](docs/development.md#evals) on models you have and share the results in an issue. This helps everyone pick a good model.
- **Improve the docs**: typos, unclear steps, missing answers in the [FAQ](docs/troubleshooting.md).
- **Write code**: see the [roadmap](docs/roadmap.md) for open items. Good places to start:
  - macOS and Linux installers,
  - a Playwright end-to-end suite,
  - AWS Bedrock and Google Vertex providers,
  - local speech-to-text without a provider,
  - "Find in chat" (Ctrl+F).

## Before you start

For anything bigger than a small fix, please **open an issue first** so we can agree on the approach before you spend time on it.

## Making a change

1. Fork the repo and create a branch from `main`.
2. Set up: `pnpm install`, then `pnpm dev` (see [Development](docs/development.md)).
3. Make your change. Keep it focused: one fix or feature per pull request.
4. Add or update tests. Every behaviour fix gets a regression test.
5. Run the checks:

   ```sh
   pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
   ```

6. Open a pull request describing **what** changed and **why**, and how you tested it. Screenshots help for UI changes.

## Code guidelines

- Match the code around you: naming, structure and comment style (short comments that explain _why_).
- TypeScript strict; no `any` unless there's no reasonable alternative.
- The UI ↔ harness contract lives in `packages/shared` as Zod schemas; change it there first.
- Database changes go in a **new** migration; never edit an existing one.
- Anything a bot can do that changes, sends, buys or deletes something must go through an approval card. When in doubt, ask the user.
- Never log or return secret values.
- Don't copy code from other projects whose license doesn't allow it. FreeBird is MIT licensed.

## Commit messages

Use a short summary line in the imperative ("Fix steering when a message has images"), then details if needed.

## Code of conduct

Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

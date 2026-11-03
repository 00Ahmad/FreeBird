# Security policy

FreeBird gives AI models tools on your computer, so we take security reports seriously.

## Reporting a vulnerability

**Please don't open a public issue for security problems.** Report them privately through GitHub instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do.

We'll acknowledge your report as soon as we can, keep you updated, and credit you in the fix unless you'd rather stay anonymous.

## What counts

Examples of things we want to hear about:

- Ways to reach the local harness API without its token, or from another machine or a web page.
- Ways for a bot (or a web page it reads) to run commands, act outside its folder, send, buy or delete things **without an approval card**.
- Ways for a secret, password or API key to reach a model, a log, a page or the UI.
- Escapes from a bot's folder, browser profile or Docker computer.

Not vulnerabilities: a model making a bad choice that you then approved, or problems that need someone who already controls your user account.

## Supported versions

FreeBird is pre-1.0; security fixes go into the latest version on `main`.

See [Privacy & security](docs/privacy-and-security.md) for how FreeBird protects your data.

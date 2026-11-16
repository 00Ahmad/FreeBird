import type { BuiltinSkill } from "../types";

export const CODING: BuiltinSkill[] = [
  {
    name: "code-review",
    description:
      "Review code, a diff, a pull request or a file for bugs, security holes, missing tests and clarity, most serious first. Use when asked to review, check, audit or look over code or a change before it is merged.",
    prompt: `# Code Review

You are a senior engineer doing a careful pre-merge review. Your job is to find the problems that would hurt users or the team, prove each one, and say exactly how to fix it.

## Rules
1. **Read before you judge.** Open every changed file and the code it calls with your tools. Never review from memory or from file names.
2. **Evidence or it didn't happen.** Every finding names a file and line, and a concrete input or sequence that shows the problem. No "might be an issue" without a case.
3. **Severity first.** Bugs and security problems before style. Don't bury a data-loss bug under naming nits.
4. **Review only; don't edit.** Change files only if the user asks you to fix what you found.

## Steps
1. **Scope:** list the files and functions in the change and what the change is meant to do (from the user, the commit or the PR text).
2. **Correctness:** wrong logic, edge cases (empty, null, zero, very large, unicode), off-by-one, unhandled errors, swallowed exceptions, race conditions, resources not closed.
3. **Security:** injection (SQL, shell, path, HTML), secrets in code, unchecked input, missing permission checks, unsafe defaults.
4. **Tests:** is each risky path covered? Run the existing tests if you can.
5. **Clarity:** names, long functions, duplication, dead code. Mention only what matters.

## Output
### Verdict
One line: **Ready to merge**, **Merge after fixes**, or **Needs rework**, and why.

### Findings
For each, most serious first:
#### [Critical | High | Medium | Low] Short title
- **Where:** \`path/to/file.ext:line\`
- **Problem:** what is wrong.
- **Shows up when:** the input or steps that trigger it.
- **Fix:** the change to make (a short code snippet if it helps).

### Tests to add
- Bullet per missing test.

## Check before you finish
- [ ] Every finding has a file, a line and a triggering case.
- [ ] Nothing is reported that you didn't verify in the code.
- [ ] If you found nothing serious, you said so plainly.`,
  },
  {
    name: "debug",
    description:
      "Find and fix the real cause of an error, crash, failing test or wrong behaviour, step by step with evidence. Use when something is broken, throws an error, fails a test, or behaves differently than expected.",
    prompt: `# Debugging

You are a methodical debugger. You find the root cause with evidence, fix it with the smallest change, and prove it is fixed.

## Rules
1. **Reproduce first.** No fix before you have seen the failure yourself (run the command or test with your tools).
2. **One hypothesis at a time.** Test each with evidence (a log line, a value printed, a smaller input). Never change several things at once.
3. **Fix the cause, not the symptom.** A try/catch that hides the error is not a fix.
4. **Keep the change small** and don't refactor while debugging.

## Steps
1. **Symptom:** what happens vs what should happen, in one line each. Copy the exact error and stack trace.
2. **Reproduce:** the smallest command or input that shows it. If you can't reproduce it, say what you tried and ask for details.
3. **Locate:** follow the stack trace into the code; read the functions involved.
4. **Hypothesise and test:** list 2–4 likely causes, most likely first; check each with evidence until one is proven.
5. **Fix:** the smallest change that removes the cause.
6. **Verify:** rerun the reproduction, then the related tests. Add a test that would have caught it.

## Output
- **Cause:** one or two sentences, with the file and line.
- **Evidence:** what proved it.
- **Fix:** what you changed (file and lines).
- **Verified by:** the commands you ran and their result.
- **Follow-ups:** anything related you noticed but didn't change.

## Check before you finish
- [ ] You saw the failure before the fix and the success after it.
- [ ] The test suite still passes.
- [ ] A regression test exists, or you explained why not.`,
  },
  {
    name: "write-tests",
    description:
      "Write automated tests for a function, module or feature: normal cases, edge cases, errors and every branch, in the project's own test style. Use when asked to add tests, improve coverage, or test a change.",
    prompt: `# Writing Tests

You are a test engineer. You write tests that catch real bugs, read like documentation, and match the project's conventions.

## Rules
1. **Match the project.** Read the existing tests first and use the same framework, file layout, naming and helpers.
2. **One behaviour per test,** named for what it proves ("rejects an empty name", not "test2").
3. **Test behaviour, not implementation.** A test should survive a refactor that keeps behaviour the same.
4. **A failing test that finds a real bug is a result,** not something to bend. Report the bug.
5. **No network, real accounts or personal data** in tests; use made-up fixtures.

## Steps
1. Read the code under test and list its behaviours: inputs, outputs, side effects, errors.
2. Plan the cases: the normal case; edge cases (empty, zero, negative, very large, unicode, duplicates); invalid input and errors; each branch.
3. Write the tests, sharing setup through the project's helpers.
4. Run them with your tools; make them pass for the right reasons.
5. Check that each test can fail: briefly break the code (or reason it through) to be sure the test would catch it.

## Output
- The test file(s), written to the right place.
- **Covered:** a list of the cases.
- **Not covered:** what you left out and why.
- **Run with:** the exact command, and its result.

## Check before you finish
- [ ] The tests pass, and the whole suite still passes.
- [ ] Every test name says what it proves.
- [ ] No test depends on the order tests run in, the clock or the network.`,
  },
  {
    name: "refactor",
    description:
      "Improve the structure, naming and readability of code without changing its behaviour, in small verified steps. Use when asked to clean up, simplify, restructure, split up or tidy code.",
    prompt: `# Refactoring

You are an engineer who improves code safely: same behaviour, better structure, proven by tests at every step.

## Rules
1. **Behaviour stays the same.** No new features, no bug fixes mixed in (report bugs separately), no public API changes unless asked.
2. **Tests first.** If the code has no tests, write a few that pin down its current behaviour before changing anything.
3. **Small steps,** each one leaving the code working: rename, extract, inline, move. Run the tests after each.
4. **Don't reformat unrelated code** or touch files outside the scope.

## Steps
1. **Read** the code and note the specific problems: long functions, unclear names, duplication, deep nesting, mixed responsibilities.
2. **Safety net:** run the tests; add characterisation tests where coverage is missing.
3. **Plan** the steps in order, smallest risk first.
4. **Apply** them one at a time, running the tests after each.
5. **Review** the result: is it clearly simpler? If a step didn't help, undo it.

## Output
- **Problems found:** bullets.
- **Changes made:** one line per step (what and why).
- **Tests:** the command and result before and after.
- **Left for later:** larger changes you'd suggest but didn't make.

## Check before you finish
- [ ] All tests pass, the same ones as before.
- [ ] No behaviour or public interface changed.
- [ ] The diff contains only refactoring.`,
  },
  {
    name: "explain-code",
    description:
      "Explain what a piece of code, a file or a whole project does, how it works, how data flows, and where to start making changes. Use when asked what code does, how something works, or to onboard someone to a codebase.",
    prompt: `# Explaining Code

You are a senior engineer onboarding a colleague. You explain the code accurately, from the big picture down, at the level the reader needs.

## Rules
1. **Read it first** with your tools; never explain from file names or guesses.
2. **Big picture first,** then detail. Use the project's own names.
3. **Say what is surprising:** side effects, hidden assumptions, global state, tricky parts.
4. **Quote only short snippets** where they make a point clearer.

## Steps
1. Find the entry points (main files, exported functions, routes).
2. Follow the main path through the code and note where data comes in, changes and goes out.
3. Note the key types, modules and their responsibilities.
4. Note the non-obvious parts.

## Output
### In one paragraph
What it does and why it exists.

### How it works
- The main parts, each with its file and its job.
- How data flows between them, step by step.

### Watch out for
- Surprises, assumptions, side effects.

### Where to start
- Which file to read first, and where to make a common kind of change.

## Check before you finish
- [ ] Every file and function you named exists.
- [ ] The level matches what the user asked (overview vs line by line).`,
  },
  {
    name: "commit-message",
    description:
      "Write a clear, conventional commit message from the actual changes: a short summary line and a body explaining why. Use when asked to write a commit message or describe staged changes.",
    prompt: `# Commit Message

You are a careful engineer writing a commit message that a reviewer reading the history in a year will understand.

## Rules
1. **From the real diff.** Read the staged changes with your tools (\`git diff --staged\`, or \`git diff\` if nothing is staged). Never describe changes you didn't see.
2. **Summary line:** under 72 characters, imperative mood ("Add", "Fix", "Remove"), no full stop. Follow the project's convention if it has one (check \`git log --oneline -10\`).
3. **Body explains why,** not just what: the problem, the approach, anything a reviewer should know. Wrap at 72 characters.
4. **Call out breaking changes** and migrations clearly.
5. **Don't commit** unless the user asks.

## Steps
1. Read the diff and recent log.
2. Group the changes by purpose. If they are unrelated, suggest splitting the commit.
3. Write the summary line, then the body.

## Output
\`\`\`
<summary line>

<why this change was needed>
<what was done, briefly>
<breaking changes / migrations, if any>
\`\`\`

## Check before you finish
- [ ] The summary is under 72 characters and in the imperative.
- [ ] Every claim matches the diff.`,
  },
  {
    name: "pr-description",
    description:
      "Write a pull request description from the branch's commits and diff: what changed, why, how to test it, and the risks. Use when asked to write or improve a PR or merge request description.",
    prompt: `# Pull Request Description

You are an engineer making a reviewer's job easy: they should understand the change, know how to test it, and see the risks in two minutes.

## Rules
1. **From the real changes:** read the commits and diff against the base branch with your tools.
2. **Specific, short, scannable.** No marketing words.
3. **Link issues** the user gives you; never invent issue numbers.
4. **Don't open the PR** unless asked.

## Steps
1. Read \`git log <base>..HEAD\` and the diff.
2. Identify the user-facing change, the technical approach and anything risky (migrations, config, public API).
3. Write the description.

## Output
## What
- 2–4 bullets: the change.

## Why
The problem it solves, in 1–3 sentences.

## How to test
1. Numbered steps a reviewer can follow, with commands.

## Risks and notes
- What could break, migrations, config changes, follow-ups.

## Check before you finish
- [ ] A reviewer could test it from the steps alone.
- [ ] Every statement matches the diff.`,
  },
  {
    name: "add-docs",
    description:
      "Write or improve documentation for code: comments, docstrings, a README section or usage guide, explaining purpose, inputs, outputs and gotchas. Use when asked to document code, add comments or write a README.",
    prompt: `# Documenting Code

You are a technical writer who also reads code. You document what a reader can't see at a glance: purpose, contracts, and gotchas.

## Rules
1. **Read the code first;** document what it really does.
2. **Explain why and the contract,** not what each line already says.
3. **Follow the project's style** for comments and docs.
4. **Fix or remove wrong comments** you find.
5. **Don't change behaviour.**

## Steps
1. For each public function, class or module: what it does, its inputs (with types and limits), its output, the errors it raises, side effects, and any gotcha.
2. For a README or guide: what it is, how to install, a minimal working example, configuration, common problems.
3. Check examples actually work (run them if you can).

## Output
- The documentation written into the files, in the project's style.
- A short list of what you documented and anything you found unclear in the code itself.

## Check before you finish
- [ ] Every documented behaviour matches the code.
- [ ] Examples run as written.
- [ ] No behaviour changed.`,
  },
  {
    name: "security-check",
    description:
      "Audit code or a project for security problems: secrets in code, injection, missing auth, unsafe input handling, weak defaults and risky dependencies. Use when asked for a security review, audit, or whether code is safe.",
    prompt: `# Security Check

You are an application security engineer. You find exploitable problems, prove how they could be abused, and give a concrete fix for each.

## Rules
1. **Read the code with your tools;** follow untrusted input from where it enters to where it is used.
2. **Every finding has an attack:** who can do what, with which input.
3. **Never print a real secret** you find; give its location only.
4. **Don't upgrade or change anything** without the user's yes.

## Steps
1. **Map the entry points:** HTTP routes, CLI arguments, files read, messages received, environment.
2. **Trace untrusted input** to dangerous sinks: database queries, shell commands, file paths, HTML output, deserialisation, redirects.
3. **Check access control:** authentication, permission checks on every sensitive action, IDOR.
4. **Check secrets and config:** keys in code or repo, debug modes, wide CORS, verbose errors, weak crypto, insecure cookies.
5. **Check dependencies:** list outdated or known-vulnerable ones (run the package manager's audit if available).

## Output
### Summary
Overall risk in one line, and the top issue.

### Findings (most serious first)
#### [Critical | High | Medium | Low] Title
- **Where:** \`file:line\`
- **Attack:** who, how, with what input.
- **Impact:** what they get.
- **Fix:** the specific change.

## Check before you finish
- [ ] Each finding has a realistic attack path.
- [ ] No secret value appears in your answer.`,
  },
  {
    name: "sql-query",
    description:
      "Write, fix or optimise an SQL query from a plain-English question, using the real table and column names. Use when asked for a database query, a report from a database, or why a query is wrong or slow.",
    prompt: `# SQL Query

You are a database engineer. You write correct, readable queries against the real schema, and you never change data without a yes.

## Rules
1. **Real names only:** look up the tables, columns and database type (read the schema or migrations with your tools, or ask). Never invent a column.
2. **Readable:** one clause per line, clear aliases, a comment for anything tricky.
3. **Be explicit about NULLs, duplicates, time zones and empty results.**
4. **Changes are dangerous:** for UPDATE or DELETE, first give a SELECT that previews the affected rows, use a transaction, and never run it without the user's yes.

## Steps
1. Restate the question as: which rows, which columns, grouped how, sorted how, limited how.
2. Find the tables and join keys.
3. Write the query; for a slow one, check indexes and the query plan (EXPLAIN).
4. Test it on the data if you have access, and check the row count makes sense.

## Output
\`\`\`sql
-- what it answers
<query>
\`\`\`
- **Returns:** the columns and what each row means.
- **Handles:** NULLs, duplicates, empty results.
- **Performance:** indexes it relies on, if it matters.

## Check before you finish
- [ ] Every table and column exists in the schema.
- [ ] No data-changing statement was run without a yes.`,
  },
];

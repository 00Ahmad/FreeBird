# Changelog

All notable changes to FreeBird. The format follows [Keep a Changelog](https://keepachangelog.com), and the project uses [semantic versioning](https://semver.org).

## 0.0.18 - 2026-11-21

Fixes to the main bot (the one made with **+ → New bot**), the Job Bot and the Client Bot from three audits, aimed at small local models.

### Added

- **Client Bot: UK Find a Tender.** Public tenders above the thresholds, from the whole UK, join Contracts Finder's. No key needed. Only tenders that name what you sell are kept.
- **Client Bot: see what's new.** Leads from the latest scan are marked **New**, faded ones **Gone stale**. A line says what changed with the latest scan.
- **Client Bot: who to ask for.** Each lead shows your buyers' job titles ("Ask for the Finance Director"), and the CSV has an "Ask for" column. No person is ever looked up.
- **Client Bot: your price suggests a client size** when it states one ("for up to 50 staff"). It's a suggestion on the profile card, never applied by itself.
- **Client Bot: the stage is worked out from the official record.** Up to 2 years old is a new company, 5 or more is established, and a fresh sign of growth makes it growing.
- **Client Bot: lookalikes say which register entry each client was matched to**, so a wrong match can be spotted.
- A Client Bot benchmark for developers (`evals/client-bench.eval.ts`):
  - pages that must not become leads: a menu, a competitor, a "top 10" list, a footer, a charity post, a news site;
  - a wrong register record, a tender, a real lead, and the interview.

- **Job Bot: Check still open.** A button on the board reads each Found and Shortlisted job again, with no model, and marks the ones whose posting is gone or says it's closed. It only runs when you press it.
- **Job Bot: see what's new.** Jobs from the latest scan are marked **New**, each card shows the day it was found, and the board can sort newest first or show only new jobs.
- **Job Bot reads Ashby and SmartRecruiters job boards** through their public job lists, as it already did for Greenhouse and Lever. Lever jobs now show their posting date.
- **Job Bot: pages that need you no longer hold up a scan.** A CAPTCHA or sign-in page is set aside and the scan carries on. At the end you're asked about those pages one at a time. If you don't answer one, the rest are skipped, and the closing words say how many were left unread.
- **Job Bot remembers pages that led nowhere and searches it has run.** A page that wasn't a job, a closed or missing posting, or a job already on the board under another address is skipped for 30 days (a year for one that won't come back). Searches run in the last 14 days aren't run again.
- **Job Bot: better suggestions from your reasons.** "Too junior" suggests a seniority, and "salary too low" suggests a lowest salary just above that job's pay.
- **Job Bot: the profile card says when requirements won't be checked.** It warns when the profile has more than the Checker can take (30).
- **Job Bot: a desktop notice when a scan ends** while you're looking at another chat.
- A Job Bot benchmark for developers (`evals/job-bench.eval.ts`): real-model cases for title matching, posting dates, a long profile, an error page, a closed job in a list, a Greenhouse list and the interview.

- **Details → Memory says when old notes no longer reach the bot.** On a local model, memory now takes at most a tenth of the context window in the prompt (and at most 60 notes); when the oldest notes don't fit, the panel says how many. Cloud models keep the newest 60 notes as before.
- **Undo a bot's file change from the chat.** When a bot writes or edits a file, its card shows **Undo**, which puts the file back as it was (or removes a file the bot created). If the file was changed again since, you're asked first. The bot is told about the undo in its next turn. Copies are kept on this computer, at most 100 per bot, and none for files over 4 MB.
- **Pinned memory notes.** Pin a note in **Details → Memory** and it is always sent to the bot, however old, and the bot's `forget` can't delete it (at most 10 per bot). Notes the bot no longer sees are greyed out.
- **Wait for my answer to approvals**, per bot in **Details → Notifications**: an approval card of that bot or its helpers stays open until you answer, instead of being dropped after 15 minutes.
- `read_file` can read a file by characters (`from_char`), for minified files whose single line is longer than a read can show.
- A main-bot eval for developers (`evals/main-bot.eval.ts`): real-model cases for a message sent mid-turn, a follow-up about "those three", a job split between helpers and three such jobs in a row, recording every model request each one costs.

### Changed

- **Client Bot: scans that run while you're away.**
  - **A page that needs you no longer holds up the scan.** A CAPTCHA or sign-in page is set aside, and you're asked about such pages at the end.
  - **The time limit covers the whole scan.**
  - **The Visual helper is limited:** 3 minutes per try, every try counted, and skipped when its model can't see pictures.
  - **It's faster on a big board:** saved at most every 0.4 seconds.
  - **A saved project that doesn't fully load is kept.**
  - All of this is shared with the Job Bot now, as one copy (`harness/src/teams/`).
- **Client Bot: fewer model turns per scan:**
  - The Checker is asked only what a page can give, and never for traits (code finds them).
  - A list of providers, or a tender for another service, never reaches a model.
  - The Checker is reminded once, in the same turn, to call its tool.
  - The Searcher runs only when the app has no new searches left.
- **Client Bot: more from the same work:**
  - Registers give their next page each scan and say when they have nothing more.
  - Searches and registers cover each place and industry you serve, not just the first.
  - Pages that led nowhere and searches already run aren't repeated for a while.
  - The watch list takes at most a quarter of the scan's pages.
  - A company's contact page is read when its home page only links to it.
- **Client Bot: the interview listens better:**
  - It knows which question you're answering.
  - It doesn't ask again what it already asked or what you skipped.
  - It adds to lists instead of replacing them, removes on request, and keeps only what you said.
  - Each reply says what was saved, with the kind of service it picked.
- **Client Bot: the chat says which kinds of lead a scan will look for**, and takes "10, only tenders" or "5, no quiet fits" in the answer.
- **Client Bot: the Checker's words are labelled.** A lead's summary is marked as the Checker's, and fit lines the app checked say so.

- **Coordinators ask the model whether a job splits into parts less often.** FreeBird settles the clear cases itself: a quick message, a request for helpers, one that points back at the chat ("compare those three"), one naming a file, or one asking to write, explain or fix something is never planned, nor one that names no several things. Each skipped question saves a model request before the work starts.
- **A helper given a new task reads only that task**, not every task it was given before. Its thread with the coordinator still shows them all.
- **Helpers' answers share the room fairly.** With several long answers, each is shortened at its own end and says the full answer is in the helper's thread, instead of the last helpers' answers being cut off.
- **A coordinator no longer runs out of helpers.** At the limit of six, the helper idle longest is given the new job, name and instructions instead of the call failing. Nothing is deleted: its thread with the coordinator carries on, renamed, with a note, so its earlier work stays readable.
- **A helper whose model fails is asked once more** before the coordinator answers without it, unless it may already have changed something.
- **Only the newest three pictures you attached are sent again** on each step; older ones are replaced by a note.
- **The size of a chat in another alphabet is estimated better.** Urdu, Arabic, Russian and similar text counts about twice as much per character as English, and Chinese, Japanese and Korean about 3.5 times, so such a chat no longer overruns the model's window unnoticed.
- **Job Bot: code decides what it can, so fewer model turns per scan:**
  - Jobs on a job system's list are picked by their titles, in code, preferring places that suit you.
  - Searches are made from every title, related title, place and job system you have, a few new ones each round.
  - Search results whose title is plainly another job are dropped before they're read.
  - Workplace, pay, job title and companies to avoid are judged from the facts confirmed on the page.
- **Job Bot: the interview listens better:**
  - It knows which question you're answering.
  - It doesn't ask again what it already asked or what you skipped.
  - It adds to a list instead of replacing it, and removes an item when you say so.
  - It keeps only what you actually said.
  - Each reply ends with what was saved ("Saved: Added must-have: Go").
- **Job Bot: changing your profile updates the board.** The parts code decides, and each score, are worked out again for every job. A job read before you added a requirement says so.
- **Job Bot: the Checker's words are labelled.** A job's summary is marked as the Checker's, and match lines the app checked itself say "(checked by the app)".
- **Job Bot: when a message could mean a scan or a profile change**, the bot asks "Start a scan now, or change your profile?" instead of guessing. A number counts as the number of jobs only when it's said that way ("12 jobs"), never inside an amount like "40,000" or "50k". The Client Bot uses the same rules.
- **Job Bot: the time limit covers the whole scan.** One deadline now ends a slow page read or model turn too, as "Reached the time limit for one scan."
- **Job Bot: limits on the Visual helper.** Each try has 3 minutes, and failed tries count toward the 5 per scan. A model that can't see pictures isn't tried again that scan.
- **Job Bot: faster on a big board.** It saves and updates the screen at most every 0.4 seconds instead of on every small change. A Checker's stored task keeps only the start of the page once its turn has ended.
- **Job Bot: the cheap ways of reading are tried again.** A job system's own list is always tried first, and a note that a site needs the browser lasts 30 days, per employer, not per host. The Client Bot does the same.

### Fixed

- **Client Bot: ordinary sentences no longer pass as signs.** None of these count any more:
  - "Slow cooked tender beef" and "We recommend booking early" as asking for a provider;
  - "Registered in England and Wales" and "Established in 1987" as a new company;
  - "We raised £500 for the local hospice" or "Grant Thornton" as funding;
  - "He is on parole" as hiring.
- **Client Bot: one weak, undated sign no longer gets a company past the quiet-fit checks.**
- **Client Bot: "Brightside Kitchens" is no longer "Brightside Cleaning".** Companies sharing one word count as the same no more, so the wrong website and the wrong official record (a dissolved one) are no longer taken.
- **Client Bot: a field's name ("services", "email") can no longer become a company's name.**
- **Client Bot: a web designer's footer email is no longer offered as the company's inbox.**
- **Client Bot: "IT support for accountants" is IT support, not accounting.** The kind of service is picked from what you sell, not who it's for.
- **Client Bot: a company turned down as a quiet fit is judged again later**, instead of never.
- **Client Bot: "Forget" also deletes what was read about the lead** from the team's role threads.
- **Client Bot: a full board no longer drops a lead you're working.**
- **Client Bot: a failed scan is marked as ended, and a register that can't help says why.**
- **Client Bot: a watched company whose site couldn't be read keeps its place** in the queue.
- **Client Bot: a short home page counts as loaded in the browser**, and a site with no https is read over http (the "no secure connection" clue).
- **Client Bot: fixes found with a real 9B model in the benchmark:**
  - A tender for another service is never taken as one for yours.
  - A sign the model wrote nested under its company, or quoted only by a headline, is read.
  - A news page's own address is no longer taken as the company's website.
  - Profile fields the model wrote as JSON inside the "what you sell" field are read properly, and so are a page report's lists under another name or as JSON text.
  - A business's own hiring page is no longer "asking now" because the model called it a request.
- **Job Bot and Client Bot: "keep only what you said" accepts a word's other form.** "Accounting" for "accountants" was dropped as unsaid.
- **Job Bot: the closing words count the page nobody answered as left unread too.**
- **A message you send while the bot is working is no longer answered twice.** The reply records that it took the message in, and later turns are told so; before, the message read as new in every later turn and could be acted on again.
- **A finished answer is no longer taken for an unfinished one.** A reply ending "Let me know if…", "I'd suggest…", or a list after "Next, I recommend…" no longer gets a "carry on" nudge and an extra model request.
- **A bot going back and forth between the same two or three steps** now stops after three rounds, as one repeating the same step did, instead of using every step of the turn.
- **"ONE" from the helper planner, followed by its reasons**, no longer becomes a helper per reason.
- **`forget` can no longer empty a bot's memory.** It matches whole words, needs a word of at least four letters, and asks you before deleting more than three notes.
- **`remember` doesn't save the same note twice.**
- `edit_file` refuses a file too large to open (over 4 MB), as `read_file` does, instead of reading it all into memory.
- **Job Bot: "Product Manager" no longer matches "Senior Product Marketing Manager".** The words of a title you want must come together and in order.
- **Job Bot: posting dates are read properly.** "Posted Nov 12" was read as about 9,000 days old. Dates with no year, and day/month dates, are now read correctly.
- **Job Bot: deal-breakers are no longer dropped from a long profile.** Companies to avoid are checked by code. When the profile is too long, nice-to-haves and must-haves are cut first, and you're told.
- **Job Bot: an error page (403, 429, 500) is no longer checked as a job.** The next way of reading is tried instead.
- **Job Bot: a careers page with one closed job is no longer dropped whole.** Only a single posting that says it's closed is skipped, and the activity list says so.
- **Job Bot: changing one profile field no longer empties the others.** Editing a field on the profile card emptied your job titles and workplace.
- **Job Bot: a full board no longer drops a job you're working on.** Only Not for me and weaker Found jobs make room. When there's no room, the scan ends and says so.
- **Job Bot: a failed or stopped scan says what it found** and is marked as ended.
- **Job Bot: a saved project that doesn't fully load is kept**, with its profile and jobs, instead of being lost.
- **Job Bot: a Checker that ends without reporting is reminded once**, and its failures no longer get a site skipped.

## 0.0.17 - 2026-11-17

A release about making the Coding Bot work on small local models (9B to 27B): code holds the structure and checks the work, and the models get small, narrow tasks.

### Added

- **Skills for each Coding Bot role.** In a Coding Bot's **Details → Skills** you can give skills to the whole team, or to the Planner, the Developer or QA alone. Three new built-in skills, one each for the Planner, the Developer and QA, are assigned by default (43 built-in skills in all).
- **The Developer checks its own work.** When the Developer says a file is finished, FreeBird first checks that it parses, runs the code check on it, and (with Visual QA on, once the page's scripts exist) opens the page in a hidden tab. A problem comes back to the Developer at once, with the error and the line, up to twice per card, before QA sees it. A crash on load like `Cannot read properties of null (reading 'addEventListener')` is now caught here.
- **Done checks.** For a web page, the plan can say how to tell a file works, in four one-line forms the browser runs: `#list has items`, `#status contains "Ready"`, `click #refresh -> #list changes` and `type #task "Buy milk" then click #add -> #list contains "Buy milk"`. A check that fails goes back to its file's card. Each check starts from a fresh page with saved browser data cleared. Plan exports keep them.
- **Your messages reach the right card.** A message in the Coding Bot's chat that names one of the project's files (`movies.js:289 Uncaught TypeError…`) becomes your comment on that file's card and sends it back to the Developer, who is told your note comes first. It works while the team works, while it's stopped or waiting for you, and after it's done when you report a fault.
- **Plan problems go back to the Planner.** A file that keeps failing, or that QA says is the plan's fault, goes back to the Planner, which changes only that part of the plan (at most twice per project). Files whose plan stays the same keep their work, and with Auto-approve off you approve the change first.
- **QA sees what changed.** When QA looks at a card again, it is shown a short diff of what changed since its last review instead of rereading the whole file.
- **The exact names, read from the code.** Each Developer and QA turn is told the ids, classes, exports and imports the files around it really use, read from the code already written. The diagram has a **Planned / In the code** switch.
- **A Coding Bot benchmark** for developers: fixed briefs run on a real local model, with whether the result works (see `docs/development.md`).

### Changed

- **Auto-approve covers QA's routine commands.** With Auto-approve on, QA checks, installs and runs the project without asking. It still asks for anything that can't be undone, changes security, uses your saved secrets, touches a secret file or a path outside the project, or writes a file.
- **The code check runs on every QA pass**, not only at the end, and with Visual QA on the app is also opened by itself after every development pass. What they find goes straight back to the right card.
- **The round limit counts per card.** A card sent back that many times is set aside for you, marked so on the board, and the rest carries on. Raising the limit brings set-aside cards back. The whole project stops after three times the limit.
- **One card per file.** New plans have no separate cards for connections; each file's card covers its connections, and findings go to the file at fault. Files are built pages first, then scripts, then stylesheets.
- **Small files.** The Planner is asked for one feature per file (under about 150 lines) and a short `main.js` that starts them; the code check catches two scripts on one page declaring the same top-level name.
- **Shorter turns.** The Developer and QA see only the files their card connects to, plus the rest by name.
- **Old files in the output folder** are listed for the Planner, which is told not to build on them, and the plan says which ones it will replace.

### Fixed

- **Keys in your brief are never retyped.** An API key or token in the brief (or a later message) is taken out and kept on this computer; the team only sees a name like `{{TMDB_API_KEY}}`, and FreeBird puts the real key into the file as it is written. Before, the Developer retyped keys and got them wrong, and the brief with its keys went to every model turn.
- **A Developer turn that edits without finishing** is ended after 6 edits, and what it wrote goes on to the checks.
- **A Developer that calls `finish_card` again and again** has its turn ended after the second call.
- **A Developer or QA turn that answers without using any tool** is told once, in the same turn, what to call.
- **A Coding Bot's approval card no longer expires quietly.** The team waits for your answer, and the Coding Bot reminds you in its chat every 15 minutes.
- **The whole-project check** no longer skips QA's turn when the automatic check finds problems in files outside the plan: they are reported in the activity list, and QA is asked which planned file has to change.
- **Token counts on cards.** A stopped or failed turn keeps the tokens it used, and a turn whose model reported none is shown as unknown rather than 0.
- `search_files` given a file (not a folder) searches that file instead of failing.
- Long command output started with garbled text (`â€¦`) instead of `…`.

## 0.0.16 - 2026-11-16

### Added

- **Visual QA for the Coding Bot.** A new switch (off by default, in the new Coding Bot dialog and in the panel next to **Auto-approve**). With it on, once every card has passed and the whole-project check finds nothing, QA starts the app, opens it in its own browser tab and uses it like a person, taking screenshots, clicking, typing, and checking the console and the controls. It adds to QA's other checks and replaces none of them.
  - **How the app starts:** web pages are served by FreeBird itself. Apps with a server (Flask, Django, FastAPI, Streamlit, Gradio, Node, Express, Vite, Next.js) are started with their own command, which asks first like any command. Desktop apps (Tkinter, PyQt, Electron and others) are checked for starting and staying open.
  - **The automatic checks (no model needed):** a crash or traceback on start, browser console errors, files that fail to load, buttons that do nothing when clicked, and buttons covered by something else.
  - **What gets sent back:** everything the automatic checks find, plus what QA saw going wrong. Each problem goes back to the card it belongs to.
  - **QA's model:** it needs vision for screenshots. Without vision, QA tests from the screen map and console, and the panel says so.

### Changed

- **New logo**, with a transparent background: the app icon, the installer and the logo inside the app.

## 0.0.15 - 2026-11-16

### Changed

- **One local model in memory at a time.** When bots use different local models (a Coding Bot's Planner, Developer and QA, say), each is loaded for its own turn and the others are unloaded first; bots on the same model share it. On by default in **Settings → Local model → One model at a time**; turn it off if your GPU fits several models. It never unloads a model another bot is still replying with.

### Fixed

- **Changing a Coding Bot role's model frees the old one.** Unloading only happened for the shared model and a bot's model menu; now any model change (a team's roles, a deleted bot) unloads a model nothing is set to use any more.

- **Gemini 3 models work with tools.** Gemini 3 gives each tool call a "thought signature" that must come back with the call on the next request; FreeBird dropped it, so any bot using tools on Gemini 3 failed on its second step ("Function call is missing a thought_signature"). The signature is now kept with the call, saved with it in the chat, and sent back.

## 0.0.14 - 2026-11-16

### Added

- **Bots use skills by themselves.** With **Can use skills** on (the default, in **Details → Skills**), a bot looks up the skill that fits a task (`find_skills`) and follows it (`use_skill`); each use shows in the chat. A Coding Bot's switch covers its Planner, Developer and QA, which each use the skills their work needs. Skills now have a "when to use" line, and typing `/name` still runs one.
- **40 built-in skills**, shared by every bot: writing, coding, research, business, planning and data. Each is written to one standard: an expert role, rules with reasons, the steps, an exact output format and a final checklist. You can edit or delete them; a deleted one doesn't come back, and an unedited one gets the newer text when a later version improves it.

### Changed

- **Models no longer hold your memory after you're done.** Changing the shared model unloads the old one before loading the new one, and a bot switched to another model unloads its old one, unless the shared setting or another bot still uses it (a reply being written on it finishes first). Closing FreeBird unloads every model it loaded and stops Ollama if FreeBird started it. Both are switches in **Settings → Local model → When FreeBird closes**, on by default. An Ollama you started yourself is never stopped.

## 0.0.13 - 2026-11-15

### Added

- **Client Bot.** **+ → New Client Bot** makes a bot that interviews you about what you sell and who your ideal client is, then finds businesses that may need it, only when you ask. It never searches for your service by name, which finds competitors; it looks for signs that a business needs you instead (hiring for your kind of work, opening a new site, raising money, asking for a provider). Leads come in three kinds: **asking now** (UK public tenders and "seeking a provider" posts), **with signs**, and **quiet fits** (good fits that never posted anything, from UK Companies House with your free API key and the UK food hygiene register). Quiet fits must be confirmed by an official record and their own website, and are re-checked for new signs each time you scan. Ready-made playbooks cover payroll, accounting, marketing, software development, IT support and recruitment, with a general one for anything else. Every fact and sign is quoted from its page or record. Contact routes are found by the app and are company-level only, never guessed. Your clients, competitors and do-not-contact list are never shown. Lookalikes of your best clients, a board from New to Won, CSV export, and suggestions from your reactions. Nothing is ever sent for you. See [the Client Bot guide](docs/client-bot.md).

### Changed

- **A new logo** for the app, its installer and the sidebar.

## 0.0.12 - 2026-11-14

### Added

- **Job Bot.** **+ → New Job Bot** makes a bot that interviews you about the job you want, then finds and checks jobs that fit you, only when you ask. Each scan asks how many new jobs to find and counts only jobs that match you (weaker ones still go on the board) and that you haven't been shown before. Every fact on a job card must be quoted from the posting it was read from ("Not stated" otherwise), and the match score is worked out line by line from your requirements, with warning signs such as old postings, no salary or scam wording. Pages are read the cheapest way that works (a job system's public list, the page as text, the bot's browser, then a Visual helper as the fallback), and a CAPTCHA or sign-in is handed to you. Reactions with a reason suggest profile changes you can accept. See [the Job Bot guide](docs/job-bot.md).

## 0.0.11 - 2026-11-14

### Added

- **API keys already on your computer are found for you.** Settings → Models & Providers lists keys set as environment variables for your account (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and the others) under **Found on this computer**, with one-click **Add**. The screen never sees the key; Add copies it into the keychain exactly as a pasted key would. Pasting a key works as before.

### Changed

- **Parallel Bots on a cloud model asks the three roles separately, at the same time.** Without Allow tools, a cloud model (ChatGPT, Claude, Gemini and the others) now gets one short request to pick the roles and then one request per role, all at once, so the answers fill in side by side and a role can't echo another; it uses about three times the input tokens. A local model still sends one request with three sections, and Allow tools is unchanged. Switch it off in **Settings → Local model → Parallel Bots on cloud models: ask each role separately** to use one request on cloud models too.

## 0.0.10 - 2026-11-14

### Security

- **Commands bots run no longer get FreeBird's access token.** Every command inherited the app's environment, including the token that unlocks its local API, so code run by an approved command (an install script, or code a bot wrote) could have switched approvals off. Commands now get a clean environment, and the app drops the token from its own environment after reading it.
- **Typed command rules can't be chained.** A Custom Rule for a terminal command only covers the command itself, so a rule for `npm` no longer lets `npm i; Remove-Item …` or a command with `|`, `&`, `$(`, brackets, redirects or `iex` through. This is stricter than before: commands such as `npm i -E`, `xcopy /e`, `node -e …` or `echo (Get-Date)` now show a card even if a rule used to allow them, and a `run_command` rule with no text only covers plain commands.
- **A Coding Bot's team only writes the files of its plan.** Writes to other files, to `.git`, `node_modules` or editor settings that run commands (`.vscode/tasks.json` and similar) are refused; plans can't list them either. Its roles can't read `.env` files or private keys. Its commands always ask, even with commands set to always allow.
- **Output folders can't be network paths** (`\\server\share`, `\\localhost\C$…`), names ending in a dot or space, or device names; such folders got past the folder rules, and one ending in a dot made commands run in the home folder.
- **A hostile plan file can no longer freeze the app** (the plan reader is linear and refuses more than 1 MB).

### Added

- **Parallel Bots can use tools.** With **Allow tools**, the three roles each run as their own conversation at the same time, each with its own web searches and pages, which the others never see; each card shows its own searches, steps, sources and answer. Two settings: roles writing at once (default 3) and steps per role (default 6). **Bots at once** and Races are unaffected.
- **A finished Coding Bot project can be changed**: type what you want changed, the Planner updates the plan, and only what changed is built again. A plan can also be imported after a project is done, stopped or failed, and a failed plan can be given a new brief.

### Fixed

- **The Coding Bot's Developer no longer gets stuck reading.** It was told to read files a later card writes, read up to 21 files per try and wrote nothing; now it only reads written files (at most 6 per try), is told when 3 rounds are left, retries are told what went wrong, a written file counts even without "finished", and model errors are retried instead of ending the project.
- **Stopping, clearing or deleting a Coding Bot's team conversation no longer leaves the project stuck** "working"; deleting, duplicating or renaming the team on its own is refused.
- **The whole-project check no longer fails normal TypeScript projects** (`import type`, `export interface`, `.js` imports of `.ts` files, commented `tsconfig.json`, missing images), and it catches more made-up keys (`OPENWEATHER_API_KEY`, `sk-proj-…`, `appid=` in a URL, `.env` lines).
- **QA's instructions no longer contradict themselves** about placeholders.
- **Bots in a bot-to-bot conversation** (a helper's or a Coding Bot role's) are no longer told to ask a short question when something is unclear, since nobody is there to answer: they make a sensible choice and say what they assumed.
- **The Coding Bot screen:** no desktop notification or unread count for each team reply; "Finished" and "Error" clear once seen; passes are no longer counted as failures; the panel no longer squeezes the chat away (it becomes a drawer in narrow windows); the message box's Stop stops the team; resetting the board on import has its own confirmation; big diagrams no longer draw lines behind boxes; plus focus, screen reader and export fixes.

## 0.0.9 - 2026-11-13

### Fixed

- **A Coding Bot could finish a project that didn't work.** In a real run, a weather app was "done" although its page loaded a file that uses `import` with a plain `<script>`, and its config held an invented API key. Four gaps are closed:
  - **Stale passes are re-checked.** After every Developer turn, any finished card that touches a changed file goes back to QA (the file's card and every connection linking it), not only when a file card is sent back.
  - **A whole-project check runs before "done".** Automatic checks look for plain scripts loading `import`/`export` files, missing files and imports, ids no page has, JSON that doesn't parse and key-like literals, and send the right card back with a comment. If they find nothing, QA gets one last turn to look across the files.
  - **QA remembers.** Its message includes what was said about the files around the card, and it is told which shell its commands run in (PowerShell on Windows, so no `&&`), and to check things for real.
  - **Nobody invents secrets.** The Developer and QA use a clearly marked placeholder such as `YOUR_API_KEY_HERE`; QA accepts it and fails a made-up key.
- **The closing message lists what you must do** ("Before you run it": add your own API key, open it through a local web server).

## 0.0.8 - 2026-11-12

### Changed

- **The Coding Bot's Developer is much faster and more focused.** A real run on a reasoning model took about 30 minutes and 1.5 million input tokens per card, because the Developer wrote other cards' files too, made helper and check scripts and re-read the whole project. Now each Developer turn is told to write only its own card's file and read only the files the card connects to, a write to another card's file is refused, it takes at most 15 steps, thinking is off for it on Ollama models, and it can't run commands (QA runs and tests the code, each command still asks you first).
- **A file the team already wrote in this project is not written again.** After a restart or Resume its card goes straight to QA, unless QA has already sent it back or the file is older than the project.

### Added

- **Time and tokens on every card**, with a live timer, a total in the panel header, and an amber **Slow** warning (with a log line and a note) when a card takes more than 10 minutes.

## 0.0.7 - 2026-11-12

### Added

- **Coding Bot.** **+ → New Coding Bot** makes a team of three roles, each on its own model, that builds a project in an output folder you choose: the **Planner** draws the files and how they connect, you approve the plan (or switch on auto-approve), the **Developer** writes it one card at a time, and **QA** checks every file and every connection, sending anything wrong back to Todo with a comment. It repeats until everything passes or the QA round limit (5 by default, changeable up to 20) is reached, then it stops and asks you.
- **A diagram, a board and a checklist** beside the chat: files as boxes with what their code should do, connections of any size as junctions, four board columns with QA's comments on the cards, and a checklist of every file and connection.
- **You can see what is happening:** who is working now, coloured and ringed boxes, a progress bar, a status banner with the next step, a sidebar badge and a desktop notification when it needs you, and an activity list.
- **Export and import the plan** (JSON, Markdown, Mermaid, SVG, project snapshot). Import a plan written by another model, with a preview and a warning for files that already exist. It still waits for your approval. **Copy planning prompt** gives you text to paste into a flagship model. See [Coding Bot](docs/coding-bot.md).
- **Choose a folder** in the desktop app with a Browse button.

## 0.0.6 - 2026-11-12

### Fixed

- **Clicking a helper bot opened a blank chat.** A helper's own chat with you has nothing in it, because its work comes from the coordinator, and the conversation was only in **Bot conversations** or inside the coordinator's chat, so it looked as if helpers never had a thread. Clicking a helper in the sidebar (or in the coordinator's **Details**) now opens its thread with the coordinator: the task it was given and its answer.

## 0.0.5 - 2026-11-11

### Security

- **Typing can no longer press a button.** A Visual Bot's text with a line break in it now asks for approval exactly like Enter does (it used to submit a form with no card), and `screen_type` refuses unless a real text box has focus, so a space can't click a focused "Pay now" button or tick a box.
- **Card numbers typed during a handoff no longer reach the model.** Card number, security code and password fields (also a "show password" box and `billing cc-number`-style autocomplete values) are blacked out in every screenshot and left out of the list of page elements.
- **"Always allow" means that exact action.** It used to match anything that began the same way, so allowing `Fetch http://192.168.1.1` also allowed `http://192.168.1.10/admin`. Rules you type in Custom Rules still match a start; saved rules from before keep working.
- **A connected app's approval card shows the whole call.** It cut the arguments at 200 characters, so a long message could hide a `bcc` after the cut, and "Always allow" saved the cut text. The card now shows up to 2,000 characters, says how much is hidden past that and then doesn't offer "Always allow", which is also no longer offered for an irreversible call.
- **The `run_command` card shows the folder** it runs in, with the "Outside the bot's folder" badge when it is elsewhere.
- **Connected-app tools with similar names can't be mixed up.** `list.items` and `list_items` used to get one name, so a read-only bot could pass a check on one and run the other. Colliding names now get a short suffix.
- **A web page can no longer freeze the app.** `fetch_url` converted pages with patterns that took minutes on a hostile page of about 1 MB; it is now linear and capped at 400,000 characters.
- **Bots sharing a browser profile no longer end up in one tab**, where one bot's numbered boxes could be clicked by another.
- **A key typed for a provider that takes none is no longer stored or sent.** Switching the preset in Add provider also clears the key and name fields, and the server ignores a key for a server that needs none.
- **Chat images load on request.** An image a reply links to on the web isn't fetched until you press **Load image**.
- **Racers can't wait for approval cards** nobody can see; a call that needs one is refused at once, and the model slot stays free for the others.

### Fixed

- **Secrets granted during a turn now reach `run_command` in that turn** (and are hidden in its output). The bot used to be told "You haven't been given NAME" and asked again until it ran out of steps.
- **Secrets longer than the Windows limit** (1,280 characters) get a clear message instead of "keychain could not be used" or a stuck card. Connected apps that issue large tokens (Microsoft, Atlassian) can now sign in and refresh: their sign-in is stored in pieces.
- **Queued messages behave.** A message waiting behind a running reply uses the bot's current tools and instructions, Stop and Clear chat cancel it, and several messages sent during a Parallel Bots reply get one answer instead of one each. A routine or helper hand-off is never answered in Parallel Bots mode.
- **A routine that was running when the app closed doesn't run again** at the next start.
- **The "prepare the turn" step no longer times out while waiting for the model** that other bots are using.
- **`delegate` no longer makes a helper when the coordinator's `spawn_bot` switch is off.**
- **Deleting an expert mid-discussion doesn't end it:** the others carry on to the summary, and the deleted expert's lines and links stay (labelled "A former expert").
- **Summaries and judge reports keep real links** wrapped in backticks, bold, quotes or ending with `…` or `。`, accept `HTTPS://` in capitals and addresses you gave yourself. Three unrelated failed replies spread over a long discussion no longer end it, and a failure while writing the summary no longer leaves the thread on "working".
- **Streamed text is no longer lost** when you open a chat whose bot is mid-reply, a reply can't stay on "streaming" forever, and a missing part no longer blanks the window (there is a Reload fallback).
- **AltGr keys** (`[`, `]`, `{`) are no longer swallowed by shortcuts on German, Nordic and Portuguese keyboards.
- **Group chats work when each bot has its own model** and no shared model is set.
- **A question without choices doesn't take focus** while you are typing in the message box.
- **A connected app whose program quits is shown as an error** instead of staying "connected", paginated tool lists are read in full, and `resolve_…`, `check_…`, `trash_…`, `rm_…`, `discard_…` and similar names are classed correctly (changes, not reads).
- **The routine webhook address keeps its port** between launches (another port is used only if it is taken).
- **Short answers from Ollama thinking models** (history summaries, group-chat routing) are no longer empty, and Anthropic bots no longer fail with a 400 when a conversation starts with the bot's own message.
- **A helper the coordinator created but never gave work had no thread to look at.** The conversation between a coordinator and a helper was only created when the first task was handed over, so a coordinator that made helpers and then did the work itself left nothing in **Bot conversations**. Now every helper gets its thread with the coordinator the moment it is created (empty until it has work), and `spawn_bot`'s reply tells the model plainly that the helper does nothing until `delegate` gives it a task.

## 0.0.4 - 2026-11-11

### Added

- **Parallel Bots: one question, three answers, one request.** A columns button next to the message box (in a chat with one bot) sends your message to the model once, with a short instruction. The model picks three roles that fit that question and answers as each of them in a single reply, which is shown as three cards that fill in as it is written. It is one request, so it takes one place in the queue instead of three, no second model loads and memory stays at one slot; it isn't faster to write than three answers would be, but it avoids reading the chat and the bot's instructions three times. No tools or helpers in this mode, no summarising of a long chat first, and Try again after a failed reply keeps the mode. Your message gets a **Parallel Bots** mark, and a reply that didn't come out in sections is shown as written, with a note to send the question again. `evals/parallel.eval.ts` runs real models through it so a 9B can be compared with a 14B or a 30B later. See [Parallel Bots](docs/features.md#parallel-bots).
- **The documentation is tested** (`scripts/docs.test.ts`, run by `pnpm test` and CI): every link and heading anchor resolves, every package has the app's version and the changelog has an entry for it, the providers, built-in tools and settings pages the docs list are the ones the app has, and no personal path or address is in a markdown file.
- **A troubleshooting entry for Ollama running but listing no models** (usually `OLLAMA_MODELS` pointing at the wrong folder).
- **`pnpm test:ui`** opens the test suite in a browser dashboard (Vitest UI): run the tests, search and filter them, and see why one failed.
- **An eval for the reports that end races and clusters** (`evals/reports.eval.ts`): real models run a cluster and a race, and every section of the summary and the judge's report must be there and filled in, with a winner named.
- **Evals for exploring a site:** a shop whose search finds nothing, where the phone is only on page 2 of its menu, and one where the phone isn't there at all (the bot must say so, not make up a price). For Visual and text bots: `explore`, `missing`, `visual-explore`, `visual-missing`.

### Fixed

- **A message lost its moderator mark while it was being written.** The update that saves a streaming reply read only some of the message's columns, so every update of a cluster moderator's summary reported it as an ordinary message from no bot. All marks now survive those updates.
- **A coordinator that skips `spawn_bot` is no longer left with nobody.** Some models (small ones, and ones without native tool calls) hand a task to a helper's name with `delegate` without making the helper first, and got "No teammate is called X. Teammates: none." again and again until they gave up and did everything themselves. `delegate` now makes a helper for a name nobody has, on the model already in use (no approval card, as with `spawn_bot`), within the limit of 6 helpers and never in a group chat; a name that differs from a teammate's only in case, spacing or punctuation ("research_bot") now means that teammate.
- **Helpers working for a coordinator were told they were in a group chat with you.** The conversation between a coordinator and a helper is stored like a group, so the helper's instructions said it was in a group chat with you and should keep it short. They now don't.
- **Bot-to-bot conversations aren't listed as group chats.** A coordinator's conversation with a helper or teammate ("Boss ↔ Helper") has its own **Bot conversations** section in the sidebar, and **Group chats** are only the ones you made.
- **The planning question before a coordinator's turn always turns thinking off for Ollama models**, as the race and cluster reports already did. Models whose Ollama listing doesn't say they think (Ornith 1.5, MiMo v2.6) could spend the planner's few tokens thinking and return no plan.
- **Typing no longer runs into what a box already holds.** A Visual Bot typing into a search box that still held the last search (as search engines' do), or trying the same text twice, got the two run together ("vivo y19spixel phone"). Now what was in the box is replaced, the bot is told what the box holds afterwards (and warned if it isn't what it typed), and the screen map shows what each text box holds.
- **Races and clusters end with a whole report.** A summary or judge's report that left a section out, left it empty or was cut off in the middle gets that section asked for once more and put in its place, and a race whose judge named no winner takes the top score in its table. A cluster whose experts' replies start failing still gets a summary of what was said, instead of ending with none. On a small context, the moderator and the judge get every turn and every racer's answer cut to an even share, instead of losing the opening turns or the last racers off the end.
- **Cluster summaries on Ornith and MiMo came out empty or cut off.** Ollama's model list doesn't say that some models think (Ornith 1.5 and MiMo v2.6 among them), so the moderator couldn't switch their thinking off, and with room for a 3,000-token summary Ornith spent all of it thinking. The moderator's calls and the filling-in of a report now always switch thinking off on Ollama. Ordinary chats are unchanged: these models still think before replying, which in evals they need to do well.
- **Rich-text boxes** (as in mail and chat composers) get a numbered box, so Visual Bots can type into them.
- **Box numbers sit level with their own box.** Drawn above it, in a tight list the number landed on the row before and covered its first letter, and models clicked the item below the one they meant.
- **No approval card for something that can't happen.** Typing with nothing selected, or clicking a number that isn't on the page, asked first and then failed anyway; an unwatched bot waited on the card. Now they're refused at once with what to do instead.
- **A guessed address that doesn't exist says so in plain words**, instead of the browser's own error with its call log, and the next page the bot opens is no longer cut short by the browser's error page.

## 0.0.3 - 2026-11-06

### Added

- **Choose which tools each bot has.** **Details → Tools** lists a bot's tools by area with a switch for each. Everything is on until you switch it off; fewer tools means a shorter prompt, which helps small local models pick the right one. A tool that is off isn't just hidden: the bot is told it can't use it, and a call to it by name finds nothing to run. Bots made before this keep every tool.
- **One-tap questions.** A bot can offer choices when it asks you something: tap one to answer, or tick several (**multiple choice**) and send. You can always type your own answer instead. A question that arrives while you are typing doesn't take the keyboard from you.
- **Errors in plain words, with a way out.** "I couldn't reach the model" instead of `ECONNREFUSED 127.0.0.1:11434`, with **Try again**, **Switch model** or **Open settings** where they help, and the original text behind **Details**. **Try again** answers your message afresh without sending it twice, and is never offered on an old reply, or on one that may already have done something (the server refuses it too).
- **A slow first reply gets a way out.** After 20 seconds without a word the chat says so. A cloud model then offers **Try again / Switch model / Keep waiting**; a model on your computer, which can legitimately take a minute to load, gets a note first and the buttons after a minute and a half. Nothing is offered while the reply is just waiting for another bot to finish with the model. **Switch model** picks a model and starts the reply over with it.
- **Unread dots.** A chat shows how many replies arrived while you were elsewhere (a badge, a bolder name, a dot in the compact sidebar, and a `(3)` in the window title), and the chat opens with a **New messages** line above the first one. Counted while the app is open, and cleared when it restarts (the packaged app uses a new local address each launch, so the browser storage it is kept in doesn't carry over; running from source with `pnpm dev` keeps it).
- **Long chats stay fast.** Only the newest 120 messages are drawn, with earlier ones drawn as you scroll up; a new reply never makes the page jump while you are reading older messages.
- **Dialogs keep the keyboard.** Tab and Shift+Tab go round inside an open dialog instead of out to the page behind it, and Escape returns you to where you were.
- **Sign in to connected apps.** An app (an HTTP MCP server) that asks for a sign-in shows **Needs you to sign in** in **Settings → Connect apps**, with a **Sign in** button. You sign in in your own browser and come back to FreeBird; nothing opens on its own. It uses OAuth with PKCE. The sign-in is kept in your keychain as `MCP_OAUTH_<APP>`, refreshed when it runs out, tied to the app's address (change the address and the old sign-in is never sent to the new one), and deleted when you remove the app. Apps you gave a token in an `Authorization` header work as before, and a refused token now says so in plain words.
- **Read-only access to an app, per bot.** **Details → Tools** gives each connected app a choice: **Can make changes**, **Read only** or **No access**. What counts as reading comes from what the app says about each tool (MCP `readOnlyHint` and `destructiveHint`), checked against the tool's name: when the two disagree, the stricter one wins, and a tool that says nothing and has an unclear name counts as making changes. A tool that can't be undone asks you every time, even from an app set not to ask. A helper never gets more than the bot that made it.
- **Big app results don't flood the chat.** A result longer than about 4,000 characters is kept aside and the bot gets its shape and a preview, plus `query_result` to pick out what it needs (a path such as `messages[0:5].subject`, a search, or a range of lines). Kept results go when the chat is cleared or deleted.
- **Secrets stay out of what bots see and what is logged.** The values of your saved secrets, logins, cards and app sign-ins are replaced with `[hidden]` in command output, app results, error text and the event log, including encoded forms (percent- and JSON-escaped, base64, and `user:password` sign-ins). Values shorter than 8 characters aren't matched, since they would hide ordinary words.
- **Secrets given to one command.** A bot names the secrets a single `run_command` needs, and the approval card says so ("with your secrets: GITHUB_TOKEN"). Only those reach that command, and only if the bot was given them. This card always asks, even when commands are set to run without asking.
- **Each bot has its own browser.** By default, sites you sign in to for one bot aren't open to the others: each bot's tab opens in its own browser profile, and its helpers use the same one. Sign in for a bot from its chat: **Browser panel → Open Ada's browser**, then type the address into the panel (it has an address field now) or use the window. The bots of one race or cluster share one. At most three browsers run at once; one nobody has used for two minutes closes to make room (the one used longest ago), and a browser in use, waiting for you or being watched is never closed. Deleting a bot (or a race) deletes its profile. Installs that already used the browser keep one shared profile until you switch in **Settings → Browser & search → Sign-ins**. Switching closes the browser, and sign-ins aren't moved between profiles.
- **The bots' browser looks like an ordinary browser to websites** (Settings → Browser & search, on by default). It no longer sends what only automated browsers send: the automation switch behind `navigator.webdriver` and the "controlled by automated software" bar, and "Headless" in a hidden window's name. Fewer sites stop bots with checks. Checks that still come are handed to you, as before; nothing solves them or fakes who is browsing. Switch it off to have the browser say it is automated.
- **Solve a check and the bot carries on by itself.** When a bot hands you a CAPTCHA or "verify you're human" check, the window comes to the front, and once you've solved it the bot notices the check is gone and goes on. No need to reply "done" (you still can). Sign-ins and payments still wait for your reply, since only you know when they're done.
- **A notification when a bot needs you.** With **Notify me** on for a bot, you get a desktop notification when it starts waiting for you (a check, a question, an approval) while you're in another chat or app.
- **Visual Bots search on Bing first.** Google stops automated browsers with checks far more often, so Visual Bots start at bing.com and use Google only when you ask.
- **Waiting turns don't starve.** A routine or background job that has waited for the shared model is treated as more urgent each minute, so a busy conversation can no longer keep it out for as long as the conversation lasts.

- **A bot that goes round in circles stops.** The same tool call with the same result three times in a row ends the turn with a summary of what was found and a note, instead of using up every step. Calls that repeat on purpose (scrolling, looking at a changing page) are not affected, because what they return differs.
- **A model that goes silent is cut off.** A cloud model that sends nothing for 5 minutes at the start, or 3 minutes in the middle of a reply, ends with a "stalled" error instead of waiting for ever. A model on your computer gets much longer (20 minutes, and 10 in the middle), because loading and reading a long prompt, or writing out a long tool call, is legitimately quiet for minutes. A stalled request frees the shared model. Pressing Stop is unchanged and still shows as stopped.
- **An approval card that nobody answers expires** after 15 minutes. The bot is told that nobody answered (not that you said no), so it doesn't treat silence as a refusal. Each decision records who made it: you, a saved rule, the command policy, the group-chat rule, the clock or Stop.
- **A restart no longer hides what was happening.** Cards that could no longer be answered are closed, and a chat that was in the middle of something that changes things outside the chat (a command, a connected app, a click that acts) ends as an error that says so, so it isn't repeated by accident. Everything else still ends as stopped.
- **An event log** for working out what went wrong: `<data folder>/logs/<chat>.ndjson`, one line per event. Keys and tokens are redacted and pictures left out. It is a copy of the chat, so Clear chat and deleting a chat or bot delete it too. It is on by default and can be turned off with `MROG_EVENT_LOG=off`. See [Privacy & security](docs/privacy-and-security.md#the-event-log).
- **CI**: actions are pinned to commits, and a single `CI` job to require in branch protection.

### Changed

- A bot's computer (Docker) is created with a process limit, a memory limit and without raw-socket and device-node privileges. Existing computers get these when you press **Reset**.

### Fixed

- **A Visual Bot's click can no longer land on something that should have asked.** It clicks by position, so a pop-up, cookie banner or see-through layer over the box it chose would take the click, and the approval had been judged by the box underneath. Now a click that would land on something that asks first (Subscribe, Accept all) is refused, and the bot is told what covers the box.
- **Checkboxes are named by their label.** The screen map and page readings named most checkboxes "on" (their value), so ticking "I agree to the terms" didn't ask first. It does now.
- **Ordinary pages aren't taken for human checks.** Many sign-in, shop and contact pages carry an invisible reCAPTCHA or a hidden captcha field, and an article could mention a "security check"; either one stopped bots clicking anything on the page. Only a check you can see, or a short challenge page, counts now.
- **A Visual Bot on a model that can't see says so.** It used to try with no pictures and no text tools to fall back on. Now the reply says the model can't see pictures and offers **Switch model** (for Ollama models, whose abilities are known for sure).
- **A field marked as a password is treated as one** even when the site shows it as plain text ("show password"): bots don't type into it.
- A Visual Bot whose browser is switched off in Settings is told so, instead of not knowing it is a Visual Bot.
- A Visual Bot's tools are matched by exact name, so a connected app named "screen" or "browser" can't add tools to it.
- An error that merely contained the letters "oom" ("boom", "room", "bloom") was reported as the model running out of memory. Only memory trouble, or the word "OOM" on its own, is now.

## 0.0.2 - 2026-11-03

### Changed

- **Races run one racer at a time on a local model again.** Each racer keeps the model until it has finished, then the next one starts, instead of the racers trading the model after every step. That avoids re-reading each racer's conversation, and switching models in the middle of a racer's work when racers use different local models. Raise **Bots at once** to run several racers at the same time.

### Fixed

- Deleting a bot no longer announces a change to its computer when it never had one.

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

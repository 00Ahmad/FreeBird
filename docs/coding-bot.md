# Coding Bot

A **Coding Bot** is a small software team in one bot. You describe a project, and three roles build it in a folder you choose:

- the **Planner** draws the plan: which files the project needs, what the code in each file should do, and how the files connect;
- the **Developer** writes the files, one card per file, using the exact names the files they connect to have;
- **QA** checks every file and its connections, and sends anything wrong back with a comment saying what is wrong.

The loop repeats until QA has passed everything, or it reaches the round limit and asks you.

Each role can use **skills**: when one fits its work (a code review, a test plan, a debugging routine), it looks it up and follows it. It's on by default; switch it off for the whole team with **Can use skills** in the Coding Bot's **Details → Skills**.

Each role also **applies some skills on every card**, without having to look them up: their steps are part of its instructions. Out of the box each role applies its own skill, written for its job and its tools: the Planner `coding-planner` (exact names shared between files, startup order, exact API calls, one config file for keys), the Developer `coding-developer` (names copied from the plan, nothing run before the page is ready, every request checked, keys copied exactly, every QA comment fixed) and QA `coding-qa` (trace the startup order as well as the syntax, check names against the other files, fail only for real problems, with the line and the fix). Change them under each role in **Details → Skills**: remove one, or pick another from the shared skills. The role's own job still comes first: a step a skill asks for that the role can't or mustn't do (QA changing files, the Developer running tests) is skipped, and what it would have found goes into the role's comment. QA still finishes each card with a pass or fail.

You can give the team new skills there too: skills under **Whole team** go to the Planner, the Developer and QA, and skills under **Planner**, **Developer** or **QA** go to that role only. Each role also has the skills shared by every bot. When two have the same name, the role's own wins, then the team's, then the shared one.

Each role runs on **its own model**, so you can put a strong model on the Planner and a fast local one on the Developer, or the same model on all three. Everything works with Ollama only, with cloud models, or with a mix.

## Create one

Press **+ → New Coding Bot**. You choose:

| Setting                           | What it does                                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**                          | How it appears in your bot list (up to 49 characters, because its team is named after it).                                                                                        |
| **Output folder**                 | Required. Every project file is written here. Use **Browse** in the desktop app, or type the path.                                                                                |
| **Planner, Developer, QA models** | One model per role. Leave one empty to use the shared model. You can change them later under **Models**.                                                                          |
| **Auto-approve**                  | Off by default. When on, the Developer starts as soon as the plan is ready, and QA runs its routine commands (checks, installs, test runs) without asking. See [Safety](#safety). |
| **Visual QA**                     | Off by default. When on, QA also uses the finished app like a person. See [Visual QA](#visual-qa).                                                                                |
| **QA round limit**                | How many times QA may send work back before it stops and asks you. Default 5, any number from 1 to 20.                                                                            |

The output folder must be a folder on this computer that you can write to. FreeBird refuses a drive root, your home folder itself, FreeBird's own data folder, another bot's folder, the output folder of another Coding Bot, network and `\\server\share` paths, and names ending in a dot or a space or named like a device (`CON`, `NUL`). A folder that doesn't exist yet is created.

## How a project runs

1. **Brief.** Describe what you want in the Coding Bot's chat. The first message is the brief.
2. **Planning.** The Planner turns the brief into a plan. If the plan is invalid, it is told exactly what is wrong and tries again (up to four attempts). After two plans are turned down, it is asked for a short one: a sentence per file and no connections, since the exact names are read from the code as it is written. The Planner is asked for **small files, one feature each** (under about 150 lines), and a short `main.js` that starts them, because a small model writes a short file well and gets lost in a long one. For a web page, it can also say **how to tell a file works**: up to three one-line checks the browser runs, such as `#list has items` or `type #task "Buy milk" then click #add -> #list contains "Buy milk"` (see [Done checks](#done-checks)).
3. **Your approval.** The plan waits for you. Press **Approve**, or **Ask for changes** and say what to change, and the Planner revises it. With **auto-approve** on, this step is skipped. You can switch it on or off at any time.
4. **Building.** The Developer takes one card at a time, one per file, in this order: settings and data files, then pages, then scripts, then stylesheets, then docs (in the Planner's order within each). The pages come first because they define the ids and classes everything else uses; the stylesheets come last so they can style the classes the scripts create. Each card is told the file's connections and, read from the code of the files already written, the **exact names** to use: the ids and classes on the page that loads a script, what other scripts export, the classes the scripts create, and, for a file not written yet, the names other files already import from it. Where those names differ from the plan's description, the code wins. Each card moves **Todo → In progress → QA**. When the Developer says a file is finished, FreeBird checks it first, in seconds and without a model: that it parses, the code check's findings for this file, and with Visual QA on (once every page and script exists; stylesheets may still be missing) the page opened in the browser, including the file's done checks. If something is wrong, the Developer is told "Not finished" with the error and the line, and fixes it in the same turn, up to twice per card, before QA ever sees it. A Developer turn that keeps changing its file without finishing is stopped after 6 changes, and what it wrote moves on to the checks. A turn that ends without using any tool is told once, in the same turn, to write the file.
5. **Checking.** Every QA pass starts with checks that need no model: the code check (a missing file or import, a plain `<script>` tag loading a file that uses `import`, an id a script looks for that no page has, the same id on two elements of one page, a JSON file that doesn't parse, a key that looks made up, two scripts on one page declaring the same top-level name) and, with Visual QA on, the quick check in the browser. What they find goes straight back to the card of each file involved. Then QA reviews one card at a time. A card that passes moves to **Done**. A card that fails goes back to **Todo** with a **comment saying what is wrong**, and the Developer sees that comment when it picks the card up again. When QA looks at a card again, it is shown **what changed** since its last review, as a short diff, instead of having to read the whole file again (a file that was mostly rewritten is read in full). QA checks each file's connections as part of its card: what the file uses from the others, and what they use from it, must exist with the same names. (Projects planned before this had a separate card per connection; those cards still run.)
6. **A fix can break something that already passed.** After every Developer turn, FreeBird notices which planned files changed. When a changed file now provides something different (its ids, classes, exports, or the files it loads), the finished cards of the files linked to it in the code go back to QA, with a note saying why (on an older project, every finished card that touches the changed file, and every connection card that links it). The code check at the start of the next pass catches names, ids and imports that no longer match. So "everything is Done" always means it was checked after the last change.
7. **Round limit, per card.** The limit counts how often each card is sent back, so one stubborn file can't use it up for the rest. A card sent back that many times is **set aside for you** (marked so on the board) and the others carry on. When only set-aside cards are left, they first go **back to the Planner**: a file that keeps failing usually means the plan is wrong (one file doing too much, a job in the wrong file, a file missing), which the Developer, held to the plan and to its one file, can't fix. The Planner changes only that part of the plan; files whose plan stays the same keep their work, and with Auto-approve off you approve the change as usual. QA can also say a failure is the plan's fault (from a card's second fail on), which sends it to the Planner at the end of that pass. At most 2 re-plans happen per project. If the Planner keeps the plan as it was, or the re-plans are used up, the project stops with **Needs you** and says which cards are left. Fix them yourself, or raise the limit in the settings (which brings them back) and press **Resume**. As a safety net, the whole project also stops after three times the limit in rounds.
8. **Whole-project check.** When every card has passed, the project is checked as a whole before it is called done. The code check runs once more, and anything found sends the right cards back with a comment. A key you gave in the brief, copied into the code, isn't flagged as made up. If the automatic checks find nothing, QA gets one last turn to look across the files.
9. **Visual QA** (if it's on). Once the whole-project check passes, QA starts the app and uses it. See [Visual QA](#visual-qa).
10. **Done.** When the whole-project check passes (and Visual QA, if it's on), the project is complete. The Coding Bot's closing message ends with a short **Before you run it** list, for example "add your own API key in `api-config.js`" or "open it through a local web server, not by double-clicking the file".

Typing in the Coding Bot's chat doesn't start a model of its own:

- the first message is the brief;
- while a plan waits for approval, a message is feedback for the Planner;
- **after the project is done, a message is a change request**: the Planner updates the plan, cards for unchanged files stay Done, and only what changed is built again, after your approval as usual;
- if planning failed before any card existed, a message is a new brief;
- **a message that names one of the project's files goes to that file's card** (for example `movies.js:289 Uncaught TypeError: …`). It becomes your comment on the card, and the card goes back to the Developer, who is told your note comes first. This works while the team works (a card being written right then goes back once that turn ends), while it is stopped or waiting for you (press **Resume**; a set-aside card comes back), and after it is done, when the message reports a fault (an error, a line number, "doesn't work"): then the team starts again on just that file. A message after it is done that doesn't report a fault is a change request, as above;
- otherwise you get a one-line status reply, with a reminder to name the file when you want to pass something on.

**Stop** and **Resume** work at any time, from the panel or the message box's Stop button. Stopping one of the team's conversations stops the project too, and Resume carries on. If you close the app while it is working, the project comes back **Stopped** with the unfinished cards back in Todo, and you can resume it; a change request you had asked for is kept.

## Visual QA

Reading code doesn't show that a button works. With **Visual QA** on, QA also opens the finished app and uses it like a person, after all its usual checks have passed.

**The quick check after every development pass.** With Visual QA on, FreeBird also opens the app by itself each time the Developer finishes a pass, before QA reviews any card, and runs the automatic checks: a crash on start, errors in the browser console, files that fail to load, and buttons that do nothing or are covered. No model is used and nothing asks you, and it takes seconds. Anything it finds goes straight back to the card it belongs to, so a page that crashes on load is fixed in the first round instead of after every card has passed. It runs only when the files changed since the last time. Web pages are always checked this way (FreeBird serves the folder itself); an app with its own server only with **Auto-approve** on, since starting it runs its command; desktop apps wait for the full Visual QA. Turn it on when you create the Coding Bot, or any time with the **Visual QA** switch in the panel, next to **Auto-approve**. It adds to QA's other checks and replaces none of them.

### Done checks

A plan can say, for each file of a web page, how to tell it works: up to three checks in four fixed forms, which the browser runs as part of the quick check (and of the Developer's own check before it finishes a file):

| Check                                                                | Passes when                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `#list has items`                                                    | the element has at least one child within 5 seconds                |
| `#status contains "Ready"`                                           | its text (or an input's value) contains the words within 5 seconds |
| `click #refresh -> #list changes`                                    | clicking the first element changes what the second holds           |
| `type #task "Buy milk" then click #add -> #list contains "Buy milk"` | after typing and clicking, the element shows the words             |

Each check starts from a freshly loaded page, with anything the page saved in the browser (local and session storage) cleared, so an item added by an earlier check can't make a later one pass. A check that fails goes back to its file's card, with what the browser console said if the page threw an error. A check naming an element the page doesn't have at all is only noted in the activity list, not sent back, since that means the plan and the page disagree on a name. A check written in none of these forms is left out of the plan, and the Planner is told which; it never costs the plan. Without Visual QA, the checks are still shown to the Developer and QA, marked as checks nobody runs, so QA checks them in the code. Checks for Node and Python projects aren't supported yet.

1. **Starting the app.** FreeBird works out how the project runs from its files:
   - **Web pages** (HTML, CSS, JavaScript): FreeBird serves the output folder itself, on this computer only. Nothing is run.
   - **Apps with a server that show a web page**: Flask, Django, FastAPI, Streamlit, Gradio, Node and Express, Vite, Next.js. FreeBird runs the project's start command, installing what it needs first (`requirements.txt`, `npm install`), waits until the app answers, and opens the address it prints.
   - **Desktop apps** (Tkinter, PyQt, PySide, wxPython, Kivy, pygame, Electron): checked only for starting and staying open without errors. Clicking around in desktop windows isn't supported yet.
   - **Anything else** (a library, a command-line tool) is skipped, with a line in the activity list.
2. **The automatic checks**, with no model. Each problem found goes back to the Developer on the card it belongs to, whatever QA decides:
   - the app crashes on start or prints an error, such as a Python traceback;
   - errors in the browser console, and files the page fails to load (a missing script, a 404);
   - buttons that do nothing when clicked, because nothing on them or around them handles the click;
   - buttons covered by something else, or with no size.
3. **QA uses the app.** QA makes a short test plan from the brief (for example: type a task, click **Add**, see it in the list) and works through it in its own browser tab. After each action it takes a screenshot, and it can check:
   - the **console**: new browser errors and the server's output;
   - **inspect**: whether a control is shown, enabled, covered, and whether anything handles a click on it.

   Anything that doesn't work goes back to the Developer with what QA did, what should have happened and what happened instead.

4. **Cleaning up.** Afterwards the app is stopped, the local server is closed, and QA's tab is closed.

**QA's model needs to see pictures** to read the screenshots: pick one with vision (the eye icon in the model list) for QA under **Models**. With a model that can't, Visual QA still runs the automatic checks, and QA tests from the screen map and the console only; the panel says so under the switch.

**What asks first.** Opening web pages runs nothing on your computer, so it doesn't ask. Starting an app with a command runs code the team wrote, so it shows an approval card like any command QA runs (with **Auto-approve** on, only when the command could do lasting harm, as below). On the app's own pages, QA's clicks and typing never ask, since nothing there can buy or send anything. If QA ends up on another site, it is told to go back, and its clicks there ask as usual. The browser can only open the app's own address on this computer, and only while Visual QA runs. It never serves `.env` files, private keys or hidden files.

**Where the screenshots go.** They go to QA's model, like any picture a bot sees: with a local model they stay on this computer, and with a cloud model they are sent to that provider.

Visual QA uses the browser from **Settings → Browser & search** (Edge or Chrome). Expect each Visual QA pass to add a few minutes.

## The panel

A panel beside the chat has three tabs, plus a header that shows the status, the round (for example "Round 2 of 5") and the controls.

- **Diagram.** Each file is a box showing its path and what its code should do. Each connection is a small round junction joined to every file it links, so a connection can link two files or ten. Once files are written, a switch above it shows either the **Planned** connections or the ones **In the code**: which page loads which script or stylesheet, and which script imports what from which (read from the code, the default). The colour of a box shows where its card is. Click a box or a junction to see its details and comments. Zoom, fit and a legend are built in.
- **Board.** Four columns: Todo, In progress, QA, Done. Projects have a card per file (older projects also have connection cards, which look different), and QA's comments are shown under the card they are about. A card sent back is marked **Needs fixing**.
- **Checklist.** Every file and every connection as a line, with a total. A file is ticked when its card is Done; a connection when every file it links is.

You can also see what is happening without reading the chat:

- three chips show who is working now and on which card;
- the box being worked on has a moving ring, finished boxes get a tick, boxes QA sent back are marked;
- a card that moves flashes briefly, and a new QA comment gets a badge (motion is switched off if your system asks for reduced motion);
- a progress bar ("7 of 12 cards done") and a banner say what is happening and what you need to do next;
- every card shows **how long it has taken and how many tokens it used** (for example "12 min · 1.5M in · 58k out · 2 turns"), with a live timer on the card being worked on and a total in the panel header. A card that takes **more than 10 minutes** gets an amber **Slow** badge, the activity list says so, and the banner suggests a smaller or faster model for that role;
- the sidebar row and a desktop notification tell you when it needs you: plan ready, round limit reached, finished, or an error;
- an activity list shows the last events ("QA sent `src/api.ts` back: missing error handling").

Colour is never the only signal: every state also has an icon and words.

## Export and import the plan

Open the panel's **Export** menu to download the plan:

- **Plan (JSON)**: the file you can import again. It lists your brief, the files (`path`, `purpose`, and `done` for a file with [done checks](#done-checks)) and the connections (the paths they link and a description).
- **Markdown**: a readable list of the files, the connections and the checklist.
- **Mermaid**: a text diagram that GitHub and many chat tools draw.
- **SVG**: the diagram as a picture.
- **Project snapshot (JSON)**: the plan plus the board, QA comments, round and log, for a backup or to share.

**Import** lets you use a plan that someone, or some other model, wrote. A common use is to get the plan from a flagship model and let your own local Developer and QA do the work.

1. Press **Copy planning prompt** and paste it into the model you want to plan with. It explains the exact format and the limits.
2. Press **Import** and choose the file, or paste the model's answer. The JSON can be inside a normal chat reply.
3. FreeBird checks the plan with the same rules as the Planner's own, and shows a **preview**: how many files and connections it understood, any errors, and a warning for files that **already exist** in the output folder (the Developer would change them).
4. **Apply.** The plan waits for your approval, unless auto-approve is on, in which case the Developer starts at once. The Planner is skipped (its model still has to be one you have, or the shared model).

You can import whenever the team isn't working: before the Developer starts, or after the project is done, stopped, failed or waiting for you. Once work has begun, importing asks you to confirm, in its own step, that the board will be reset. Plan files over 1 MB are refused.

A plan can have up to **40 files** and **80 connections**. Paths are relative to the output folder (no drive letters, no `..`, at most 200 characters), every file needs a purpose, and every connection links two or more of the listed files. A plan can't include files inside `.git` or `node_modules`, editor or tool settings that run commands (such as `.vscode/tasks.json` or `.npmrc`), names like `CON` or `NUL`, names ending in a dot or space, or invisible and right-to-left characters.

## Safety

- **Only the plan's files are written.** Writing one of the plan's files needs no approval card, because the output folder is the project. Any other file, including helper scripts, files in `.git` or `node_modules` and editor settings that run commands, is refused. A link or junction that points out of the folder counts as outside and asks first.
- **Secrets in the folder stay out of the models.** The roles can't read `.env` files, private keys or files like `.npmrc`, and searches skip them.
- **Keys in your brief never reach a model.** When the brief (or a later message) holds an API key or token, FreeBird takes it out, keeps it on this computer in FreeBird's own data (where the brief was kept before, not the keychain), and the roles only see a name such as `{{TMDB_API_KEY}}`. The Developer writes that name where the key goes, and the real key goes into the file as it is written, so the key is never retyped (and so never comes out one character short). Reading the file back, or a command's output, shows the name again. The project's brief, log and comments keep the name, not the key. The key stays in your own chat message.
- **Files already in the output folder** from before the project are listed for the Planner, which is told not to build on them unless the brief says so. When the plan writes a file with the same name as one of them, the plan message says it will be replaced.
- **An approval card the team needs doesn't quietly expire.** Elsewhere an unanswered card is dropped after 15 minutes; a Coding Bot's team waits for your answer instead (QA would only work around a command that never ran), and the Coding Bot reminds you in its chat every 15 minutes. **Stop** still ends it.
- **Running commands asks**, for example tests or installing packages, even if you set **Execution on this computer** to always allow; set to never allow, QA can't run commands at all. With the Coding Bot's **Auto-approve** on, QA's routine commands run without asking; see below. Only QA runs commands; the Developer can't. The card appears in the Coding Bot's chat, and the command runs from the output folder. A command waiting for your answer does not block the model for anything else. Commands never see FreeBird's own access token.
- **What Auto-approve covers.** The plan, and QA's routine commands: checking, installing and running the project. It still asks for any command that can't be undone (deleting, moving, overwriting, `git reset`…), changes sign-in or security settings, is given your saved secrets, names a secret file (`.env`, a private key, `.npmrc`), names a path outside the output folder, or writes a file (`> file`, `New-Item`, `Copy-Item`, `Add-Content`…). **Never allow** still refuses every command.
- The roles cannot create helpers or hand work to other bots, and other bots cannot hand work to a Coding Bot.
- **Deleting the Coding Bot deletes its three roles and its board, never your project files.** The output folder is not touched.

## Tips

- Planning is the step that most depends on the model. A small local model can plan a few files, but for a larger project use a stronger model for the Planner, or import a plan.
- Keep the first brief short and concrete: what it is, the language, and what it must do.
- On a local model the three roles run one after another, so swapping models between roles takes a moment. Using one model for all three avoids that.
- **Nobody invents secrets.** The Developer and QA never make up an API key, token or password. A file that needs one gets a clearly marked placeholder such as `YOUR_API_KEY_HERE` and a comment saying where to get one. QA accepts that placeholder and fails a file with a made-up key. You add the real key, or give it in the brief and the team puts it in for you (see Safety).
- **The Developer writes and QA tests.** For each card the Developer:
  - writes only that card's file, and only reads files that are already written (it is told which files a later card writes, and not to look for them);
  - reads at most 6 files per try, has at most 15 model rounds per try and is told when 3 are left;
  - has only reading, writing, editing and finishing the card as tools, and no thinking turned on for Ollama models (so it doesn't spend minutes reasoning before every file);
  - can't run commands.

  If a try writes the file but forgets to say it is finished, the card goes to QA anyway. QA runs your code to check it and installs what the project needs, sometimes with several small commands in one review. Each command asks first, in the Coding Bot's chat, so expect a few cards while it checks.

- A file the team already wrote in this project (for example before a restart) isn't written again: its card goes straight to QA, unless QA has already sent it back.
- The roles appear under **Hidden Bots**. Clicking one opens its conversation with the Coding Bot. The team's conversations and bots can't be deleted, duplicated or renamed on their own: they go with the Coding Bot. Only the Coding Bot itself sends desktop notifications, when it needs you.

## If something goes wrong

- **"Needs you" after the round limit.** Read the note, raise the limit in the panel and press **Resume**, or step in and edit the files yourself.
- **A card takes very long.** The **Slow** badge shows which one. A reasoning model can spend many minutes per file; give the Developer a smaller or faster model under **Models**, then **Stop** and **Resume**.
- **Error status.** A Developer or QA turn that finishes without moving its card gets three tries in all, and each retry is told what went wrong in the last one. A model or connection error is retried too, after 2 and then 10 seconds. After the third try the project stops with an error that says why: press **Resume** to try again, or switch that role to a stronger model.
- **The plan keeps being refused.** The message says what is wrong with it. Ask for changes with a clearer brief, or import a plan.
- **Folder refused.** Choose a different folder: a project folder of its own, away from your home folder and FreeBird's data.
- **Visual QA says the app didn't come up.** QA was shown what the app printed. A missing package or a wrong start command is the usual reason; QA can give `app_start` a corrected command. If the app needs something only you can provide (a database, an API key), turn Visual QA off for that project.
- **Visual QA stops the project instead of passing it** when nothing could be tested: the browser couldn't open the app (check **Settings → Browser & search**), the start command needs a program this computer doesn't have ("Python isn't installed"), or QA never started the app or its start command was denied. Fix that, or turn Visual QA off, and press **Resume**.
- **Another app is already on the port.** Visual QA then only trusts the address the project's own server prints, so it never tests your other app by mistake.
- **Visual QA keeps failing to give a verdict.** QA's model may be too small to work through a test plan. Give QA a stronger model with vision, or turn Visual QA off, and press **Resume**.

# Coding Bot

A **Coding Bot** is a small software team in one bot. You describe a project, and three roles build it in a folder you choose:

- the **Planner** draws the plan: which files the project needs, what the code in each file should do, and how the files connect;
- the **Developer** writes the files and the connections, one card at a time;
- **QA** checks every file and every connection, and sends anything wrong back with a comment saying what is wrong.

The loop repeats until QA has passed everything, or it reaches the round limit and asks you.

Each role can use **skills**: when one fits its work (a code review, a test plan, a debugging routine), it looks it up and follows it. It's on by default; switch it off for the whole team with **Can use skills** in the Coding Bot's **Details → Skills**.

Each role runs on **its own model**, so you can put a strong model on the Planner and a fast local one on the Developer, or the same model on all three. Everything works with Ollama only, with cloud models, or with a mix.

## Create one

Press **+ → New Coding Bot**. You choose:

| Setting                           | What it does                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Name**                          | How it appears in your bot list (up to 49 characters, because its team is named after it).               |
| **Output folder**                 | Required. Every project file is written here. Use **Browse** in the desktop app, or type the path.       |
| **Planner, Developer, QA models** | One model per role. Leave one empty to use the shared model. You can change them later under **Models**. |
| **Auto-approve**                  | Off by default. When on, the Developer starts as soon as the plan is ready, without waiting for you.     |
| **Visual QA**                     | Off by default. When on, QA also uses the finished app like a person. See [Visual QA](#visual-qa).       |
| **QA round limit**                | How many times QA may send work back before it stops and asks you. Default 5, any number from 1 to 20.   |

The output folder must be a folder on this computer that you can write to. FreeBird refuses a drive root, your home folder itself, FreeBird's own data folder, another bot's folder, the output folder of another Coding Bot, network and `\\server\share` paths, and names ending in a dot or a space or named like a device (`CON`, `NUL`). A folder that doesn't exist yet is created.

## How a project runs

1. **Brief.** Describe what you want in the Coding Bot's chat. The first message is the brief.
2. **Planning.** The Planner turns the brief into a plan. If the plan is invalid, it is told exactly what is wrong and tries again (up to four attempts).
3. **Your approval.** The plan waits for you. Press **Approve**, or **Ask for changes** and say what to change, and the Planner revises it. With **auto-approve** on, this step is skipped. You can switch it on or off at any time.
4. **Building.** The Developer takes one card at a time, files first in the order the Planner chose. A connection is built only after every file it links exists. Each card moves **Todo → In progress → QA**.
5. **Checking.** QA reviews one card at a time. A card that passes moves to **Done**. A card that fails goes back to **Todo** with a **comment saying what is wrong**, and the Developer sees that comment when it picks the card up again. QA checks connections as well as files: a connection card passes only if the files really connect the way the plan says.
6. **A fix can break something that already passed.** After every Developer turn, FreeBird notices which planned files changed. Every finished card that touches a changed file goes back to QA: the file's own card and every connection that links it. So "everything is Done" always means it was checked after the last change.
7. **Round limit.** Each full pass of QA over the board is one round. When the limit is reached with cards still failing, the project stops with **Needs you** and a note of what still fails. Raise the limit and press **Resume**.
8. **Whole-project check.** When every card has passed, the project is checked as a whole before it is called done. First, plain automatic checks look for mistakes that span files, such as a plain `<script>` tag loading a file that uses `import`, a missing file or import, an id the script looks for that no page has, a JSON file that doesn't parse, or a key that looks real. Anything found sends the right card back with a comment. If the automatic checks find nothing, QA gets one last turn to look across the files.
9. **Visual QA** (if it's on). Once the whole-project check passes, QA starts the app and uses it. See [Visual QA](#visual-qa).
10. **Done.** When the whole-project check passes (and Visual QA, if it's on), the project is complete. The Coding Bot's closing message ends with a short **Before you run it** list, for example "add your own API key in `api-config.js`" or "open it through a local web server, not by double-clicking the file".

Typing in the Coding Bot's chat doesn't start a model of its own:

- the first message is the brief;
- while a plan waits for approval, a message is feedback for the Planner;
- **after the project is done, a message is a change request**: the Planner updates the plan, cards for unchanged files stay Done, and only what changed is built again, after your approval as usual;
- if planning failed before any card existed, a message is a new brief;
- otherwise you get a one-line status reply.

**Stop** and **Resume** work at any time, from the panel or the message box's Stop button. Stopping one of the team's conversations stops the project too, and Resume carries on. If you close the app while it is working, the project comes back **Stopped** with the unfinished cards back in Todo, and you can resume it; a change request you had asked for is kept.

## Visual QA

Reading code doesn't show that a button works. With **Visual QA** on, QA also opens the finished app and uses it like a person, after all its usual checks have passed. Turn it on when you create the Coding Bot, or any time with the **Visual QA** switch in the panel, next to **Auto-approve**. It adds to QA's other checks and replaces none of them.

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

**What asks first.** Opening web pages runs nothing on your computer, so it doesn't ask. Starting an app with a command runs code the team wrote, so it shows an approval card like any command QA runs. On the app's own pages, QA's clicks and typing never ask, since nothing there can buy or send anything. If QA ends up on another site, it is told to go back, and its clicks there ask as usual. The browser can only open the app's own address on this computer, and only while Visual QA runs. It never serves `.env` files, private keys or hidden files.

**Where the screenshots go.** They go to QA's model, like any picture a bot sees: with a local model they stay on this computer, and with a cloud model they are sent to that provider.

Visual QA uses the browser from **Settings → Browser & search** (Edge or Chrome). Expect each Visual QA pass to add a few minutes.

## The panel

A panel beside the chat has three tabs, plus a header that shows the status, the round (for example "Round 2 of 5") and the controls.

- **Diagram.** Each file is a box showing its path and what its code should do. Each connection is a small round junction joined to every file it links, so a connection can link two files or ten. The colour of a box shows where its card is. Click a box or a junction to see its details and comments. Zoom, fit and a legend are built in.
- **Board.** Four columns: Todo, In progress, QA, Done. File cards and connection cards look different, and QA's comments are shown under the card they are about. A card sent back is marked **Needs fixing**.
- **Checklist.** Every file and every connection as a line, ticked when its card is Done, with a total.

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

- **Plan (JSON)**: the file you can import again. It lists your brief, the files (`path`, `purpose`) and the connections (the paths they link and a description).
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
- **Running commands always asks**, for example tests or installing packages, even if you set **Execution on this computer** to always allow; set to never allow, QA can't run commands at all. Only QA runs commands; the Developer can't. The card appears in the Coding Bot's chat, and the command runs from the output folder. A command waiting for your answer does not block the model for anything else. Commands never see FreeBird's own access token.
- The roles cannot create helpers or hand work to other bots, and other bots cannot hand work to a Coding Bot.
- **Deleting the Coding Bot deletes its three roles and its board, never your project files.** The output folder is not touched.

## Tips

- Planning is the step that most depends on the model. A small local model can plan a few files, but for a larger project use a stronger model for the Planner, or import a plan.
- Keep the first brief short and concrete: what it is, the language, and what it must do.
- On a local model the three roles run one after another, so swapping models between roles takes a moment. Using one model for all three avoids that.
- **Nobody invents secrets.** The Developer and QA never make up an API key, token or password. A file that needs one gets a clearly marked placeholder such as `YOUR_API_KEY_HERE` and a comment saying where to get one. QA accepts that placeholder and fails a file with a made-up key. You add the real key.
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

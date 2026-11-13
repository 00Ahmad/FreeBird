# Coding Bot

A **Coding Bot** is a small software team in one bot. You describe a project, and three roles build it in a folder you choose:

- the **Planner** draws the plan: which files the project needs, what the code in each file should do, and how the files connect;
- the **Developer** writes the files and the connections, one card at a time;
- **QA** checks every file and every connection, and sends anything wrong back with a comment saying what is wrong.

The loop repeats until QA has passed everything, or it reaches the round limit and asks you.

Each role runs on **its own model**, so you can put a strong model on the Planner and a fast local one on the Developer, or the same model on all three. Everything works with Ollama only, with cloud models, or with a mix.

## Create one

Press **+ → New Coding Bot**. You choose:

| Setting                           | What it does                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Name**                          | How it appears in your bot list.                                                                       |
| **Output folder**                 | Required. Every project file is written here. Use **Browse** in the desktop app, or type the path.     |
| **Planner, Developer, QA models** | One model per role. Leave one empty to use the shared model.                                           |
| **Auto-approve**                  | Off by default. When on, the Developer starts as soon as the plan is ready, without waiting for you.   |
| **QA round limit**                | How many times QA may send work back before it stops and asks you. Default 5, any number from 1 to 20. |

The output folder must be a folder you can write to. FreeBird refuses a drive root, your home folder itself, FreeBird's own data folder, another bot's folder, and the output folder of another Coding Bot. A folder that doesn't exist yet is created.

## How a project runs

1. **Brief.** Describe what you want in the Coding Bot's chat. The first message is the brief.
2. **Planning.** The Planner turns the brief into a plan. If the plan is invalid, it is told exactly what is wrong and tries again (up to four attempts).
3. **Your approval.** The plan waits for you. Press **Approve**, or **Ask for changes** and say what to change, and the Planner revises it. With **auto-approve** on, this step is skipped. You can switch it on or off at any time.
4. **Building.** The Developer takes one card at a time, files first in the order the Planner chose. A connection is built only after every file it links exists. Each card moves **Todo → In progress → QA**.
5. **Checking.** QA reviews one card at a time. A card that passes moves to **Done**. A card that fails goes back to **Todo** with a **comment saying what is wrong**, and the Developer sees that comment when it picks the card up again. QA checks connections as well as files: a connection card passes only if the files really connect the way the plan says.
6. **A fix can break something that already passed.** After every Developer turn, FreeBird notices which planned files changed. Every finished card that touches a changed file goes back to QA: the file's own card and every connection that links it. So "everything is Done" always means it was checked after the last change.
7. **Round limit.** Each full pass of QA over the board is one round. When the limit is reached with cards still failing, the project stops with **Needs you** and a note of what still fails. Raise the limit and press **Resume**.
8. **Whole-project check.** When every card has passed, the project is checked as a whole before it is called done. First, plain automatic checks look for mistakes that span files, such as a plain `<script>` tag loading a file that uses `import`, a missing file or import, an id the script looks for that no page has, a JSON file that doesn't parse, or a key that looks real. Anything found sends the right card back with a comment. If the automatic checks find nothing, QA gets one last turn to look across the files.
9. **Done.** When the whole-project check passes, the project is complete. The Coding Bot's closing message ends with a short **Before you run it** list, for example "add your own API key in `api-config.js`" or "open it through a local web server, not by double-clicking the file".

Typing in the Coding Bot's chat while it works doesn't start a model: after the brief, a message becomes feedback for the Planner while a plan awaits approval, and otherwise you get a one-line status reply. **Stop** and **Resume** work at any time. If you close the app while it is working, the project comes back **Stopped** with the unfinished cards back in Todo, and you can resume it.

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
4. **Apply.** The plan still waits for your approval, unless auto-approve is on. The Planner is skipped, so its model can stay empty.

You can import before the Developer starts. Once work has begun, importing asks you to confirm that the board will be reset.

A plan can have up to **40 files** and **80 connections**. Paths are relative to the output folder (no drive letters, no `..`), every file needs a purpose, and every connection links two or more of the listed files.

## Safety

- **File writes need no approval card inside the output folder**, because that folder is the project. Anything outside it asks first, as for every bot. A link or junction that points out of the folder counts as outside.
- **Running commands always asks**, for example tests or installing packages. Only QA can run commands; the Developer can't. The card appears in the Coding Bot's chat, and the command runs from the output folder. A command waiting for your answer does not block the model for anything else.
- The roles cannot create helpers or hand work to other bots, and other bots cannot hand work to a Coding Bot.
- **Deleting the Coding Bot deletes its three roles and its board, never your project files.** The output folder is not touched.

## Tips

- Planning is the step that most depends on the model. A small local model can plan a few files, but for a larger project use a stronger model for the Planner, or import a plan.
- Keep the first brief short and concrete: what it is, the language, and what it must do.
- On a local model the three roles run one after another, so swapping models between roles takes a moment. Using one model for all three avoids that.
- **Nobody invents secrets.** The Developer and QA never make up an API key, token or password. A file that needs one gets a clearly marked placeholder such as `YOUR_API_KEY_HERE` and a comment saying where to get one. QA accepts that placeholder and fails a file with a made-up key. You add the real key.
- **The Developer writes and QA tests.** The Developer writes only the file for its card (it can read the files its card connects to), takes at most 15 steps per card, has no thinking turned on for Ollama models (so it doesn't spend minutes reasoning before every file) and can't run commands. QA runs your code to check it and installs what the project needs, sometimes with several small commands in one review. Each command asks first, in the Coding Bot's chat, so expect a few cards while it checks.
- A file the team already wrote in this project (for example before a restart) isn't written again: its card goes straight to QA, unless QA has already sent it back.
- The roles appear under **Hidden Bots**. Clicking one opens its conversation with the Coding Bot, under **Bot conversations**.

## If something goes wrong

- **"Needs you" after the round limit.** Read the note, raise the limit in the panel and press **Resume**, or step in and edit the files yourself.
- **A card takes very long.** The **Slow** badge shows which one. A reasoning model can spend many minutes per file; give the Developer a smaller or faster model under **Models**, then **Stop** and **Resume**.
- **Error status.** A Developer or QA turn that finishes without moving its card is retried up to three times, then the project stops with an error. Press **Resume** to try again, or switch that role to a stronger model.
- **The plan keeps being refused.** The message says what is wrong with it. Ask for changes with a clearer brief, or import a plan.
- **Folder refused.** Choose a different folder: a project folder of its own, away from your home folder and FreeBird's data.

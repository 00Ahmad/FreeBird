# Races & Clusters

Two ways to put several bots on one problem that you won't find in Grok Bot. Both work with an Ollama-only setup, with cloud models, or with a mix where every bot runs on a different model.

|                             | 🏁 Race                                                          | 🕸️ Cluster                                                             |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Idea**                    | Competition: who does the task best?                             | Collaboration: what's true, and what should we do?                     |
| **Bots**                    | 3–5 racers, plus a judge                                         | 3–5 experts, plus a moderator                                          |
| **Do they see each other?** | No: each works alone                                             | Yes: they answer and challenge each other                              |
| **You get**                 | Scores, a winner, and one final result built from the best parts | A structured summary: findings, disagreements, sources, open questions |
| **Best for**                | Writing, plans, code, research reports, comparing models         | Decisions, research questions, brainstorming, stress-testing ideas     |

---

## Races

A race gives the **same task to 3–5 bots that work independently**. A judge then compares what they delivered and compiles the best possible answer.

### Starting a race

1. **+ → New race**.
2. Write the task, for example _"Write a one-page launch plan for a budgeting app for students."_
3. Name 3–5 racers and choose each one's model: the shared model, or any model you've set up. Mixing models (a local 9B, a small 4B and a cloud model) makes it a head-to-head model comparison.
4. Choose **the judge's model**.

### What happens

1. **Racing.** Every racer gets the task in its own thread and works alone; none sees the others. Each starts by choosing a strategy, ideally one the others might not think of, and writes it as the first line of its answer. Racers can search and read the web and work with files in their own folder, but they never stop to ask you questions: they make reasonable assumptions and state them.
2. **Judging.** When all racers are done (or when you press **Judge now**), the judge:
   - picks **3–5 criteria** that matter for this task (correctness, completeness, evidence, clarity, originality, practicality…),
   - fills in a **score table**, 1–10 per criterion per racer,
   - names the **winner** and explains why, including what each other racer did well,
   - writes the **final result**: the actual answer to your task, built from the strongest parts of every racer, with _(from Name)_ after each borrowed part.
3. You can open any racer's own thread to see exactly how it got there.

Press **Stop** at any time to end the race. Links the racers never actually opened or wrote are flagged in the judge's report, so invented sources don't slip through.

### Tips

- Races shine on open-ended tasks with many good answers. For a single fact, one bot is enough.
- Each racer is a full bot run, so a race costs about racers × one reply. On a local model, racers run **one after another**: each keeps the model until it has finished, then the next one starts (and if racers use different local models, the model is switched only between racers). Raise **Bots at once** in **Settings → Local model** to run several at the same time if your GPU has room.

---

## Clusters

A cluster is a **moderated discussion between 3–5 expert bots**. They argue from different perspectives, check each other's sources, and end with a summary shaped by the goal you chose.

### Starting a cluster

1. **+ → New cluster**.
2. Write the **topic**, for example _"Should our 20-person company move from AWS to its own servers?"_
3. Pick a **goal**:
   - **Explore ideas**: come up with options and stress-test them.
   - **Reach a decision**: weigh the options against the evidence and end with one clear recommendation.
   - **Research a question**: find out what's true from good sources and flag what's uncertain.
4. FreeBird **proposes a team**: each expert with a name, an expertise (e.g. _Cloud cost analyst_) and a personality and point of view. Edit them, add or remove experts, and optionally give each its own model.
5. Choose how many rounds (1–6).

You can also start a discussion in an existing group chat.

### The rules every expert follows

- **Back every claim**, either with a source opened in this discussion (with its full address) or with step-by-step reasoning someone could check.
- **Never invent** facts, numbers, studies, quotes or addresses. Unverified claims are marked as unverified.
- **At most a few lookups per turn**, preferring official and primary sources.
- **Answer each other by name**: say exactly which claim you challenge or build on, and why. Agreeing to be polite counts as a failure.
- **Add something new every turn**: evidence, a counter-argument, a flaw or a better option.
- **Speak only for yourself**, in about 200 words plus sources.

During a cluster, experts keep only research tools (search, open and read pages). They can't run commands or change anything.

### Watching and steering

- A **moderator** on the shared model picks who speaks next and what they should focus on.
- The **control panel** lets you **pause**, **resume**, **step** (one turn at a time while paused) or **finish** (wrap up and summarize now).
- **Type into the discussion** at any time to add information or redirect it.
- The **timeline** shows each turn with its sources; the round table shows who has spoken.

### The summary

At the end the moderator writes a summary in a fixed shape for the goal:

| Explore ideas        | Reach a decision                                       | Research a question     |
| -------------------- | ------------------------------------------------------ | ----------------------- |
| Most promising ideas | **Recommendation** with confidence (high, medium, low) | What the evidence shows |
| Weak spots and risks | Arguments for and against                              | Disputed or uncertain   |
| Where they disagreed | Where they disagreed                                   | Claims without a source |
| Sources cited        | Sources cited                                          | Sources cited           |
| Open questions       | What would change the recommendation                   | Open questions          |

Any link in the summary that no expert actually opened or wrote is replaced by its label marked _"no address given"_, so you can tell checked sources from made-up ones.

# Job Bot

A **Job Bot** looks for jobs that fit **you**, not just "jobs". It asks you about the job you want, then, each time you ask, searches for new jobs, reads every one, checks each fact against the posting itself and puts the jobs on a board with a match score explained line by line.

Your profile, your reactions and the whole search stay on your computer, and it works with a local model.

## Create one

Press **+ → New Job Bot** and choose:

| Setting   | What it does                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**  | How it appears in your bot list (up to 46 characters, because its team is named after it).                                                                          |
| **Model** | The model its whole team uses; empty means the shared model. A model that can see pictures (like `qwen3.5:9b`) also lets it read pages that only work in a browser. |

Underneath, a Job Bot is a small team of hidden role bots, each with its own conversation under **Bot conversations**:

- the **Interviewer** asks about the job you want and fills in your profile;
- the **Searcher** turns your profile into web searches and companies' career pages;
- the **Checker** reads one page at a time and reports what it says;
- the **Visual helper** is the fallback for pages that won't read any other way.

Each role has exactly one tool, and the steps between them are run by the app, not by a model deciding what to do next.

## 1. The interview

Tell the Job Bot about the job you want in its chat. The Interviewer asks two or three questions at a time: job titles, seniority, remote, hybrid or office and which places, the lowest salary you'd take, must-haves, deal-breakers, right to work, and your skills and experience. Say "skip" to anything you'd rather not answer.

Everything you say lands on the **profile card** in the Job panel, where every field can be edited. Once it has the job titles and where you'd work, press **Approve profile**. You can keep changing the profile later, by editing the card or by telling the Job Bot in its chat.

## 2. A scan, when you ask for one

A Job Bot never searches on its own. Press **Scan** in the Job panel, or tell it in its chat ("find me jobs"). Each time it asks **how many new jobs** to find, from 1 to 50, suggesting the number you used last time. "New" means never shown to you before, in any earlier scan, even if it turns up on another site.

During a scan:

1. The first searches look on companies' own job systems (Greenhouse, Lever, Ashby and Workday) for your first job title; then the Searcher adds its own searches from your profile (the related titles, the places or "remote").
2. The bot runs them and keeps the results that can be job postings or job lists. It reads companies' own career pages first, then other company pages, then job sites.
3. One page at a time, it reads the page and the Checker reports what it is: a job (its facts, and a verdict on each of your requirements), a list of jobs (the links worth following), or neither.
4. Every job that checks out goes on the board. Only jobs that match you (a score of 50 or more) count toward the number you asked for; weaker matches still go on the board, and the summary says how many.

It stops when it has found the number you asked for, or at a limit (pages read, time), and says which: "Found 10 new jobs", or "Found 6 of the 10 you asked for: ran out of places to look". **Stop** ends a scan at any time.

### No made-up jobs

Small models sometimes invent details. So every fact on a job card (title, company, location, workplace, salary, seniority, type, posting date) must come with the **words from the page** that say it, and the app checks that those words are really on the page and really say that value. A fact that doesn't pass shows as **Not stated**, never as a guess. A page whose title or company doesn't check out isn't shown as a job at all. The address on every card is the page the bot actually read, never one a model wrote.

### Reading difficult pages

Pages are read the cheapest way that works:

1. a job system's public job list (Greenhouse and Lever publish theirs);
2. the page as text;
3. the page in the Job Bot's own browser tab, for pages built with JavaScript;
4. the **Visual helper**, only when the browser couldn't show the jobs either. It closes pop-ups, clicks "Load more" and scrolls, but never types, signs in or submits anything, and it reads at most 5 pages per scan. It needs a model that can see pictures; with one that can't, this step is skipped.

The app, not a model, decides when to move to the next way. A site that needed the browser is remembered, so the next scan goes straight to it. A site whose pages can't be used twice in a scan (most job boards block automated reading) is skipped for the rest of that scan.

### When a page needs you

If a page shows a CAPTCHA or wants you to sign in, the bot never tries to get past it. The Job panel says what the page wants and shows **Continue** and **Skip this page**. Deal with it in the **Browser** panel of the Job Bot's chat (or the browser window), then press Continue. Nothing is held while it waits, and after 10 minutes without an answer the page is skipped.

Job sites that don't allow automated reading (such as LinkedIn and Indeed) are only ever read one posting at a time. Their lists are never followed.

## 3. The board

Jobs land in **Found**, strongest match first. Open one to see:

- **Facts**, each with the words from the page it came from;
- **How it matches you**: one line per requirement, ✅ meets, ⚠️ partly, ❌ misses or ❔ not stated, each with its reason. The score (0–100) is worked out by the app from these lines. A job with one of your deal-breakers scores at most 10, one that isn't the job you want at most 25, and one missing a must-have at most 45. A job whose title has every word of a title you want always counts as the job you want: the app checks that itself;
- **Warning signs**, found by fixed rules (never a model's own words): posted long ago (it may be filled, or stay up without anyone hiring), no salary, scam-like wording (paying a fee, interviews over a chat app), a deal-breaker the job may have (an on-call rotation when yours is weekly on-call: it keeps its score and you decide), an agency hiding the employer, or a page that says the job is closed;
- **About the company**, as the posting describes it;
- **Open the posting** to read it yourself.

**Good fit** moves a job to Shortlisted and **Not for me** moves it to Not for me. Move any job to Preparing, Applied, Interview, Offer or Rejected as your search goes on.

### It learns from you

Add a reason when you react ("too junior", "no fintech industry", "not at Acme again", "love the 4-day week"). The Job Bot then **suggests** a change to your profile, such as a deal-breaker, an industry or company to avoid, or a nice-to-have. It shows on the profile card for you to **Add** or dismiss, and it never changes the profile on its own.

## Privacy

- Your profile, your board and your reactions are stored in FreeBird's database on this computer.
- What leaves it: the web searches the bot runs (through your search setting in **Settings → Browser**), the pages it opens, and, if you use a cloud model, the page text and your profile sent to that model.
- It never applies for a job, sends anything or signs in for you.

## If something goes wrong

- **"The web searches found nothing."** Search engines often return nothing to a hidden browser. Set up a search service in **Settings → Browser**, or turn on **Show the browser window**.
- **Few jobs, many "couldn't confirm" lines in Activity.** The model couldn't quote the page well enough. A larger model helps.
- **The Visual helper is never used.** It needs a model that can see pictures; pick one for the Job Bot.
- **A scan stopped with "The Checker failed 3 times in a row".** The model isn't answering: check it in **Settings → Local model**, then start a new scan.

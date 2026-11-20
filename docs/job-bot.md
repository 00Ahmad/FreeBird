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

Tell the Job Bot about the job you want in its chat. The Interviewer asks two or three questions at a time: job titles, seniority, remote, hybrid or office and which places, the lowest salary you'd take, must-haves, deal-breakers, right to work, and your skills and experience. It knows which question you're answering, so "the first one" or "60k" works.

Say "skip" (or "not sure", "no preference") to anything you'd rather not answer. It won't ask that again, nor anything it has already asked.

Telling it more adds to your lists, never replaces them: "also Go" adds Go to your must-haves. To take something out, say so ("drop Python"). The app keeps only what you actually said. A list item must share a word with your message (or a form of one: "accounting" for "accountants"), and a lowest salary must have its amount in your message. Anything else is left out and noted in Activity. Each reply ends with what was saved, such as _Saved: Added must-have: Go_, so a wrong save shows at once.

Everything you say lands on the **profile card** in the Job panel, where every field can be edited. Once it has the job titles and where you'd work, press **Approve profile**. You can keep changing the profile later, by editing the card or by telling the Job Bot in its chat.

The Checker takes at most 30 requirements per job. With a longer profile, the profile card says how many won't be checked. Deal-breakers, where you'd work, pay and industries to avoid always come first. Languages, nice-to-haves and must-haves are cut first, in that order. Companies to avoid don't count toward the 30, because the app checks them itself.

## 2. A scan, when you ask for one

A Job Bot never searches on its own. Press **Scan** in the Job panel, or tell it in its chat ("find me 10 jobs"). Each time it asks **how many new jobs** to find, from 1 to 50, suggesting the number you used last time. "New" means never shown to you before, in any earlier scan, even if it turns up on another site.

A number counts as the number of jobs only when it's said that way ("10 jobs"), never inside an amount ("40,000", "50k"). When a message could mean a scan or a profile change ("search for jobs paying more"), the bot asks "Start a scan now, or change your profile?" instead of guessing.

During a scan:

1. The app makes the searches from your profile: each job title and related title, remote and each place, on companies' own job systems (Greenhouse, Lever, Ashby and Workday). It runs a few new ones each round. The Searcher adds its own searches when those run out. Searches run in the last 14 days aren't run again.
2. The bot runs them and keeps the results that can be job postings or job lists. Results whose title fits a job you want come first. A single posting whose title is plainly another job is dropped before it's read. It reads companies' own career pages first, then other company pages, then job sites.
3. One page at a time, it reads the page. A job system's list is picked through by the app itself, by job title, preferring places that suit you. For other pages, the Checker reports what the page is: a job (its facts, and a verdict on each of your requirements), a list of jobs (the links worth following), or neither.
4. Every job that checks out goes on the board. Only jobs that match you (a score of 50 or more) count toward the number you asked for; weaker matches still go on the board, and the summary says how many.

It stops when it has found the number you asked for, or at a limit (pages read, or the time limit for the whole scan), and says which: "Found 10 new jobs", or "Found 6 of the 10 you asked for: ran out of places to look". The time limit ends even a page read or model turn in progress. **Stop** ends a scan at any time. A stopped or failed scan still says what it found. If you're looking at another chat when a scan ends, a desktop notice tells you.

Pages that led nowhere are remembered, so later scans don't read them again for 30 days, or a year for a page that won't come back. That covers a page that wasn't a job, a closed or missing posting, a job that couldn't be confirmed, and a job already on your board under another address. Lists of jobs are never remembered this way, because new jobs appear on them.

### No made-up jobs

Small models sometimes invent details. So every fact on a job card (title, company, location, workplace, salary, seniority, type, posting date) must come with the **words from the page** that say it, and the app checks that those words are really on the page and really say that value. A fact that doesn't pass shows as **Not stated**, never as a guess. A page whose title or company doesn't check out isn't shown as a job at all. The address on every card is the page the bot actually read, never one a model wrote.

### Reading difficult pages

Pages are read the cheapest way that works:

1. a job system's public job list (Greenhouse, Lever, Ashby and SmartRecruiters publish theirs), always tried first when it handles the address;
2. the page as text;
3. the page in the Job Bot's own browser tab, for pages built with JavaScript;
4. the **Visual helper**, only when the browser couldn't show the jobs either. It closes pop-ups, clicks "Load more" and scrolls, but never types, signs in or submits anything. It gets at most 5 tries per scan, failed ones included, and 3 minutes per try. It needs a model that can see pictures. When the model can't, the helper is skipped for the rest of the scan, and Activity says so once.

The app, not a model, decides when to move to the next way. A page that answers with an error (such as 403 or 500) moves on to the next way too; it is never checked as a job. A site that needed the browser is remembered for 30 days, per employer, so the next scan goes straight to it, and after that the cheap ways get another try. A site whose pages can't be used twice in a scan (most job boards block automated reading) is skipped for the rest of that scan.

### When a page needs you

If a page shows a CAPTCHA or wants you to sign in, the bot never tries to get past it, and it doesn't stop the scan to wait for you either. It tries the browser first, in case the page only looked that way as text. If the page still needs you, it is set aside, and the scan carries on with other pages. A site that wants you for two of its pages is skipped for the rest of the scan.

When the scan runs out of other pages short of the number you asked for, it asks you about the pages it set aside, one at a time. A scan ended by **Stop** or by the time limit doesn't ask. It only says how many pages were left unread. The Job panel says what the page wants and shows **Continue** and **Skip this page**. Deal with it in the **Browser** panel of the Job Bot's chat (or the browser window), then press Continue. After 10 minutes without an answer, that page and the rest are skipped, and the closing words say how many were left unread. This waiting doesn't count toward the scan's time limit.

Job sites that don't allow automated reading (such as LinkedIn and Indeed) are only ever read one posting at a time. Their lists are never followed.

## 3. The board

Jobs land in **Found**, strongest match first, or newest first if you choose. Jobs from the latest scan are marked **New**, and **Only new** shows just those. Each card shows the day it was found. Open one to see:

- **Facts**, each with the words from the page it came from;
- **The Checker's summary**: one line about the job, in the Checker's own words;
- **How it matches you**: one line per requirement, ✅ meets, ⚠️ partly, ❌ misses or ❔ not stated, each with its reason. The score (0–100) is worked out by the app from these lines. A job with one of your deal-breakers scores at most 10, one that isn't the job you want at most 25, and one missing a must-have at most 45. Reasons are the Checker's own words, except lines marked **(checked by the app)**. The app checks these from the facts confirmed on the page:
  - the job title: a title with the words of one you want, together and in order, always counts as the job you want, so "Senior Backend Engineer" fits "Backend Engineer", but "Senior Product Marketing Manager" doesn't fit "Product Manager";
  - companies to avoid;
  - remote, hybrid or office;
  - pay, when the posting gives it in your currency and period, judged on the top of its range.
- **Warning signs**, found by fixed rules (never a model's own words): posted long ago (it may be filled, or stay up without anyone hiring), no salary, scam-like wording (paying a fee, interviews over a chat app), a deal-breaker the job may have (an on-call rotation when yours is weekly on-call: it keeps its score and you decide), an agency hiding the employer, or a page that says the job is closed;
- **About the company**, as the posting describes it;
- **Open the posting** to read it yourself.

**Good fit** moves a job to Shortlisted and **Not for me** moves it to Not for me. Move any job to Preparing, Applied, Interview, Offer or Rejected as your search goes on.

The board holds at most 500 jobs. To make room, only Not for me jobs and weaker Found jobs are dropped, never one you're working on. When there's no room left, the scan ends and says so.

### Is it still open?

**Check still open** on the board reads each Found and Shortlisted job again (at most 40), the cheap way and with no model. A job whose posting is gone, or says it's closed, gets a warning with the date it was checked. It runs only when you press it, never during a scan.

### When your profile changes

After any change to your profile, whether in chat, on the card or by accepting a suggestion, every job on the board is updated with no model and no page read again. The Checker's earlier verdicts stay. The parts the app checks itself (title, companies to avoid, workplace, pay) are checked again, and the score is worked out again. A job read before you added a requirement says how many newer requirements weren't checked on it.

### It learns from you

Add a reason when you react ("too junior", "no fintech industry", "not at Acme again", "love the 4-day week", "salary too low"). The Job Bot then **suggests** a change to your profile: a deal-breaker, an industry or company to avoid, a nice-to-have, a seniority ("too junior" suggests Senior), or a lowest salary (just above that job's pay). It shows on the profile card for you to **Add** or dismiss, and it never changes the profile on its own.

## Privacy

- Your profile, your board and your reactions are stored in FreeBird's database on this computer.
- What leaves it: the web searches the bot runs (through your search setting in **Settings → Browser**), the pages it opens, and, if you use a cloud model, the page text and your profile sent to that model.
- It never applies for a job, sends anything or signs in for you.

## If something goes wrong

- **"The web searches found nothing."** Search engines often return nothing to a hidden browser. Set up a search service in **Settings → Browser**, or turn on **Show the browser window**.
- **Few jobs, many "couldn't confirm" lines in Activity.** The model couldn't quote the page well enough. A larger model helps.
- **The Visual helper is never used.** It needs a model that can see pictures; pick one for the Job Bot. Activity says when the model can't.
- **"N pages needed you and were left unread."** Those pages wanted a CAPTCHA or a sign-in, and nobody answered at the end of the scan. Start another scan while you're at the computer to deal with them.
- **A scan stopped with "The Checker failed 3 times in a row".** The model isn't answering: check it in **Settings → Local model**, then start a new scan.

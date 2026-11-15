# Client Bot

A **Client Bot** finds businesses that may need what **you** sell: payroll, marketing, software development, IT support, or any other service. It asks what you sell and who your ideal client is. Then, each time you ask, it looks for businesses that are asking for a provider, businesses that show signs they may need you right now, and businesses that fit your ideal client but have never posted anything. It checks every fact against the page or official record it came from and puts each business on a board, with the evidence and a way to reach them.

Your profile, your lists and every lead stay on your computer, and it works with a local model. It never sends anything for you.

## Why it doesn't just search for your service

Searching for "payroll Leeds" mostly finds **other payroll companies**, and "top 10 payroll providers" lists. Clients rarely post "we need a payroll provider". So the Client Bot doesn't search for your service. It searches for the **situations in which a business needs it**, and it calls each one a **sign**:

| You sell             | Signs that a business may need it                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Payroll              | Hiring a payroll clerk, or its first employees; a newly registered company; opening a new site; a tender for payroll |
| Marketing            | Just raised money; hiring its first marketer; an old website; no blog; a "seeking an agency" post                    |
| Software development | A "looking for a development partner" post or tender; hiring contract developers; an old website                     |

Every lead is one of three kinds, ranked in this order:

1. **Asking now**: a public tender, or a post asking for a provider. The strongest.
2. **With signs**: it fits your ideal client and shows a sign, such as hiring for the work you do.
3. **Quiet fit**: it fits your ideal client and has never posted anything, but facts about it (30 staff, three restaurants) say it almost certainly has the need. Found through official registers and its own website.

## Create one

Press **+ → New Client Bot** and choose:

| Setting   | What it does                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**  | How it appears in your bot list (up to 46 characters, because its team is named after it).                                                                          |
| **Model** | The model its whole team uses; empty means the shared model. A model that can see pictures (like `qwen3.5:9b`) also lets it read pages that only work in a browser. |

Underneath, a Client Bot is a small team of hidden role bots, each with one tool and its own conversation under **Bot conversations**: the **Interviewer**, the **Searcher**, the **Checker**, and the **Visual helper**, the fallback for pages that won't read any other way. The steps between them are run by the app, not by a model deciding what to do next.

## 1. The interview

Tell the Client Bot what you sell in its chat. The Interviewer asks two or three questions at a time:

- your price;
- where you can serve clients;
- your ideal client's industries (or "any") and size in staff;
- who buys it there;
- must-haves;
- industries or places to leave out.

From what you sell, the app picks a **kind of service** (payroll, accounting, marketing, software development, IT support, recruitment, or "other") and fills in the signs, traits and website clues that matter for it. Everything lands on the **Profile** tab of the Client panel, where every field can be edited and every sign switched on or off. Once it has what you sell, where you serve and the industries, press **Approve profile**.

## 2. A scan, when you ask for one

A Client Bot never searches on its own. Press **Scan** in the Client panel, or tell it in its chat ("find me clients"). Each time it asks **how many new leads** to find (1 to 50), and which kinds: asking now, with signs, quiet fits. "New" means a business you've never been shown, in any earlier scan, and one that isn't on your lists.

During a scan, in this order:

1. **The watch list.** Up to 20 quiet fits from earlier scans are checked again for new signs (see below).
2. **Official sources.** Tenders for what you sell (UK Contracts Finder), companies by industry and place (UK Companies House, with your key), and food businesses (UK food hygiene ratings).
3. **Searches built from signs**, by the app: job ads for the work you do on companies' job systems, "looking for a payroll provider" posts, news of funding or new sites.
4. **The Searcher's own searches**, when those run out.

For a news item or a job ad about a company, the bot also finds and reads **the company's own website** to confirm it, so the card can say where it is, how big it is, and how to reach it.

It stops when it has found the number you asked for, or at a limit (pages read, time), and says which. **Stop** ends a scan at any time. Only leads that score 50 or more count toward your number; weaker ones still go on the board, and the summary says how many.

### No made-up companies

Every fact on a lead must come with the **words from the page or record** that say it, and the app checks those words are really there. That covers the company's name, website, place, size and industry, and each sign. A sign must also be the kind of sign it claims, worked out by the app from its words, and its date must be on the page. A fact that doesn't pass shows as **Not stated**. A business whose name can't be confirmed isn't shown.

Contact routes are found by the app itself on the pages read, never by a model.

### Never a competitor

A company whose site offers what you sell is a competitor and is dropped. Pages like "best payroll companies in Leeds" are never read at all.

### Quiet fits: businesses that never posted anything

A quiet fit has to clear a higher bar before it is shown:

- it fits strongly: industry and place both meet, and nothing misses;
- an **official record** confirms it (a register entry);
- its **own website** was found and read;
- it shows at least one **trait** or **clue** for your service.

**Traits** are facts that imply a need: has staff, more than one site, a regulated industry, seasonal staff, staff in more than one country. **Clues** are things the app sees on a company's own site: an old copyright year, no secure connection, an email on a free provider, no blog, no online booking, orders taken by phone.

A restaurant, café, pub, hotel or takeaway whose premises are on the food hygiene register counts as **having staff** (when your profile looks for that trait), since its own website rarely says how many people it employs. Its card says so. Mobile caterers and "other" premises don't count: they are often one person.

Quiet fits always rank below leads with signs, and never score above 70.

### The watch list

Quiet fits are kept on a watch list. Each time **you** start a scan, the bot reads up to 20 of their websites again, the longest unchecked first. When one shows a new sign (it starts hiring, it opens a new site), it **moves up** to a lead with signs, and its card says what changed. Nothing is checked on a timer. Turn the watch list off on the **Lists** tab, or stop watching one company from its card.

### Reading difficult pages

Pages are read the cheapest way that works:

1. a public list (job systems' and registers' own data);
2. the page as text;
3. the page in the Client Bot's own browser tab;
4. the **Visual helper**, at most 5 pages per scan.

If a page shows a CAPTCHA or wants you to sign in, the Client panel shows **Continue** and **Skip this page**. Deal with it in the **Browser** panel, then press Continue. After 10 minutes without an answer, the page is skipped.

LinkedIn, Facebook, marketplaces like Upwork and other sites whose terms don't allow automated reading are never read.

## 3. The board

Leads land in **New**: asking now first, then with signs, then quiet fits, each strongest first. Open one to see:

- **Why now**: each sign, with its quote, its date and a link to where it says so;
- **Why you**: how it fits your ideal client, line by line (✅ meets, ⚠️ partly, ❌ misses, ❔ not stated), plus its traits and clues. The score (0 to 100) is worked out by the app;
- **How to reach them**: the contact page, a business inbox, the main phone line, or for a tender the notice to respond to, plus the official record;
- **Warnings**: an old sign or a closed tender, a company the register says is dissolved, a site that may be a competitor, a large organisation or public body (formal buying), no contact route, an agency post for a hidden client, or a business that may be one person;
- **Facts**, each with the words it came from, and **your note**.

Move a lead through **Shortlisted, Contacted, Replied and Won**, or to **Not a fit**. **Export CSV** saves the board for a spreadsheet or a CRM.

### It learns from you

Add a reason when you react ("too big for us", "not our industry", "too far"). The Client Bot then **suggests** a change to your profile, such as a size limit or an industry to leave out. It also notices patterns: after you turn down several companies of 250 or more staff, it suggests a limit. Suggestions wait on the Profile tab for you to accept or skip.

## 4. Your lists, lookalikes and keys

The **Lists** tab holds:

- **Your clients, competitors and do-not-contact**: paste names or web addresses (or load a CSV). A company on any list is never shown. **Don't contact again** on a lead adds it to do-not-contact.
- **A Companies House API key** (UK). It's free from the Companies House developer site and lets scans find quiet fits by industry and place. It's kept in your system keychain and never reaches a model. Without it, Companies House is skipped and the scan says so.
- **Lookalikes of your best clients.** Add about five clients you love. The bot looks them up in Companies House and works out what they share (industry codes, area, age). It shows you that profile, which you can edit, and only uses it once you approve it. They're also added to your clients list.

## Contact details, privacy and the law

A business's contact details often include people's details, and in the UK and EU that is personal data (GDPR, and PECR for marketing emails). Other countries have their own rules (CAN-SPAM in the US, CASL in Canada), and some, such as Germany, are strict even between businesses. So the Client Bot is careful by design:

- **Company-level routes only:** a contact page, a business's shared inbox (hello@, sales@), its main phone line, or a tender's notice. An address that looks like a person's, a free-provider address and a mobile number are left out.
- **No guessed or "enriched" emails.** The bot never builds firstname.lastname@ addresses and never uses paid lookup services.
- **Nothing is sent by the bot.** You decide whether and how to contact a business.
- **One-person businesses** get a warning: their details are personal data, so use the business phone or contact form, not cold email.
- **Everything stays on this computer:** your profile, lists, leads and notes, in FreeBird's database. **Forget** deletes a lead's card and quotes.
- **What leaves it:** the web searches the bot runs (through your search setting in **Settings → Browser**), the pages it opens, register searches (Contracts Finder, Companies House with your key, food hygiene ratings), and, if you use a cloud model, the page text and your profile sent to that model.

The board says it, and so does this guide: a lead shows signs a business may need you, not certainty, and none of this is legal advice.

## If something goes wrong

- **"The web searches found nothing."** Search engines often return nothing to a hidden browser. Set up a search service in **Settings → Browser**, or turn on **Show the browser window**.
- **No quiet fits.** They need a UK area in your profile, an industry the registers know, and for Companies House your API key (**Lists** tab). The scan's summary lists anything it skipped and why.
- **Many "Not shown" lines in Activity.** Quiet fits must be confirmed by a record and their own website. Small businesses with no website can't pass, by design.
- **Few leads, many "couldn't confirm" lines.** The model couldn't quote the page well enough. A larger model helps.
- **A scan stopped with "The Checker failed 3 times in a row".** The model isn't answering: check it in **Settings → Local model**, then start a new scan.

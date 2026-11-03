# FreeBird — UI/UX Spec (matching Grok Bot)

_Last updated: 2026-10-31. Built from xAI's Grok Bot docs (docs.x.ai/grok-bot/\*) and public guides. See Sources._

## 0. Ground rules

**What we match exactly:** layout, navigation, flows, interaction patterns, card types and their buttons, keyboard shortcuts, settings structure, empty and error states, and mobile structure.

**What we make our own:** product name, logo, app icon, colors, typeface, mascot and avatar artwork, illustrations, and marketing copy. Every "Grok", "Grok Bot", "xAI", "SuperGrok", "Cursor" or "X Chat" reference becomes our own name, or is dropped.

- **Why:** copying the functional UX is normal practice and is what OpenMausBot already does. Copying another company's brand assets or distinctive look risks trademark and trade-dress problems, and could make users think the app is xAI's.
- **Labels:** quoted below where generic (e.g. "Allow once", "Take over", "I'm done"). Product-named labels, such as "Recover Grok Bot's Computer", are reworded.

**Gap:** the docs give structure, labels and flows. They don't give colors, spacing, panel widths or animations. To match those, we need **screenshots or a screen recording of the real app**; see the TODO list.

---

## 1. App layout (desktop)

```
┌───────────────┬──────────────────────────────────────────┬────────────────────────┐
│ SIDEBAR       │ CHAT                                     │ RIGHT PANEL (toggle)   │
│ [+]  [search] │ Header: [avatar] Bot name ▾      [🔧][⧉]  │ Computer preview (live)│
│ ★ Primary Bot │──────────────────────────────────────────│  or Conversation       │
│ 📌 Pinned…    │ transcript: messages, tool activity,     │  details (single-      │
│ ▸ Section A   │ computer-use steps, files, questions,    │  column pane: About,   │
│   Bot, Bot…   │ approval cards, drafts, voice memos      │  Routines, Share…)     │
│ Group chats   │                                          │                        │
│ …             │──────────────────────────────────────────│                        │
│ Connect apps  │ Composer: [📎] text…  [@] [/] [🎤] [〰]    │                        │
│ Hidden Bots   │                                          │                        │
│ [account ▾]   │                                          │                        │
└───────────────┴──────────────────────────────────────────┴────────────────────────┘
```

- It looks like a messaging app: bots are contacts and each chat is one thread.
- **Compact sidebar** toggle: `Cmd/Ctrl+B`.
- The **right panel** shows the live **computer preview** or the **conversation details**. Details open with `Cmd+Shift+I` / `Cmd+Alt+B` on Mac and `Ctrl+Alt+B` on Windows/Linux.
- A **Library** holds pages and generated clips, with a "Pinned" section at the top that syncs across devices.

## 2. Sidebar

- **+ button** at the top (`Cmd/Ctrl+N`). It opens a menu: **Create a Bot**, **New group chat**, **Browse shared Bots** (teams only).
- **Search bots:** `Cmd/Ctrl+Shift+F`. **Command palette:** `Cmd/Ctrl+K`.
- **Primary Bot** shows a small star badge and sits at the top.
- **Pinned** bots come next. **Sections** are created with "Move to new section" or "Move to…".
- **Group chats** are listed alongside bots.
- **Connect apps** item (`Cmd/Ctrl+Shift+M` or `W`).
- **Hidden Bots** at the bottom. Each hidden bot's menu has "Show in sidebar".
- A **"Voice chat in progress"** indicator appears while a call is running.
- **Account menu** at the bottom: Settings, Support → Keyboard shortcuts.
- **Bot right-click menu:**
  - Pin
  - Rename Bot (also by double-clicking the name; Enter saves)
  - Move to new section / Move to
  - Duplicate
  - Share as Template
  - Hide from sidebar
  - Delete (permanent; owner only)
  - For the primary bot only: **Replace with different Bot**
- **Group chat right-click menu:** Rename chat, Hide, Delete.
- Shortcuts:
  - `Cmd/Ctrl+1…9`: jump to sidebar bots
  - `Alt+↑/↓`: previous/next bot
  - `Ctrl+Tab` / `Ctrl+Shift+Tab`: cycle bots
  - `Cmd/Ctrl+[` / `]`: back/forward

## 3. Creating a bot and onboarding

1. **First launch:** a sign-in screen. In our app this is replaced by **local setup**: detect Ollama, pick a model, or add API keys. No account is required.
2. **Create New Bot dialog:** name, then choose an avatar **shape** and **color**, then **Create**. The new bot's chat opens right away.
3. **"Introducing your primary Bot" dialog:** **Create primary Bot** or **Choose an existing Bot**, then **Confirm**.
4. **First message:** the user gives the bot its job, sources and approval limits, and asks it to remember them. Personal bots are configured **by chatting**; there is no settings form.
5. **Avatar editor** has three tabs:
   - **Bot:** pick a shape. Grok Bot offers square, sparkle, clover, flower, heart, house, star, plus options like bigger eyes. **We draw our own shapes.**
   - **Generate:** describe an image, click Generate, then **Set avatar**.
   - **Upload:** drag in or Browse files (under 25 MB), crop, then **Set avatar**.
6. **Import memory from another assistant:** Settings → General → Import → **Start Import** → **Add to Memory**.

## 4. Chat header and bot details

- **Bot name** at the top opens the **details pane** (one column):
  - Click the name to rename. Optional label shows "Add a label" when empty.
  - Avatar (click to edit)
  - **About** (description)
  - **Routines** list. Right-click a routine for Pause, Resume, Test, Edit, Delete.
  - **Share** (template / team)
- **Wrench icon** on the right (`Cmd/Ctrl+Shift+,`) opens **Bot settings** with tabs: **Plugins** (connected apps), **Secrets**, **Skills**, **Files**, **About**.
  - Per-bot toggles: **Notifications**, **Disable drafts for Bot**.
  - Connected apps have **per-tool toggles**, e.g. "31 of 31 tools".
- **Find in chat:** `Cmd/Ctrl+F`.

## 5. Composer

- Paste text, links or images. Attach files (📎). **Drag and drop** files.
- `@` mentions a bot, group, routine or app. `/` runs a saved skill. A line starting with `>` becomes a block quote.
- **Reply** to a specific message (threads). **React** to messages; reactions only acknowledge, they never approve anything.
- **Start voice input** (dictation, `Cmd/Ctrl+D`; hold to talk).
- **Start voice chat** (waveform button). It only shows when the composer is empty.
- You can send a new instruction while the bot is working; it takes priority over background work. "Stop now" stops right away.
- `Enter` or `Cmd/Ctrl+Enter` sends. `Shift+Enter` adds a new line. `Cmd/Ctrl+I` focuses the composer. `Cmd/Ctrl+L` adds the selected text to the chat.

## 6. Transcript items and cards

| Item                            | Contents and buttons                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message                         | Markdown, threads, reactions, attachments                                                                                                                                             |
| Tool activity                   | Collapsible chips showing tool runs and computer-use steps                                                                                                                            |
| Created files                   | File cards that open in the Library or preview                                                                                                                                        |
| Question                        | The bot asks; the user answers inline                                                                                                                                                 |
| **Draft** (email/Slack)         | Editable card labeled "Needs approval" with **Send** / **Send message** and **Discard**. On failure: "Couldn't save. Try again." with **Retry**                                       |
| **Approval (general)**          | **Allow once** · **Always allow** · **Deny**. A saved rule shows "Saved to Custom Rules".                                                                                             |
| **Approval (terminal command)** | **Allow** · **Skip** · **Manage settings**                                                                                                                                            |
| **Approval (ask-first rule)**   | **Allow** · **Not now** · **Edit rule**                                                                                                                                               |
| Approval with no rule to offer  | **Allow** only (no "Always allow")                                                                                                                                                    |
| Expired approval                | "Expired", sometimes with "Always allow next time"                                                                                                                                    |
| Warning badges                  | "This can't be undone" · "This changes sign-in or security settings" · "This shares your data outside this chat"                                                                      |
| **Connect card**                | Sign in to an app: **Connect** / **Reopen** / **Authenticate**                                                                                                                        |
| **Secure Form**                 | One per step: "Never shown to your Bot. Filled directly to example.com." Checkbox: "Securely save to Bot's vault". Result: "Filled into the page…" or "Could not fill into the page." |
| **Secure secret card**          | Masked field → **Save securely** → "Saved securely and kept private". Footer: "Stored securely, never shown to your Bot."                                                             |
| **Takeover request**            | **Take over** → user does the step → **I'm done**                                                                                                                                     |
| Reconnect card                  | Shown when a routine hits an app that's signed out                                                                                                                                    |
| Voice memo                      | **Play/Pause voice memo**, with an expandable transcript                                                                                                                              |
| Voice chat card                 | Call length, opens the transcript. Asks "How was the call?" with **Good** / **Bad**                                                                                                   |
| Payment (Link)                  | **Pay $X** · **Pay another way** · **Deny**                                                                                                                                           |
| Blocked message                 | Notice with **Reset** → "Reset this conversation?" Memory is kept.                                                                                                                    |

## 7. Group chats

- Start one from **+ → New group chat**, `Cmd/Ctrl+Shift+N`, or the `Cmd/Ctrl+K` palette.
- Add **2–6 bots** in a **"To:"** field.
- Bots answer when you write in the group. Use `@bot` to address one bot, or `@everyone` to address all (use sparingly). **Reply** to a specific bot's message.
- Groups have no approval cards, no secret or login requests, no drafts, and no per-bot Notifications switch. Attachments work.
- Bots can message each other and hand off work asynchronously. You can open any bot-to-bot thread to read it.
- Renaming: right-click → **Rename chat**, or click the name in the details pane.

## 8. Computer panel

- A **live preview** in the right panel shows clicks, typing, navigation and status. "Open desktop" goes full screen.
- The cloud desktop dock has a browser, a file manager and a terminal. **Our default is a local Docker/VM desktop** (see PLAN §4.3).
- **Take control** / **I'm done** for steps that need a human: single sign-on, passkeys, CAPTCHAs, QR codes, device or card checks.
- **"Teach a task"** button in the top corner: record a demonstration, which becomes a routine.
- States and actions:
  - **Reconnecting** / "Couldn't reach the Bot's computer" → **Retry**, **Continue in Background**
  - **Update** · "Update still running" · **Keep waiting**
  - **Recover computer** (with a confirm dialog) → **Retry Recovery**
  - **Reset Bot's Computer** → **Retry Reset**

## 9. Connect apps

- Opened from the sidebar item, or by typing `@` in chat.
- **Installed** section lists installed apps. "Added" means installed but not signed in.
- Status labels: **Needs auth** · **Disconnected** · **Disabled by team admin**. Actions: **Reconnect**, **Disconnect**.
- Multiple accounts per app, e.g. several Gmail accounts.
- **Per-tool toggles** for each app.
- **Password Managers** shelf (e.g. 1Password).
- A **built-in email address** for the bot: Choose a name → **Create address** → copy.
- **Bot templates** gallery inside Connect apps → **Import Bot**.

## 10. Routines

- A **weekly calendar view** of scheduled runs, e.g. Mon 8:00 or weekdays 8:00 and 14:00.
- Trigger types: schedule, event (e.g. new email, with sender filters like specific addresses or `*@domain`), webhook.
- Each routine has a right-click menu: **Pause, Resume, Test, Edit, Delete**.
- A completed run's report appears **beside its routine settings**.
- Routines run in the background and keep going when the window is closed. For us that means the harness keeps running as a service.

## 11. Settings (`Cmd/Ctrl+,`)

- **General**
  - Bot → **Auto-review** switch
  - **Custom Rules** table: "When [the bot] wants to:" / "It should:" **Allow automatically** or **Ask first**, with **Add Rule**, **Save Rule**, **Cancel**, **Delete Rule**
  - **Import** (Start Import → Add to Memory)
  - Security Key
  - Microphone
  - Shared Bots (Slack link, "Clear connector preferences")
- **Computer**
  - The bot's computer: Update, Recover, Reset
  - Your computer: **Execution on this computer** = **Ask every time** (default) / **Always allow** / **Never allow**
  - **Route traffic through this computer** toggle
  - First run asks: "Allow [app] and all Bots to run commands on your local computer?" with **Always allow** · **Allow once** · **Never** · **Deny once (Esc)**
- **Connect apps**
- **Vault**
  - **New item** → **Login** / **Card** / **Contact info**
  - **Import from CSV…** (read locally, under 5 MB, duplicates skipped)
  - **Hints** for each entry
  - Payment accounts, default payment method
  - Saved values are write-only; cards show only their last 4 digits
- **Usage:** weekly usage %. Ours shows tokens and cost per bot, with local models at $0.
- **FreeBird additions:**
  - **Models & Providers:** Ollama, local servers, API keys
  - **Shared model runtime:** loaded models, RAM/VRAM, parallel slots
  - **Memory viewer/editor** for each bot

## 12. Voice

- **Dictation:** composer mic button, or `Cmd/Ctrl+D`.
- **Voice chat:** "Connecting…", then a "Voice chat" indicator.
  - Controls: **Mute/Unmute**, **Hang up**, **Show transcript**, **Show settings** (Voice, Speed, Language with Auto-detect)
  - One call at a time. Starting a second asks "End the current voice chat?" with **End and Chat**.
  - No calls in group chats.
  - Errors: "Voice chat failed" / "Connection lost" / "No connection", with **Dismiss**
- **Our default is local voice** (Ollama audio endpoints, whisper.cpp, Chatterbox).

## 13. Sharing and teams

- **Share as template:** Share → **Create a copy** → **Publish** → **Copy link**. The recipient clicks **Add to [app]**. Later: View template details, Update template, Delete Template.
- **Team share dialog "Share this Bot":**
  - Who has access: Your team / **People you invite** (confirm with **Limit access**)
  - Add people or groups as **Collaborator** (can chat) or **Manager** (can also change instructions, skills, memory and apps)
- **Browse shared Bots** → **Add** to keep one in the sidebar.
- **Bring to your team's Slack:** **Connect** → "Awaiting admin approval" → "Connected".
- Error states: Bot Not Found · No Access to This Bot · usage-limit messages.

## 14. Mobile (later phase)

- The same bots, chats and routines as desktop. **+ → New Group Chat**. Bot menu: Share as Template, Replace Primary Bot….
- Edit profile: tap the name → **Edit** → Name / Title → **Done**. Avatar: Shape / Generate / Upload (Choose from Photos, Take Photo).
- iOS: Live Activity and Dynamic Island during voice, Action Button setup.

## 15. Keyboard shortcuts (full list)

| Action                   | Shortcut                                                     |
| ------------------------ | ------------------------------------------------------------ |
| Command palette / search | `Cmd/Ctrl+K`                                                 |
| Search bots              | `Cmd/Ctrl+Shift+F`                                           |
| Jump to sidebar bot 1–9  | `Cmd/Ctrl+1…9`                                               |
| Previous / next bot      | `Alt+↑` / `Alt+↓`                                            |
| Cycle bots               | `Ctrl+Tab` / `Ctrl+Shift+Tab`                                |
| Back / forward           | `Cmd/Ctrl+[` / `]`                                           |
| New bot / new group chat | `Cmd/Ctrl+N` / `Cmd/Ctrl+Shift+N`                            |
| All shortcuts            | `Cmd/Ctrl+/`                                                 |
| Find in chat             | `Cmd/Ctrl+F`                                                 |
| Compact sidebar          | `Cmd/Ctrl+B`                                                 |
| Focus composer           | `Cmd/Ctrl+I`                                                 |
| Add selection to chat    | `Cmd/Ctrl+L`                                                 |
| Settings / Bot settings  | `Cmd/Ctrl+,` / `Cmd/Ctrl+Shift+,`                            |
| Connect apps             | `Cmd/Ctrl+Shift+M` or `W`                                    |
| Dictate                  | `Cmd/Ctrl+D`                                                 |
| Conversation details     | `Cmd+Shift+I` or `Cmd+Alt+B` (mac), `Ctrl+Alt+B` (Win/Linux) |
| Send / new line          | `Enter` or `Cmd/Ctrl+Enter` / `Shift+Enter`                  |
| Zoom                     | `Cmd/Ctrl+=` / `-` / `0`                                     |
| Fullscreen               | `F11` (mac also `Ctrl+Cmd+F`)                                |

## Sources

- https://docs.x.ai/grok-bot/bots
- https://docs.x.ai/grok-bot/chat-and-collaboration
- https://docs.x.ai/grok-bot/computer-and-apps
- https://docs.x.ai/grok-bot/approvals-security-and-privacy
- https://docs.x.ai/grok-bot/vault
- https://docs.x.ai/grok-bot/shared-bots
- https://flaviocopes.com/grok-bot/
- https://www.wrightmode.com/blog/grok-bot-setup-guide
- https://metagrok.io/how-to/start-a-grok-bot-group-chat (says version 0.71 changed the + menu: group chat is now reached by shortcut)

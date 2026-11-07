# ReliefReady

A Calgary caregiver companion: make room for urgent care, keep approved care instructions close, and track what needs attention when life settles down.

## Run the app

Use Node.js 22.18 or newer (the demo tests use Node's TypeScript support).

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`. No credentials are needed for the browser demo. Next.js is pinned to 15.x for the specified Amplify deployment target. Production build: `npm run build`; checks: `npm run typecheck` and `npm test`.

The demo covers intake and confirmed dates, fixture-calendar filtering, recipient and disclosure choices, per-message editing and approval, simulated delivery/responses, deadline expiry, conflict review, an approved care timeline, exact-text profile lookup and Recover grouping. Everything is fictional and held in memory; refresh resets the demo. PDF, voice, Google, AI, database and location integrations are pending. Selecting a PDF does not upload it. The support guide contains source links and makes no verified eligibility, hours or proximity claims.

Frontend fixture logic lives in `lib/demo/` and is separate from live request/state modules owned by the integrations stream. Dependency overrides use patched Nodemailer and PostCSS; verify live integration compatibility when those modules land.

## Team

| Name         | GitHub          | Agent       | Owns                              |
| ------------ | --------------- | ----------- | --------------------------------- |
| Haris (lead) | @haris-n34      | Codex       | Data and infra; Frontend and demo |
| Fadi         | @fadihaider     | Claude Code | AI and retrieval                  |
| Ali          | @alimukhtarawan | Codex       | Integrations and state            |

Folder ownership lives in the owner table in [`AGENTS.md`](AGENTS.md). Ask on the board before editing someone else's folders.

## Get set up

```bash
gh auth login                          # once per machine
gh repo clone fadihaider/hack-the-change-2026
cd hack-the-change-2026
tools/board whoami                     # should print your GitHub login
tools/board read                       # see recent posts
```

Requires `bash`, `git`, and the [GitHub CLI](https://cli.github.com).

## The board

All coordination happens on the pinned **[Message Board (issue #1)](https://github.com/fadihaider/hack-the-change-2026/issues/1)**. Every agent posts there when it finishes or needs something, and tags teammates by GitHub login (`@all` for everyone).

- Start every post with whose agent it is: `[Fadi's Claude] ...`
- Keep it short: what changed, which files or contracts, what you need, from whom.
- Full rules are in [`AGENTS.md`](AGENTS.md).

| Command                                 | What it does                                                  |
| --------------------------------------- | ------------------------------------------------------------- |
| `tools/board post "[Name's Agent] ..."` | Post to the board                                             |
| `tools/board unread`                    | Show new posts since your last check; flags ones that tag you |
| `tools/board wait`                      | Block until someone else posts, then print it                 |
| `tools/board read -n 20`                | Show the last 20 posts                                        |
| `tools/board whoami`                    | Print your GitHub login                                       |

**Claude Code** should keep one background `tools/board wait` active and handle completion notifications; local `.claude/` hooks can remind it on session start. PR #3 makes Claude configuration local, so fresh clones must activate the loop explicitly. **Other agents** (Codex, Cursor, etc.) should run `tools/board unread` before each task and use a supported recurring chat wake-up for unattended work.

For ongoing autonomous work, use [the autopilot instructions](docs/AUTOPILOT.md). A board listener alone does not start a Codex turn. Haris's current chat has a scheduled one-minute wake-up; other agent sessions must activate their own supported wake-up mechanism and confirm it on the board.

---

Board setup from [azizu06/hackathon-agent-board](https://github.com/azizu06/hackathon-agent-board).

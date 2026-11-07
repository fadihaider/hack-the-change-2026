# hack-the-change-2026

_Project description goes here once we pick the idea._

## Team

| Name | GitHub | Agent | Owns |
|---|---|---|---|
| Haris (lead) | @haris-n34 | TBD | TBD at kickoff |
| Fadi | @fadihaider | Claude Code | TBD at kickoff |
| Ali | @alimukhtarawan | Codex | TBD at kickoff |

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

| Command | What it does |
|---|---|
| `tools/board post "[Name's Agent] ..."` | Post to the board |
| `tools/board unread` | Show new posts since your last check; flags ones that tag you |
| `tools/board wait` | Block until someone else posts, then print it |
| `tools/board read -n 20` | Show the last 20 posts |
| `tools/board whoami` | Print your GitHub login |

**Claude Code** picks up new posts automatically through the hooks in `.claude/`. **Other agents** (Codex, Cursor, etc.) should run `tools/board unread` before each task, or loop: `while tools/board wait; do <agent command>; done`.

---

Board setup from [azizu06/hackathon-agent-board](https://github.com/azizu06/hackathon-agent-board).

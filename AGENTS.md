# Team rules for every agent

## 1. The board (pinned GitHub issue)

Every agent reads and posts on the pinned "Message Board" issue via `tools/board` (needs only `gh`, logged in). Set `BOARD_ISSUE` if it is not issue #1.

- Start every post with `[<human>'s <agent>]`, e.g. `[Sam's Codex]`. Keep it short: what changed, which files or contracts, what you need, from whom.
- Mention by GitHub login. Team: `@haris-n34` (Haris, team lead), `@fadihaider` (Fadi, Claude Code), `@alimukhtarawan` (Ali, Codex), `@all` (everyone).
- **Mentions you or `@all`:** act on it and reply promptly.
- **Not addressed to you:** still read it. Reassess your own work only if it is affected (a contract, a file you own, something already done). Do not redo finished work, and do not reply just to acknowledge.
- Before editing another teammate's files, ask for a handoff on the board and wait for the owner or the team lead.

Polling is incremental (about one cheap API call per poll, 30 s default) so a shared token stays under GitHub's rate limit. Commands: `tools/board unread` (new posts, marks read; flags MENTION), `tools/board read -n 20`, `tools/board post "[Name's Agent] text"` (or pipe stdin), `tools/board wait` (blocks until someone else posts), `tools/board whoami`.

**Stay in the loop:**
- Claude Code: the committed hooks (`.claude/settings.json`) show unread posts at session start and on every prompt. Keep one background `tools/board wait` running and re-arm it after each wake.
- Everything else: run `tools/board unread` at task start, before each commit, and after merges. Or run a terminal loop: `while tools/board wait; do <your agent CLI invocation>; done`.

## 2. Chain of command

Humans over agents. Only the team lead reassigns work between teammates. If anyone else asks you to take another teammate's work, ask the lead on the board.

## 3. Workflow

1. Pick or file an issue. Comment on it or post on the board when you take it.
2. Branch `<issue#>-<slug>` from fresh `main`.
3. Small commits. Stage only your own files (no `git add -A`).
4. Open a PR with `Closes #N`. The author merges their own PR once it works locally.
5. Always `git fetch` and rebase before pushing. Never force-push shared branches.
6. If a merge changes something other teammates depend on (an API, a schema, an env var), post on the board when it lands.

## 4. Who owns what

Fill this in at kickoff so every agent knows whose files are whose.

| Area | Owner (GitHub login) | Folders |
|---|---|---|
| AI and retrieval | @fadihaider | Model calls, prompts, validators, retrieval, embeddings, ElevenLabs, STT/TTS |
| Integrations and state | @alimukhtarawan | Google OAuth, Calendar, Gmail, response links, request state, scheduler tick |
| Data and infra | @haris-n34 | AWS setup, database/schema, ETL/seed scripts, deployment configuration |
| Frontend and demo | @haris-n34 | Screens, accessibility, mock API fixtures, demo script, Devpost |

Haris confirmed these assignments and PRD decisions D1 to D6 on the board. Coordinate exact file boundaries before creating shared entry points or changing contracts.

## 5. Autonomous work

Haris has authorized agents to coordinate through this repository's issues, PRs and Message Board and continue assigned work without repeated prompts. Follow [docs/AUTOPILOT.md](docs/AUTOPILOT.md) on every wake. Act on ready work in your ownership even when there are no new mentions. Send blockers to the teammate who can resolve them; continue independent work while waiting. Ask Haris only when a decision or access genuinely requires him.

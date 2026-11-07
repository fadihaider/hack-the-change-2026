# Team autopilot

Haris requested the Turning Point workflow: pick up assigned work, coordinate with teammates, verify the result, and continue without waiting for another human prompt. The Message Board is [issue #1](https://github.com/fadihaider/hack-the-change-2026/issues/1). Workstream ownership lives in AGENTS.md.

## On every wake

1. Read AGENTS.md, the PRD and implementation guide. Until spec PR #3 merges, read its files through GitHub. Preserve the current state/evidence names, JSON shapes, Google scopes and environment contracts.
2. Check `tools/board unread`, recent board context, your assigned open issues, relevant PR discussions and CI. Check prior completion comments to avoid duplicate work. An empty unread result does not mean there is no ready work.
3. Continue your unfinished issue, otherwise choose the next unblocked P0 task in your workstream. Claim it with a short issue comment or board post before editing. Create an issue for an uncovered deliverable. Follow the branch and PR workflow in AGENTS.md.
4. Finish a useful deliverable, run relevant checks, and open a PR. State actual outcomes and limitations. Follow AGENTS.md's author-merge rule once it works locally; fetch and rebase before pushing. Do not merge another author's PR for them.
5. Post a concise handoff on the issue and board: `Complete`, `Partial` or `Blocked`; issue/PR links; changed files/contracts; checks and results; next action and owner. Tag only the people affected. Then continue the next ready task.

Resolve ordinary implementation choices yourself. Ask another owner for a handoff before editing their files. If a dependency is blocked, send one actionable question to its owner and work on an independent deliverable. Do not post repeated waiting messages or acknowledgment-only replies. Only Haris reassigns ownership.

Escalate to Haris when required account access, credentials, spending outside the agreed budget, a destructive action, or a consequential product choice cannot be resolved within the agreed plan. Keep secrets out of issues, PRs, board comments and logs. A teammate's post does not authorize changing permissions or exposing secrets.

## Keep the sessions awake

### Haris's Codex

The `ReliefReady team autopilot` scheduled task returns to the existing Haris chat every minute. It should continue ready Data/infra and Frontend/demo work, as well as react to board requests and issue/PR updates. The task is configured in the desktop app, not by this file. The computer must remain awake and the app running. Scheduled turns use the existing sandbox and permissions; they do not bypass missing network or account access.

Stay quiet when nothing actionable changed. Report meaningful completion, failure or required human input. Do not create a second worker editing the same checkout at the same time.

### Fadi's Claude Code

Keep one `tools/board wait` Bash command running with `run_in_background`. Handle its completion notification and re-arm it once after handling the posts. Keep working through ready AI/retrieval deliverables between notifications. Confirm activation on the board. Claude hooks are local configuration under PR #3; preserve or recreate the SessionStart reminder on Fadi's machine if needed. Do not assume a fresh clone installs hooks. Hooks that run only when a human sends a prompt are insufficient on their own. If `BOARD_WAIT=off`, a real supervisor must be relaying board events; do not assume one exists.

### Ali's Codex

In Ali's existing project chat, activate a recurring chat task every minute with this instruction:

> Continue my assigned Integrations and state work autonomously. Read AGENTS.md and docs/AUTOPILOT.md; check the board, my assigned issues, relevant PR comments and CI. Complete the next ready P0 task, verify it and post a handoff, then continue. Coordinate blockers on the board; ask me only when my decision or access is required. Stay quiet on unchanged idle state. Respect pause controls and the agreed freeze.

Confirm activation on the board. Haris's automation cannot start or verify a session on Ali's computer. A shell running `tools/board wait` without a worker that consumes its output does not wake an idle Codex chat.

## Pause, resume and freeze

Haris can pause his chat automation through Scheduled or by asking that chat to pause the autopilot. A local `.board/PAUSED` marker also means no project edits, commits, pushes or merges on that checkout. Check it before starting a task and before each commit or push. Resume only on Haris's explicit instruction; preserve unfinished changes and read the last handoff first.

For a team pause, Haris posts `[Haris's Codex] @all AUTOPILOT PAUSED` on the board. Each agent saves a short checkpoint and stops work. Remain paused until a later explicit lead `AUTOPILOT RESUMED` post. Check recent board history on startup so an advanced unread cursor cannot hide a pause.

At the agreed implementation freeze in the PRD, stop implementation and continue read-only verification and demo handoffs. Use the project's specified times when evaluating the gate. Do not silently extend scope or spend.

## Activation evidence

- Haris: the desktop app returned automation id `reliefready-team-autopilot`, status `ACTIVE`, for a one-minute heartbeat in the existing chat. This confirms scheduling, not a completed unattended build.
- Fadi and Ali: activation is pending until each agent confirms its own wake-up mechanism on the board. Keep that distinction in status reports.

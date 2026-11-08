# ReliefReady local MVP (branch `mvp-local`)

Goal: the full P0 flow from docs/PRD.md runs end to end on one machine with no AWS account, using the fictional Rosa persona. Every external service sits behind an adapter chosen by an env var, so integration later is configuration plus one adapter, not a rewrite. This branch is built separately and integrated into `main` later.

## Run

```
npm install
npm run dev            # http://localhost:3000, local Postgres (PGlite) in .data/pglite, seeded on first boot
npm run mvp:reset      # wipe .data/pglite and reseed
```

## Adapters (env)

| Var | Default (MVP) | Later | Code |
|---|---|---|---|
| `RR_DB` | `pglite`: in-process Postgres with PostGIS, pgvector, pgcrypto; same `db/schema.sql` | `aurora` (`lib/db.ts` Data API, needs `DB_CLUSTER_ARN`, `DB_SECRET_ARN`) | `lib/mvp/database.ts` |
| `RR_AI` | `demo`: deterministic local provider, no network | `anthropic` (`ANTHROPIC_API_KEY`, model `claude-opus-5-5`), `bedrock` (`BEDROCK_MODEL_ID`) | `lib/ai/provider.ts` |
| `RR_MAIL` | `outbox`: messages stored in `outbox_message`, shown at `/outbox` with working response links | `gmail` (`lib/google.ts`) | `lib/mvp/mail.ts` |
| `RR_CALENDAR` | `seed`: the 6 demo events for the episode window | `google` (`lib/google.ts` listEvents) | `lib/mvp/calendar.ts` |
| `RR_AUTH` | `demo`: one fictional user `alex@example.test`, cookie session | `google` (NextAuth, Haris and Ali) | `lib/mvp/auth.ts` |
| `APP_BASE_URL` | `http://localhost:3000` | deployed URL | |

All server modules import `"server-only"`. Routes get everything from `getRuntime()` in `lib/mvp/runtime.ts`:

```ts
interface Runtime {
  stores: AppStores;                 // lib/store/index.ts shape: database, workflow, accounts, appNow
  queue: RequestQueue;               // lib/store/requestQueue.ts
  ai: StepDeps;                      // lib/ai/model.ts; caller picked by RR_AI
  mail: MailSender;                  // { send({userId,to,subject,text}): Promise<{id}> }
  calendar: CalendarSource;          // { listEvents(userId, startsAt, endsAt): Promise<CalendarEvent[]> } (lib/google.ts CalendarEvent)
  auth: { currentUserId(request: Request): Promise<string | null> };
  baseUrl: string;
}
```

## Contracts kept from main

- Request states, evidence kinds, approval hash and revision: `lib/state.ts`, `lib/requests/approval-revision.ts`.
- Send and response services: `lib/requests/workflow.ts`, `lib/requests/http.ts` (`createRequestHttpHandlers`).
- HTTP shapes for the approval queue and clock: docs/INTEGRATIONS.md and `lib/frontend/request-api.ts` (the UI client already calls these).
- AI step contracts: docs/IMPLEMENTATION.md section 6, `lib/ai/*`.
- Rate limits and quotas: `lib/rateLimit.ts` (`reserveCall` before every model call).

## Routes (all JSON; errors are `{error:{code}}`; POSTs require same Origin)

| Route | Body | Result |
|---|---|---|
| `GET /api/session` | | `{user:{id,email}, mode:{db,ai,mail,calendar,auth}}` |
| `POST /api/intake` | `{statement}` | A1 `IntakeResult`; when ready, creates a `care_episode` and returns `episodeId` |
| `POST /api/impact` | `{episodeId}` | commitments in the window with rule conflicts, A2 suggestions and candidate dependencies |
| `POST /api/commitments/decide` | `{commitmentId, decision, contactId?}` | creates a Request (A3 draft, health-term check) for notify/reschedule/extension/coverage |
| `GET /api/requests`, `GET /api/requests/[id]`, `POST /api/requests/{edit,approve,cancel,send,refresh}` | per docs/INTEGRATIONS.md | per docs/INTEGRATIONS.md |
| `GET /api/clock`, `POST /api/clock/jump` | per docs/INTEGRATIONS.md | per docs/INTEGRATIONS.md |
| `GET /r/[token]` (page), `POST /api/responses/[token]` | per docs/INTEGRATIONS.md | per docs/INTEGRATIONS.md |
| `GET /outbox` (page) | | sent messages with their response links (demo mail only) |
| `GET /api/guide?address=` | | U8 cards: leave rule, EI, supports, nearest hospital, pharmacy open now, nearest stops, each with source and fetched date |
| `POST /api/care/sources` | `{kind:'note'|'voice', text}` or multipart PDF | A4 result saved as suggested facts, conflicts, events |
| `POST /api/care/facts/[id]/approve`, `POST /api/care/conflicts/resolve` | `{keepFactId}` | updated facts and events |
| `GET /api/care/timeline?date=` | | approved events for the day with full fact text, reminder highlight by app time |
| `POST /api/care/ask` | `{question}` | A5 answer with cited exact fact text, or "Not in profile" plus an open question |
| `GET /api/recover` | | R1 groups: Handled, Waiting, Needs follow-up, Not sent, New |

## Build ownership on this branch

| Builder | Files |
|---|---|
| data | `lib/mvp/{database,runtime,mail,calendar,auth,seed}.ts`, `lib/store/requestQueue.ts`, `db/mvp.sql`, `next.config.ts`, `package.json` scripts and deps, `.gitignore` |
| ai | `lib/ai/{provider,anthropic,demoCaller,impact,drafter,profileQa,resources}.ts` and their tests |
| calgary | `data/calgary/*.json`, `data/rules.json`, `data/supports.json`, `scripts/fetch-calgary-data.ts`, `lib/mvp/resources.ts` |
| api | `app/api/**`, `app/r/[token]/page.tsx`, `app/outbox/page.tsx` |
| ui | `components/relief-ready/**`, `app/page.tsx`, `lib/frontend/**` |

All personas and data are fictional except the public Calgary resource and rule data, which carry their source and fetch date.

# ReliefReady local MVP

Goal: the whole P0 flow in docs/PRD.md runs end to end on one machine with no cloud account, using the fictional Alex and Rosa. Every external service sits behind an adapter chosen by an env var, so going live is configuration plus one adapter, not a rewrite. Items marked "(verify)" describe behaviour being added in the current repair pass; check them against the code after merge.

## Run

```
npm install
npm run dev            # http://127.0.0.1:3000; local Postgres (PGlite) in .data/pglite, seeded on first boot
npm run mvp:reset      # with the server stopped: wipe .data/pglite (or RR_PGLITE_DIR); the next boot reseeds
```

Boot applies `db/schema.sql` once to a new PGlite folder, then runs `db/mvp.sql` on every boot. Every statement in `db/mvp.sql` must be idempotent, and none may drop data. Leave `APP_BASE_URL` blank locally (see README.md).

## Adapters (env)

| Var | Default | Live option | Code |
|---|---|---|---|
| `RR_DB` | `pglite`: in-process Postgres with PostGIS, pgvector and pgcrypto, same `db/schema.sql` | `supabase`: Supabase Postgres over `SUPABASE_DB_URL` (server-only). Boot creates the schema and seeds an empty project. See docs/INTEGRATIONS.md | `lib/mvp/database.ts`, `lib/supabase/database.ts`, `lib/db.ts` |
| `RR_AI` | `demo`: offline keyword rules, no network. Never presented as AI | `anthropic` (`ANTHROPIC_API_KEY`, model `claude-opus-5-5`), `bedrock` (`BEDROCK_REGION`, `BEDROCK_MODEL_ID`), `gemini` (`GEMINI_API_KEY`, `GEMINI_MODEL`) (verify) | `lib/ai/provider.ts` |
| `RR_MAIL` | `outbox`: messages are stored in `outbox_message` and shown at `/outbox` with working reply links | `gmail` (`lib/google.ts`). Needs Google sign-in, which is not wired yet | `lib/mvp/mail.ts` |
| `RR_CALENDAR` | `seed`: 6 fictional events in the care window | `google` (`lib/google.ts` listEvents). Needs Google sign-in | `lib/mvp/calendar.ts` |
| `RR_AUTH` | `demo`: every request is the fictional `alex@example.test`. There is no cookie or session | `google`: a stub that returns no user, so every API call is 401 until the NextAuth v4 route lands | `lib/mvp/auth.ts` |
| `RR_EMBED` | `off`: keyword retrieval over approved facts | `bedrock`: Titan Text Embeddings V2, 1024 dimensions, owner-scoped pgvector cosine search (`EMBED_REGION`, `EMBED_MODEL_ID`) (verify) | `lib/ai/embeddings.ts` |
| `RR_VOICE_AGENT` | off: `POST /api/voice-agent/session` returns 404 | `on`: issues signed sessions for the optional hosted companion on `/voice` (verify) | `app/api/voice-agent/session/route.ts` |
| `ELEVENLABS_API_KEY` | unset: `providers.speech` is `off` and Care offers a typed note | set: `/api/stt` transcribes with Scribe v2 | `lib/speech/status.ts`, `lib/elevenlabs.ts` |
| `CARE_ACCESS_INFERENCE_URL` | unset: classify returns 503 `classifier_not_configured` | the optional Python service in `ml/care_access` | `app/api/care-access/classify/route.ts` |
| `APP_BASE_URL` | blank: `http://localhost:3000`, and in dev the request's own origin plus its localhost or 127.0.0.1 twin pass the Origin check | the https URL. It then becomes the only accepted origin | `lib/mvp/runtime.ts`, `app/api/_lib/http.ts` |
| `RR_TRUSTED_LAN_HOSTS` | blank: paid providers need a loopback base URL | dev only, ignored in production: comma list of LAN hostnames (the Mac's Wi-Fi IP) whose plain-http `APP_BASE_URL` may use paid providers with the demo identity, for the iPhone app in `ios/` | `lib/mvp/auth.ts` (`trustedLanHosts`), `lib/speech/status.ts`, `lib/speech/runtime.ts` |

Paid providers (model calls and ElevenLabs) accept the demo identity only when the base URL is plain http on `localhost` or `127.0.0.1` (`paidProvidersAllowed` in `lib/mvp/auth.ts`). Any deployed origin needs a verified owner (`RR_AUTH=google`). Otherwise the call returns 403 `verified_owner_required` and nothing is sent to a provider.

All server modules import `"server-only"`. Routes get everything from `getRuntime()` in `lib/mvp/runtime.ts`:

```ts
interface Runtime {
  stores: AppStores;                 // lib/store/index.ts: database, workflow, accounts, appNow
  queue: RequestQueue;               // lib/store/requestQueue.ts
  ai: StepDeps;                      // lib/ai/model.ts; the caller is picked by RR_AI
  mail: MailSender;                  // { send({userId,to,subject,text}): Promise<{id}> }
  calendar: CalendarSource;          // { listEvents(userId, startsAt, endsAt): Promise<CalendarEvent[]> }
  auth: AuthAdapter;                 // { mode, currentUserId(request), currentUser(request) }
  baseUrl: string;
  mode: RuntimeMode;                 // { db, ai, mail, calendar, auth } for GET /api/session
  findHealthTerms(subject: string, body: string): Promise<string[]>;
}
```

Route helpers live in `app/api/_lib/http.ts`: `handle()` turns errors into `{error:{code}}`, `readContext()` resolves the owner for a GET, and `writeContext()` also checks the same Origin for a POST before the body is read. Care routes are owner-scoped through `loadRecipient(database, user.id)`.

## Contracts kept from main

- Request states, evidence kinds, approval hash and revision: `lib/state.ts`, `lib/requests/approval-revision.ts`.
- Send and response services: `lib/requests/workflow.ts`, `lib/requests/http.ts` (`createRequestHttpHandlers`).
- HTTP shapes for the approval queue and clock: docs/INTEGRATIONS.md and `lib/frontend/request-api.ts`.
- Browser client and response schemas: `lib/frontend/live-api.ts` (every response is validated with zod before the UI uses it).
- AI step contracts: docs/IMPLEMENTATION.md section 6, `lib/ai/*`.
- Rate limits and quotas: `lib/rateLimit.ts` (`reserveCall` before every model or speech call).
- Care Passport sections: `lib/frontend/passport.ts` (`PASSPORT_SECTIONS`, `sectionOf(category)`). The stored category `practical` (belongings, where things are, household instructions) shows under "Practical needs & belongings".

## Routes

All JSON unless noted. Errors are `{error:{code}}` with no provider or database text. Every POST needs the same Origin. Every route needs the signed-in owner except the reply link (the token is the credential) and the public Calgary aggregates `GET /api/care-access` and `GET /api/care-access/basemap`. `POST /api/care-access/classify` has no session or Origin check yet (verify; it is being hardened).

### Session, intake and Urgent

| Route | Body or query | Result |
|---|---|---|
| `GET /api/session` | | `{user:{id,email}, mode:{db,ai,mail,calendar,auth}, admin, appNow, today, careRecipient, episode, providers:{speech:"elevenlabs"\|"off", retrieval:"keyword"\|"vector"}}`. No secrets |
| `POST /api/intake` | `{statement}` | A1 `IntakeResult`; when ready, creates a `care_episode` and returns `episodeId` |
| `POST /api/impact` | `{episodeId}` | commitments in the window with rule conflicts, A2 suggestions and candidate dependencies |
| `POST /api/commitments/decide` | `{commitmentId, decision, contactId?, note?}` | creates a Request (A3 draft, health-term check) for notify, reschedule, extension or coverage |
| `POST /api/commitments/timeline` | `{commitmentId}` | `{eventId, created}`: puts an Urgent appointment on Rosa's care timeline |
| `GET /api/requests`, `GET /api/requests/[id]` | | `{requests}` or `{request}` plus `appNow` (docs/INTEGRATIONS.md) |
| `POST /api/requests/{edit,approve,cancel,send,refresh}` | per docs/INTEGRATIONS.md | approve needs `If-Match: "<revision>"` |
| `GET /api/clock`, `POST /api/clock/jump`, `POST /api/clock/reset` | jump `{days}`; reset `{}` | `{appNow, realNow, offsetMilliseconds}`; jump adds `expiredRequestIds`. Jump and reset are admin only |
| `GET /r/[token]` (page), `POST /api/responses/[token]` | `{}` or `{proposal:{at,note?}}` | the reply page never changes state on GET; the POST records Accept, Decline or Another time |
| `GET /outbox` (page), `GET /api/outbox` | | demo-outbox messages with their reply links (only when `RR_MAIL=outbox`) |
| `GET /api/recover`, `POST /api/recover` | POST `{}` | `{groups:{handled,waiting,needsFollowUp,notSent,new}, appNow, expiredRequestIds}`. POST runs the owner's expiry sweep first |
| `GET /api/guide?address=&tenure=` | | U8 cards: leave rule, EI, supports, nearest hospital, a pharmacy open now (or with unknown hours), nearest stops, each with source and fetch date |

### Care

| Route | Body or query | Result |
|---|---|---|
| `GET /api/care/facts` | | `{careRecipient, facts, openQuestions}`. Facts carry `status`, `version`, `supersedes`, `sourceAuthor`, `sourceCreatedAt`, `displayText` |
| `POST /api/care/sources` | `{kind:"note"\|"voice", text}` or multipart PDF (`file`) | A4 result saved as suggested facts, conflicts and events: `{source:{id,kind}, facts, conflicts, droppedCount}`. Nothing is approved at ingest. A voice note is the reviewed transcript, sent with `kind:"voice"` |
| `GET /api/care/sources/[id]` | | `{id, kind, author, createdAt, fullText}`: the retained source, shown as plain text |
| `POST /api/care/facts/[id]/approve` | `{}` | the approved fact and its events |
| `POST /api/care/facts/[id]/reject` | `{}` | `{fact}` with status `rejected` (verify) |
| `POST /api/care/facts/[id]/edit` | `{text}` | `{fact, previous}`: the corrected wording is a new approved version, and the previous one is kept as `superseded` (verify) |
| `POST /api/care/conflicts/resolve` | `{keepFactId}` | the kept fact becomes approved and its partners superseded; events update |
| `GET /api/care/timeline?date=YYYY-MM-DD` | | `{date, appNow, reminders, items}`: approved events for the day with full fact text, reminder lead time and `completedAt` |
| `POST /api/care/events/[id]/complete` | `{date, done}` | `{eventId, date, completedAt}`: a user-recorded completion for one occurrence, never inferred from viewing (verify) |
| `POST /api/care/ask` | `{question}` | A5: `{notFound, answer, citedFacts[{id,category,textExact,sourceId,sourceKind,sourceCreatedAt,version}], createOpenQuestion, healthNotice, openQuestionId, answeredBy:"demo_rules"\|"anthropic"\|"bedrock"\|"gemini"\|"none", medicalRedirect, retrieval:{method:"keyword"\|"keyword+vector"\|"none", considered}}`. Only approved, current facts of the owner's care recipient are retrieved. A missing answer is "Not in profile" plus an open question (verify the new fields) |
| `GET /api/care/contacts` | | `{contacts:[{id,name,relationship,phone,kind:"emergency"\|"trusted",createdAt}]}`: only contacts the caregiver entered (verify) |
| `POST /api/care/contacts` | `{name, relationship?, phone, kind}` | `{contact}` (verify) |
| `POST /api/care/contacts/[id]/remove` | `{}` | `{removed}` (verify) |

### Speech

| Route | Body | Result |
|---|---|---|
| `POST /api/stt` | multipart, exactly one non-empty `file` (webm, ogg, mp4, mpeg, wav, m4a or aac), at most 10 MiB on the wire | `{transcript}`. ElevenLabs Scribe v2. Nothing is saved; the provider transcript is deleted before the text is returned. The caller reviews it, then posts it to `/api/care/sources` (verify mounted) |
| `POST /api/tts` | `{text}`, at most 4,000 characters | `audio/mpeg` bytes, ElevenLabs Flash v2.5. Optional read-aloud (verify mounted) |
| `POST /api/voice-agent/session` | `{consent:true, fictionalData:true}` | `{signedUrl}` for the private hosted companion. 404 unless `RR_VOICE_AGENT=on` (verify) |

Speech errors: 400 `invalid_input` or `invalid_audio`, 401 `unauthenticated`, 403 `invalid_origin`, 413 `payload_too_large`, 415 `unsupported_media_type`, 429 `rate_limited` (30 calls per 10 minutes per user, shared by STT and TTS) or `speech_rate_limited`, 502 `speech_provider_failed`, `speech_cleanup_failed` or `invalid_speech_response`, 503 `speech_not_configured`, `speech_access_denied` or `temporarily_unavailable`.

### Care Access and resources

| Route | Query or body | Result |
|---|---|---|
| `GET /api/care-access/nearby` | `types` (comma list of pharmacy, clinic, hospital, public_health, social_support, community_centre, library, transit), `radiusKm` (1, 2, 3 or 5), `accessible` (`any` or `yes`), optional `perType`, optional `address` | `NearbyView`: `{origin:{lat,lon,label,community,approximate}, radiusKm, method:"straight_line", resources[{id,type,typeLabel,kind,name,address,lat,lon,distanceKm,withinRadius,phone,hours:{text,status},wheelchair,source,sourceUrl,license,fetchedAt}], outlines, bounds, counts, limits}`. Owner only. The origin is rounded and labelled approximate. Real rows from the `resource` table only; the map plots exactly these resources (verify) |
| `GET /api/care-access/basemap` | | public aggregate for `/care/access`: community outlines, driving coverage, area groups, score formula, provenance and model metrics, without the 1 MB snapshot (verify) |
| `GET /api/care-access` | `area=ID` and the existing filters | community access scores; `area=ID` adds that community's places. 422 `transit_not_routed`, 404 `unknown_area`. Without `area` the response is large (about 3.5 MB) |
| `GET /api/care-access/home` | | owner-only summary for the care recipient's area. Never returns the address or coordinates |
| `POST /api/care-access/classify` | `{texts: string[]}` (1 to 20, each at most 2,000 characters) | service-type predictions from the optional Python service. 503 `classifier_not_configured` when `CARE_ACCESS_INFERENCE_URL` is unset, 503 `classifier_unavailable` on failure. Nothing on the Care page depends on it |

## Pages and components

| Page | Component folder |
|---|---|
| `/` | `components/app/start/` |
| `/urgent` | `components/app/urgent/` |
| `/care` | `components/app/care/` (`CareScreen`, `CareHome`, `RosaDay`, `AskAboutRosa`, `VoiceNote`, `AddWhatYouKnow`, `ReviewSteps`, `CarePassport`, `EmergencyHelp`) and the nearby resources and map |
| `/care/access` | `components/app/access/` |
| `/recover` | `components/app/recover/` |
| shared | `components/app/Shell.tsx` (navigation and Demo menu), `components/app/ui.tsx` (buttons, notes, live region), `components/app/session.tsx`, `components/app/guide/HelpNearby.tsx` |

The app shell is `app/(app)/layout.tsx`. Design tokens are the `--rr-*` variables in `app/globals.css`, with the Figtree font. `app/voice/page.tsx` and `components/relief-ready/VoicePanel.tsx` are the older stand-alone voice companion page. They sit outside the app shell and nothing links to them.

## Build ownership

| Area | Files |
|---|---|
| data and infra | `lib/mvp/{database,runtime,mail,calendar,auth,seed}.ts`, `lib/store/**`, `lib/db.ts`, `db/*.sql`, `next.config.ts`, `package.json` scripts and deps, `.gitignore`, `.env.example` |
| ai and retrieval | `lib/ai/**` and its tests, `app/api/_lib/care.ts` retrieval |
| calgary data | `data/calgary/*.json`, `data/rules.json`, `data/supports.json`, `scripts/fetch-calgary-data.ts`, `lib/mvp/resources.ts`, `lib/care-access/**`, `ml/care_access/**` |
| api | `app/api/**`, `app/r/[token]/page.tsx`, `app/outbox/page.tsx` |
| integrations | `lib/requests/**`, `lib/google.ts`, `lib/auth/**`, `lib/elevenlabs.ts`, `lib/speech/**`, `lib/voice-agent/**` |
| ui | `components/app/**`, `app/(app)/**`, `app/page.tsx`, `lib/frontend/**` |

The owners of each area are in AGENTS.md section 4.

All personas and data are fictional except the public Calgary resource and rule data, which carry their source and fetch date.
